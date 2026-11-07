// Bookmarks: named positions inside a song (handy for long mixes and DJ sets)
// or a podcast episode. Per user.
import express from 'express';
import { q } from './db.js';

const int = (v) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : null; };
const COLS = `b.id, b.track_id AS trackId, b.episode_id AS episodeId, b.position, b.label, b.created_at AS createdAt`;

export const bookmarksApi = express.Router();

// ?track=ID or ?episode=ID for one item; nothing for the most recent ones (with titles).
bookmarksApi.get('/', (req, res) => {
  const track = int(req.query.track), episode = int(req.query.episode);
  if (track || episode) {
    return res.json(q(`SELECT ${COLS} FROM bookmarks b WHERE b.user_id = ? AND ${track ? 'b.track_id' : 'b.episode_id'} = ? ORDER BY b.position`)
      .all(req.user.id, track || episode));
  }
  res.json(q(`SELECT ${COLS}, COALESCE(t.title, e.title) AS title, COALESCE(t.artist, p.title) AS artist, COALESCE(t.cover, p.image) AS cover
    FROM bookmarks b LEFT JOIN tracks t ON t.id = b.track_id LEFT JOIN podcast_episodes e ON e.id = b.episode_id LEFT JOIN podcasts p ON p.id = e.podcast_id
    WHERE b.user_id = ? ORDER BY b.created_at DESC LIMIT 200`).all(req.user.id));
});

bookmarksApi.post('/', (req, res) => {
  const b = req.body || {};
  const trackId = int(b.trackId), episodeId = int(b.episodeId);
  if (!trackId === !episodeId) return res.status(400).json({ error: 'Bookmark a song or an episode' });
  if (trackId && !q('SELECT 1 FROM tracks WHERE id = ?').get(trackId)) return res.status(404).json({ error: 'Track not found' });
  if (episodeId && !q('SELECT 1 FROM podcast_episodes WHERE id = ?').get(episodeId)) return res.status(404).json({ error: 'Episode not found' });
  const position = Math.max(0, Number(b.position) || 0);
  const { lastInsertRowid } = q('INSERT INTO bookmarks (user_id, track_id, episode_id, position, label, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.user.id, trackId, episodeId, position, String(b.label || '').trim().slice(0, 120), Date.now());
  res.json(q(`SELECT ${COLS} FROM bookmarks b WHERE b.id = ?`).get(Number(lastInsertRowid)));
});

bookmarksApi.put('/:id', (req, res) => {
  const r = q('UPDATE bookmarks SET label = ? WHERE id = ? AND user_id = ?').run(String(req.body?.label || '').trim().slice(0, 120), int(req.params.id), req.user.id);
  res.status(r.changes ? 200 : 404).json(r.changes ? { ok: true } : { error: 'Bookmark not found' });
});

bookmarksApi.delete('/:id', (req, res) => {
  q('DELETE FROM bookmarks WHERE id = ? AND user_id = ?').run(int(req.params.id), req.user.id);
  res.json({ ok: true });
});
