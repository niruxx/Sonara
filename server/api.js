import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { q, tx } from './db.js';
import { COVERS_DIR, getConfig, saveConfig } from './config.js';
import { scanLibrary, scanStatus, scheduleScans, watchLibrary } from './scanner.js';
import { tools } from './tools.js';
import {
  assertFileChangesAllowed, assertInLibrary, editTracks, EDITABLE_TAGS, planMoves, applyMoves, scopeTracks,
  TEMPLATES, validateTemplate, writeTags, musicRoots,
} from './files.js';
import {
  listInbox, inboxDir, inboxPath, listJobs, queueDownload, queueConvert, cancelJob, clearFinishedJobs,
  saveUpload, importToLibrary, AUDIO_FORMATS, CONVERT_FORMATS, VIDEO_EXT,
} from './downloads.js';
import {
  createSession, destroySession, hashPassword, loginRateLimit, publicUser, requireAdmin, requireAuth,
  setSessionCookie, userCount, validateCredentials, verifyPassword, COOKIE,
} from './auth.js';

export const api = express.Router();
api.use(express.json({ limit: '1mb' }));

const int = (v, def, min = 0, max = 1000) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
const page = (req, def = 100) => ({ limit: int(req.query.limit, def, 1, 500), offset: int(req.query.offset, 0, 0, 1e9) });

// ───────────────────────── SQL fragments ─────────────────────────

const TRACK_COLS = `
  t.id, t.title, t.artist, t.artist_id AS artistId, t.album, t.album_id AS albumId,
  t.album_artist AS albumArtist, t.album_artist_id AS albumArtistId, t.track_no AS trackNo,
  t.disc_no AS discNo, t.year, t.original_year AS originalYear, t.genre, t.duration, t.bitrate,
  t.sample_rate AS sampleRate, t.codec, t.lossless, t.cover, t.added_at AS addedAt,
  t.release_type AS releaseType, t.compilation,
  t.rg_track_gain AS rgTrackGain, t.rg_track_peak AS rgTrackPeak, t.rg_album_gain AS rgAlbumGain, t.rg_album_peak AS rgAlbumPeak,
  (f.track_id IS NOT NULL) AS favorite, COALESCE(r.rating, 0) AS rating,
  COALESCE(pc.n, 0) AS playCount, pc.last AS lastPlayed,
  (SELECT json_group_array(json_array(ta.artist_id, ta.name, ta.position)) FROM track_artists ta
    WHERE ta.track_id = t.id AND ta.role = 'artist') AS artists`;
// Per-user joins every track query needs (bind $uid).
const TRACK_JOINS = `
  LEFT JOIN favorites f ON f.track_id = t.id AND f.user_id = $uid
  LEFT JOIN ratings r ON r.track_id = t.id AND r.user_id = $uid
  LEFT JOIN (SELECT track_id, COUNT(*) AS n, MAX(played_at) AS last FROM plays WHERE user_id = $uid GROUP BY track_id) pc
    ON pc.track_id = t.id`;
const TRACK_FROM = `FROM tracks t ${TRACK_JOINS}`;

const ALBUM_COLS = `
  t.album_id AS id, MAX(t.album) AS name, MAX(t.album_artist) AS artist, t.album_artist_id AS artistId,
  MAX(t.year) AS year, MIN(t.original_year) AS originalYear, MAX(t.cover) AS cover, COUNT(*) AS trackCount,
  SUM(t.duration) AS duration, MAX(t.added_at) AS addedAt, MAX(t.genre) AS genre,
  MAX(t.release_type) AS releaseType, MAX(t.compilation) AS compilation, COUNT(DISTINCT COALESCE(t.disc_no, 1)) AS discCount`;
// Album queries that sort/filter on the user's activity add these (bind $uid).
const ALBUM_USER_COLS = `, COALESCE(SUM(pc.n), 0) AS playCount, MAX(pc.last) AS lastPlayed, AVG(r.rating) AS rating`;
const ALBUM_USER_JOINS = `
  LEFT JOIN ratings r ON r.track_id = t.id AND r.user_id = $uid
  LEFT JOIN (SELECT track_id, COUNT(*) AS n, MAX(played_at) AS last FROM plays WHERE user_id = $uid GROUP BY track_id) pc
    ON pc.track_id = t.id`;

const ALBUM_SORTS = {
  name: 'name COLLATE NOCASE ASC',
  artist: 'artist COLLATE NOCASE ASC, year ASC',
  year: 'year DESC, name COLLATE NOCASE',
  oldest: 'year IS NULL, year ASC, name COLLATE NOCASE',
  recent: 'addedAt DESC',
  played: 'playCount DESC, lastPlayed DESC',
  lastPlayed: 'lastPlayed IS NULL, lastPlayed DESC',
  rating: 'rating IS NULL, rating DESC, name COLLATE NOCASE',
  random: 'RANDOM()',
};
const TRACK_SORTS = {
  title: 't.title COLLATE NOCASE ASC',
  artist: 't.artist COLLATE NOCASE, t.album COLLATE NOCASE, t.disc_no, t.track_no',
  album: 't.album COLLATE NOCASE, t.disc_no, t.track_no',
  recent: 't.added_at DESC, t.album_id, t.disc_no, t.track_no',
  year: 't.year DESC, t.album_id, t.disc_no, t.track_no',
  duration: 't.duration DESC',
  played: 'playCount DESC, lastPlayed DESC',
  lastPlayed: 'lastPlayed IS NULL, lastPlayed DESC',
  rating: 'rating DESC, t.title COLLATE NOCASE',
};
const RELEASE_TYPES = new Set(['album', 'ep', 'single', 'compilation', 'live', 'soundtrack', 'remix', 'other']);

/** Shared WHERE clauses for ?genre, ?yearFrom, ?yearTo, ?type (and, for tracks, ?minRating, ?favorites). */
function libraryFilters(query, { trackLevel = false } = {}) {
  const where = [];
  const params = {};
  if (query.genre) {
    where.push('t.id IN (SELECT track_id FROM track_genres WHERE genre = $genre)');
    params.genre = String(query.genre);
  }
  const from = int(query.yearFrom, null, 0, 9999);
  const to = int(query.yearTo, null, 0, 9999);
  if (from != null) { where.push('t.year >= $yearFrom'); params.yearFrom = from; }
  if (to != null) { where.push('t.year <= $yearTo'); params.yearTo = to; }
  if (query.type && RELEASE_TYPES.has(query.type)) {
    if (query.type === 'compilation') where.push(`(t.compilation = 1 OR t.release_type = 'compilation')`);
    else if (query.type === 'album') where.push(`(t.release_type IS NULL OR t.release_type = 'album') AND t.compilation = 0`);
    else { where.push('t.release_type = $type'); params.type = query.type; }
  }
  if (trackLevel) {
    const minRating = int(query.minRating, 0, 0, 5);
    if (minRating) { where.push('r.rating >= $minRating'); params.minRating = minRating; }
    if (query.favorites === '1' || query.favorites === 'true') where.push('f.track_id IS NOT NULL');
  }
  return { where: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

const fixTrack = (t) => {
  if (!t) return t;
  let artists = [];
  try {
    artists = JSON.parse(t.artists || '[]').sort((a, b) => a[2] - b[2]).map(([id, name]) => ({ id, name }));
  } catch { /* ignore */ }
  if (!artists.length) artists = [{ id: t.artistId, name: t.artist }];
  return { ...t, artists, favorite: !!t.favorite, lossless: !!t.lossless, compilation: !!t.compilation };
};
const tracks = (rows) => rows.map(fixTrack);
const idParam = (v) => int(v, 0, 0, Number.MAX_SAFE_INTEGER);

// ───────────────────────── Auth ─────────────────────────

api.get('/auth/status', (req, res) => {
  res.json({ setupRequired: userCount() === 0, user: publicUser(req.user) });
});

api.post('/auth/setup', loginRateLimit, (req, res) => {
  if (userCount() > 0) return res.status(409).json({ error: 'Setup already completed' });
  const { username, password } = req.body || {};
  const problem = validateCredentials(username, password);
  if (problem) return res.status(400).json({ error: problem });
  const { lastInsertRowid } = q('INSERT INTO users (username, password_hash, is_admin, created_at) VALUES (?, ?, 1, ?)')
    .run(username, hashPassword(password), Date.now());
  setSessionCookie(req, res, createSession(Number(lastInsertRowid)));
  res.json({ user: publicUser(q('SELECT * FROM users WHERE id = ?').get(lastInsertRowid)) });
});

api.post('/auth/login', loginRateLimit, (req, res) => {
  const { username, password } = req.body || {};
  const user = typeof username === 'string' && q('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || typeof password !== 'string' || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Incorrect username or password' });
  }
  setSessionCookie(req, res, createSession(user.id));
  res.json({ user: publicUser(user) });
});

api.post('/auth/logout', (req, res) => {
  if (req.sessionToken) destroySession(req.sessionToken);
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

// Everything below requires a signed-in user.
api.use(requireAuth);

api.put('/me/password', (req, res) => {
  const { current, password } = req.body || {};
  if (!verifyPassword(String(current || ''), req.user.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  const problem = validateCredentials(req.user.username, password);
  if (problem) return res.status(400).json({ error: problem });
  q('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), req.user.id);
  q('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, req.sessionToken);
  res.json({ ok: true });
});

// Playback state (queue, position, volume...) so listening can resume on another device.
api.get('/me/player', (req, res) => {
  const row = q('SELECT state, updated_at FROM player_state WHERE user_id = ?').get(req.user.id);
  if (!row) return res.json({ state: null, updatedAt: 0 });
  let state = null;
  try { state = JSON.parse(row.state); } catch { /* ignore */ }
  res.json({ state, updatedAt: row.updated_at });
});

api.put('/me/player', express.json({ limit: '512kb' }), (req, res) => {
  const b = req.body || {};
  const ids = Array.isArray(b.queue) ? b.queue.map(idParam).filter(Boolean).slice(0, 5000) : [];
  const state = {
    queue: ids,
    original: Array.isArray(b.original) ? b.original.map((n) => int(n, -1, -1, 5000)).slice(0, 5000) : [],
    index: int(b.index, 0, 0, 5000),
    time: Math.max(0, Number(b.time) || 0),
    shuffle: !!b.shuffle,
    repeat: ['off', 'all', 'one'].includes(b.repeat) ? b.repeat : 'off',
    volume: Math.min(1, Math.max(0, Number(b.volume ?? 0.8))),
    muted: !!b.muted,
    rate: Math.min(4, Math.max(0.25, Number(b.rate) || 1)),
    device: String(b.device || '').slice(0, 80),
  };
  const now = Date.now();
  q(`INSERT INTO player_state (user_id, state, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`).run(req.user.id, JSON.stringify(state), now);
  res.json({ ok: true, updatedAt: now });
});

// ───────────────────────── Library ─────────────────────────

api.get('/stats', (req, res) => {
  const s = q(`SELECT COUNT(*) AS tracks, COUNT(DISTINCT album_id) AS albums, COUNT(DISTINCT album_artist_id) AS artists,
    COALESCE(SUM(duration), 0) AS duration, COALESCE(SUM(size), 0) AS size FROM tracks`).get();
  s.plays = q('SELECT COUNT(*) AS n FROM plays WHERE user_id = ?').get(req.user.id).n;
  s.favorites = q('SELECT COUNT(*) AS n FROM favorites WHERE user_id = ?').get(req.user.id).n;
  res.json(s);
});

api.get('/home', (req, res) => {
  const uid = req.user.id;
  res.json({
    recentlyAdded: q(`SELECT ${ALBUM_COLS} FROM tracks t GROUP BY t.album_id ORDER BY addedAt DESC LIMIT 12`).all(),
    discover: q(`SELECT ${ALBUM_COLS} FROM tracks t WHERE t.album_id IN
      (SELECT album_id FROM tracks GROUP BY album_id ORDER BY RANDOM() LIMIT 12) GROUP BY t.album_id`).all(),
    recentlyPlayed: tracks(q(`SELECT ${TRACK_COLS} ${TRACK_FROM} WHERE pc.last IS NOT NULL
      ORDER BY pc.last DESC LIMIT 12`).all({ uid })),
    recentAlbums: q(`SELECT ${ALBUM_COLS} ${ALBUM_USER_COLS} FROM tracks t ${ALBUM_USER_JOINS}
      GROUP BY t.album_id HAVING lastPlayed IS NOT NULL ORDER BY lastPlayed DESC LIMIT 12`).all({ uid }),
    mostPlayed: tracks(q(`SELECT ${TRACK_COLS} ${TRACK_FROM} WHERE pc.n > 0
      ORDER BY pc.n DESC, pc.last DESC LIMIT 10`).all({ uid })),
    topArtists: q(`SELECT ta.artist_id AS id, MAX(ta.name) AS name,
      COALESCE((SELECT image FROM artist_images WHERE artist_id = ta.artist_id), MAX(t.cover)) AS cover, COUNT(p.id) AS plays
      FROM plays p JOIN tracks t ON t.id = p.track_id JOIN track_artists ta ON ta.track_id = t.id AND ta.role = 'artist'
      WHERE p.user_id = ? GROUP BY ta.artist_id
      ORDER BY plays DESC LIMIT 8`).all(uid),
  });
});

api.get('/albums', (req, res) => {
  const { limit, offset } = page(req, 60);
  const order = ALBUM_SORTS[req.query.sort] || ALBUM_SORTS.name;
  const { where, params } = libraryFilters(req.query);
  const having = req.query.sort === 'played' ? 'HAVING playCount > 0' : req.query.sort === 'rating' ? 'HAVING rating IS NOT NULL' : '';
  res.json(q(`SELECT ${ALBUM_COLS} ${ALBUM_USER_COLS} FROM tracks t ${ALBUM_USER_JOINS} ${where}
    GROUP BY t.album_id ${having} ORDER BY ${order} LIMIT $limit OFFSET $offset`)
    .all({ uid: req.user.id, limit, offset, ...params }));
});

/** Years and release types present in the library, for the filter UI. */
api.get('/albums/facets', (_req, res) => {
  res.json({
    years: q('SELECT MIN(year) AS min, MAX(year) AS max FROM tracks WHERE year > 0').get(),
    types: q(`SELECT CASE WHEN compilation = 1 THEN 'compilation' ELSE COALESCE(release_type, 'album') END AS type,
      COUNT(DISTINCT album_id) AS n FROM tracks GROUP BY type ORDER BY n DESC`).all(),
  });
});

api.get('/albums/:id', (req, res) => {
  const album = q(`SELECT ${ALBUM_COLS} FROM tracks t WHERE t.album_id = ? GROUP BY t.album_id`).get(req.params.id);
  if (!album) return res.status(404).json({ error: 'Album not found' });
  album.tracks = tracks(q(`SELECT ${TRACK_COLS} ${TRACK_FROM} WHERE t.album_id = $id
    ORDER BY COALESCE(t.disc_no, 1), COALESCE(t.track_no, 9999), t.title COLLATE NOCASE`).all({ uid: req.user.id, id: req.params.id }));
  album.genres = q(`SELECT g.genre AS name, COUNT(*) AS n FROM track_genres g JOIN tracks t ON t.id = g.track_id
    WHERE t.album_id = ? GROUP BY g.genre ORDER BY n DESC LIMIT 6`).all(album.id).map((g) => g.name);
  album.more = q(`SELECT ${ALBUM_COLS} FROM tracks t WHERE t.album_artist_id = ? AND t.album_id != ?
    GROUP BY t.album_id ORDER BY year DESC LIMIT 12`).all(album.artistId, album.id);
  res.json(album);
});

const ARTIST_IMAGE = (idExpr, fallback) => `COALESCE((SELECT image FROM artist_images WHERE artist_id = ${idExpr}), ${fallback})`;

api.get('/artists', (req, res) => {
  const { limit, offset } = page(req, 100);
  res.json(q(`SELECT t.album_artist_id AS id, MAX(t.album_artist) AS name, ${ARTIST_IMAGE('t.album_artist_id', 'MAX(t.cover)')} AS cover,
    COUNT(DISTINCT t.album_id) AS albumCount, COUNT(*) AS trackCount
    FROM tracks t GROUP BY t.album_artist_id ORDER BY name COLLATE NOCASE LIMIT ? OFFSET ?`).all(limit, offset));
});

api.get('/artists/:id', (req, res) => {
  const id = req.params.id;
  const artist = q(`SELECT album_artist_id AS id, MAX(album_artist) AS name, ${ARTIST_IMAGE('album_artist_id', 'MAX(cover)')} AS cover,
    COUNT(DISTINCT album_id) AS albumCount, COUNT(*) AS trackCount, SUM(duration) AS duration
    FROM tracks WHERE album_artist_id = ? GROUP BY album_artist_id`).get(id)
    || q(`SELECT ta.artist_id AS id, MAX(ta.name) AS name, ${ARTIST_IMAGE('ta.artist_id', 'MAX(t.cover)')} AS cover, 0 AS albumCount,
      COUNT(*) AS trackCount, SUM(t.duration) AS duration FROM track_artists ta JOIN tracks t ON t.id = ta.track_id
      WHERE ta.artist_id = ? AND ta.role = 'artist' GROUP BY ta.artist_id`).get(id);
  if (!artist) return res.status(404).json({ error: 'Artist not found' });
  const albums = q(`SELECT ${ALBUM_COLS} FROM tracks t WHERE t.album_id IN
    (SELECT t2.album_id FROM track_artists ta JOIN tracks t2 ON t2.id = ta.track_id WHERE ta.artist_id = ? AND ta.role = 'album')
    GROUP BY t.album_id ORDER BY year DESC`).all(id);
  // Group the discography by release type, like most players do.
  const kind = (a) => (a.compilation ? 'compilation' : a.releaseType || 'album');
  artist.albums = albums.filter((a) => ['album', 'soundtrack', 'other'].includes(kind(a)));
  artist.eps = albums.filter((a) => ['ep', 'single'].includes(kind(a)));
  artist.live = albums.filter((a) => ['live', 'remix', 'compilation'].includes(kind(a)));
  artist.albumCount = albums.length;
  artist.appearsOn = q(`SELECT ${ALBUM_COLS} FROM tracks t WHERE t.album_id IN
    (SELECT t2.album_id FROM track_artists ta JOIN tracks t2 ON t2.id = ta.track_id WHERE ta.artist_id = $id AND ta.role = 'artist')
    AND t.album_id NOT IN (SELECT t3.album_id FROM track_artists tb JOIN tracks t3 ON t3.id = tb.track_id WHERE tb.artist_id = $id AND tb.role = 'album')
    GROUP BY t.album_id ORDER BY year DESC`).all({ id });
  artist.topTracks = tracks(q(`SELECT ${TRACK_COLS}, (SELECT COUNT(*) FROM plays p WHERE p.track_id = t.id) AS plays
    ${TRACK_FROM} WHERE t.id IN (SELECT track_id FROM track_artists WHERE artist_id = $id)
    ORDER BY plays DESC, rating DESC, RANDOM() LIMIT 10`).all({ uid: req.user.id, id }));
  res.json(artist);
});

api.get('/artists/:id/tracks', (req, res) => {
  res.json(tracks(q(`SELECT ${TRACK_COLS} ${TRACK_FROM} WHERE t.id IN (SELECT track_id FROM track_artists WHERE artist_id = $id)
    ORDER BY t.year, t.album_id, t.disc_no, t.track_no`).all({ uid: req.user.id, id: req.params.id })));
});

api.get('/tracks', (req, res) => {
  const { limit, offset } = page(req, 100);
  const order = TRACK_SORTS[req.query.sort] || TRACK_SORTS.title;
  const { where, params } = libraryFilters(req.query, { trackLevel: true });
  const playedOnly = req.query.sort === 'played' || req.query.sort === 'lastPlayed';
  const w = playedOnly ? (where ? `${where} AND pc.n > 0` : 'WHERE pc.n > 0') : where;
  res.json(tracks(q(`SELECT ${TRACK_COLS} ${TRACK_FROM} ${w} ORDER BY ${order} LIMIT $limit OFFSET $offset`)
    .all({ uid: req.user.id, limit, offset, ...params })));
});

/** Count for the current filters (Songs page header). */
api.get('/tracks/count', (req, res) => {
  const { where, params } = libraryFilters(req.query, { trackLevel: true });
  res.json(q(`SELECT COUNT(*) AS n, COALESCE(SUM(t.duration), 0) AS duration ${TRACK_FROM} ${where}`).get({ uid: req.user.id, ...params }));
});

/** Tracks by id, in the order given (used to restore a saved queue). */
api.post('/tracks/lookup', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(idParam).filter(Boolean).slice(0, 5000) : [];
  if (!ids.length) return res.json([]);
  const rows = tracks(q(`SELECT ${TRACK_COLS} ${TRACK_FROM} WHERE t.id IN (SELECT value FROM json_each($ids))`)
    .all({ uid: req.user.id, ids: JSON.stringify(ids) }));
  const byId = new Map(rows.map((t) => [t.id, t]));
  res.json(ids.map((id) => byId.get(id) || null));
});

api.get('/tracks/random', (req, res) => {
  const limit = int(req.query.limit, 100, 1, 500);
  res.json(tracks(q(`SELECT ${TRACK_COLS} ${TRACK_FROM} ORDER BY RANDOM() LIMIT $limit`).all({ uid: req.user.id, limit })));
});

api.get('/genres', (_req, res) => {
  res.json(q(`SELECT g.genre AS name, COUNT(*) AS trackCount, COUNT(DISTINCT t.album_id) AS albumCount, MAX(t.cover) AS cover
    FROM track_genres g JOIN tracks t ON t.id = g.track_id GROUP BY g.genre ORDER BY trackCount DESC`).all());
});

api.get('/search', (req, res) => {
  const term = String(req.query.q || '').trim();
  if (!term) return res.json({ tracks: [], albums: [], artists: [] });
  const like = `%${term.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
  res.json({
    artists: q(`SELECT ta.artist_id AS id, MAX(ta.name) AS name, ${ARTIST_IMAGE('ta.artist_id', 'MAX(t.cover)')} AS cover,
      COUNT(DISTINCT t.album_id) AS albumCount FROM track_artists ta JOIN tracks t ON t.id = ta.track_id
      WHERE ta.name LIKE ? ESCAPE '\\' GROUP BY ta.artist_id ORDER BY COUNT(*) DESC LIMIT 8`).all(like),
    albums: q(`SELECT ${ALBUM_COLS} FROM tracks t WHERE t.album LIKE ? ESCAPE '\\' GROUP BY t.album_id LIMIT 12`).all(like),
    tracks: tracks(q(`SELECT ${TRACK_COLS} ${TRACK_FROM} WHERE t.title LIKE $like ESCAPE '\\'
      OR t.artist LIKE $like ESCAPE '\\' OR t.album LIKE $like ESCAPE '\\'
      ORDER BY (t.title LIKE $like ESCAPE '\\') DESC, t.title COLLATE NOCASE LIMIT 50`).all({ uid: req.user.id, like })),
  });
});

api.get('/tracks/:id', (req, res) => {
  const t = fixTrack(q(`SELECT ${TRACK_COLS}, t.path, t.size, t.mtime, t.mbz_track_id AS mbzTrackId, t.mbz_album_id AS mbzAlbumId,
    t.mbz_artist_id AS mbzArtistId ${TRACK_FROM} WHERE t.id = $id`).get({ uid: req.user.id, id: idParam(req.params.id) }));
  if (!t) return res.status(404).json({ error: 'Track not found' });
  t.genres = q('SELECT genre FROM track_genres WHERE track_id = ?').all(t.id).map((g) => g.genre);
  t.albumArtists = q(`SELECT artist_id AS id, name FROM track_artists WHERE track_id = ? AND role = 'album' ORDER BY position`).all(t.id);
  t.format = path.extname(t.path).slice(1).toUpperCase();
  // Only admins get to see where files live on the server.
  if (req.user.is_admin) t.file = t.path;
  delete t.path;
  res.json(t);
});

api.put('/ratings/:id', (req, res) => {
  const id = idParam(req.params.id);
  const rating = int(req.body?.rating, 0, 0, 5);
  if (!q('SELECT 1 FROM tracks WHERE id = ?').get(id)) return res.status(404).json({ error: 'Track not found' });
  if (rating) {
    q(`INSERT INTO ratings (user_id, track_id, rating, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, track_id) DO UPDATE SET rating = excluded.rating, updated_at = excluded.updated_at`).run(req.user.id, id, rating, Date.now());
  } else {
    q('DELETE FROM ratings WHERE user_id = ? AND track_id = ?').run(req.user.id, id);
  }
  res.json({ rating });
});

// ───────────────────────── Media ─────────────────────────

const MIME = {
  '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.aac': 'audio/aac',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.webm': 'audio/webm',
};

api.get('/stream/:id', (req, res) => {
  const row = q('SELECT path FROM tracks WHERE id = ?').get(int(req.params.id, 0, 0, Number.MAX_SAFE_INTEGER));
  if (!row) return res.status(404).json({ error: 'Track not found' });
  const type = MIME[path.extname(row.path).toLowerCase()];
  res.sendFile(row.path, { headers: type ? { 'Content-Type': type } : {}, dotfiles: 'allow', acceptRanges: true }, (err) => {
    if (err && !res.headersSent) res.status(err.status || 404).json({ error: 'File unavailable' });
  });
});

api.get('/cover/:file', (req, res) => {
  if (!/^[a-f0-9]{40}\.(jpg|png|webp)$/.test(req.params.file)) return res.status(400).end();
  res.sendFile(path.join(COVERS_DIR, req.params.file), { maxAge: '365d', immutable: true }, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

api.post('/tracks/:id/play', (req, res) => {
  const id = int(req.params.id, 0, 0, Number.MAX_SAFE_INTEGER);
  if (!q('SELECT 1 FROM tracks WHERE id = ?').get(id)) return res.status(404).json({ error: 'Track not found' });
  q('INSERT INTO plays (user_id, track_id, played_at) VALUES (?, ?, ?)').run(req.user.id, id, Date.now());
  res.json({ ok: true });
});

// ───────────────────────── Favorites ─────────────────────────

api.get('/favorites', (req, res) => {
  res.json(tracks(q(`SELECT ${TRACK_COLS} ${TRACK_FROM} WHERE f.track_id IS NOT NULL
    ORDER BY f.created_at DESC`).all({ uid: req.user.id })));
});

api.put('/favorites/:id', (req, res) => {
  q('INSERT OR IGNORE INTO favorites (user_id, track_id, created_at) SELECT ?, id, ? FROM tracks WHERE id = ?')
    .run(req.user.id, Date.now(), int(req.params.id, 0, 0, Number.MAX_SAFE_INTEGER));
  res.json({ favorite: true });
});

api.delete('/favorites/:id', (req, res) => {
  q('DELETE FROM favorites WHERE user_id = ? AND track_id = ?').run(req.user.id, int(req.params.id, 0, 0, Number.MAX_SAFE_INTEGER));
  res.json({ favorite: false });
});

// ───────────────────────── Playlists ─────────────────────────

const PLAYLIST_COLS = `p.id, p.name, p.description, p.created_at AS createdAt, p.updated_at AS updatedAt,
  (SELECT COUNT(*) FROM playlist_tracks pt WHERE pt.playlist_id = p.id) AS trackCount,
  (SELECT SUM(t.duration) FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id WHERE pt.playlist_id = p.id) AS duration`;

function ownPlaylist(req, res) {
  const pl = q(`SELECT ${PLAYLIST_COLS} FROM playlists p WHERE p.id = ? AND p.user_id = ?`)
    .get(int(req.params.id, 0, 0, Number.MAX_SAFE_INTEGER), req.user.id);
  if (!pl) res.status(404).json({ error: 'Playlist not found' });
  return pl;
}

function playlistCovers(id) {
  return q(`SELECT DISTINCT t.cover FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
    WHERE pt.playlist_id = ? AND t.cover IS NOT NULL ORDER BY pt.position LIMIT 4`).all(id).map((r) => r.cover);
}

api.get('/playlists', (req, res) => {
  const rows = q(`SELECT ${PLAYLIST_COLS} FROM playlists p WHERE p.user_id = ? ORDER BY p.updated_at DESC`).all(req.user.id);
  res.json(rows.map((p) => ({ ...p, covers: playlistCovers(p.id) })));
});

api.post('/playlists', (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 100);
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const now = Date.now();
  const { lastInsertRowid } = q('INSERT INTO playlists (user_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(req.user.id, name, String(req.body?.description || '').slice(0, 500), now, now);
  const id = Number(lastInsertRowid);
  if (Array.isArray(req.body?.trackIds)) addToPlaylist(id, req.body.trackIds);
  res.json(q(`SELECT ${PLAYLIST_COLS} FROM playlists p WHERE p.id = ?`).get(id));
});

api.get('/playlists/:id', (req, res) => {
  const pl = ownPlaylist(req, res);
  if (!pl) return;
  pl.covers = playlistCovers(pl.id);
  pl.tracks = tracks(q(`SELECT ${TRACK_COLS}, pt.id AS entryId FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
    ${TRACK_JOINS} WHERE pt.playlist_id = $pid ORDER BY pt.position`)
    .all({ uid: req.user.id, pid: pl.id }));
  res.json(pl);
});

api.put('/playlists/:id', (req, res) => {
  const pl = ownPlaylist(req, res);
  if (!pl) return;
  const name = req.body?.name != null ? String(req.body.name).trim().slice(0, 100) : pl.name;
  const description = req.body?.description != null ? String(req.body.description).slice(0, 500) : pl.description;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  q('UPDATE playlists SET name = ?, description = ?, updated_at = ? WHERE id = ?').run(name, description, Date.now(), pl.id);
  res.json({ ok: true });
});

api.delete('/playlists/:id', (req, res) => {
  const pl = ownPlaylist(req, res);
  if (!pl) return;
  q('DELETE FROM playlists WHERE id = ?').run(pl.id);
  res.json({ ok: true });
});

function addToPlaylist(id, trackIds) {
  const ids = trackIds.map((n) => int(n, 0, 0, Number.MAX_SAFE_INTEGER)).filter(Boolean).slice(0, 5000);
  tx(() => {
    let pos = q('SELECT COALESCE(MAX(position), -1) AS p FROM playlist_tracks WHERE playlist_id = ?').get(id).p;
    const ins = q('INSERT INTO playlist_tracks (playlist_id, track_id, position) SELECT ?, id, ? FROM tracks WHERE id = ?');
    for (const tid of ids) ins.run(id, ++pos, tid);
    q('UPDATE playlists SET updated_at = ? WHERE id = ?').run(Date.now(), id);
  });
  return ids.length;
}

api.post('/playlists/:id/tracks', (req, res) => {
  const pl = ownPlaylist(req, res);
  if (!pl) return;
  if (!Array.isArray(req.body?.trackIds)) return res.status(400).json({ error: 'trackIds must be an array' });
  res.json({ added: addToPlaylist(pl.id, req.body.trackIds) });
});

api.delete('/playlists/:id/tracks/:entryId', (req, res) => {
  const pl = ownPlaylist(req, res);
  if (!pl) return;
  q('DELETE FROM playlist_tracks WHERE id = ? AND playlist_id = ?').run(int(req.params.entryId, 0, 0, Number.MAX_SAFE_INTEGER), pl.id);
  q('UPDATE playlists SET updated_at = ? WHERE id = ?').run(Date.now(), pl.id);
  res.json({ ok: true });
});

// Reorder: body { entryIds: [...] } in the new order.
api.put('/playlists/:id/order', (req, res) => {
  const pl = ownPlaylist(req, res);
  if (!pl) return;
  if (!Array.isArray(req.body?.entryIds)) return res.status(400).json({ error: 'entryIds must be an array' });
  tx(() => {
    const upd = q('UPDATE playlist_tracks SET position = ? WHERE id = ? AND playlist_id = ?');
    req.body.entryIds.forEach((eid, i) => upd.run(i, int(eid, 0, 0, Number.MAX_SAFE_INTEGER), pl.id));
    q('UPDATE playlists SET updated_at = ? WHERE id = ?').run(Date.now(), pl.id);
  });
  res.json({ ok: true });
});

// ───────────────────────── Admin ─────────────────────────

const admin = express.Router();
api.use('/admin', requireAdmin, admin);

admin.get('/users', (_req, res) => {
  res.json(q('SELECT * FROM users ORDER BY created_at').all().map(publicUser));
});

admin.post('/users', (req, res) => {
  const { username, password, isAdmin } = req.body || {};
  const problem = validateCredentials(username, password);
  if (problem) return res.status(400).json({ error: problem });
  if (q('SELECT 1 FROM users WHERE username = ?').get(username)) return res.status(409).json({ error: 'Username already taken' });
  q('INSERT INTO users (username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?)')
    .run(username, hashPassword(password), isAdmin ? 1 : 0, Date.now());
  res.json({ ok: true });
});

admin.put('/users/:id', (req, res) => {
  const id = int(req.params.id, 0, 0, Number.MAX_SAFE_INTEGER);
  const user = q('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (req.body?.password != null) {
    const problem = validateCredentials(user.username, req.body.password);
    if (problem) return res.status(400).json({ error: problem });
    q('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(req.body.password), id);
    q('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(id, req.sessionToken);
  }
  if (req.body?.isAdmin != null) {
    if (id === req.user.id && !req.body.isAdmin) return res.status(400).json({ error: "You can't remove your own admin rights" });
    q('UPDATE users SET is_admin = ? WHERE id = ?').run(req.body.isAdmin ? 1 : 0, id);
  }
  res.json({ ok: true });
});

admin.delete('/users/:id', (req, res) => {
  const id = int(req.params.id, 0, 0, Number.MAX_SAFE_INTEGER);
  if (id === req.user.id) return res.status(400).json({ error: "You can't delete yourself" });
  q('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

admin.get('/settings', (_req, res) => {
  const c = getConfig();
  res.json({
    musicDirs: c.musicDirs.map((d) => ({ path: d, exists: fs.existsSync(d) })),
    scanIntervalMinutes: c.scanIntervalMinutes,
    scanOnStartup: c.scanOnStartup,
    watch: c.watch !== false,
    allowFileChanges: !!c.allowFileChanges,
    downloadsDir: inboxDir(),
    port: c.port,
    platform: process.platform,
    node: process.version,
    envMusicDirs: !!process.env.SONARA_MUSIC_DIRS,
  });
});

admin.put('/settings', (req, res) => {
  const patch = {};
  if (Array.isArray(req.body?.musicDirs)) {
    const dirs = [...new Set(req.body.musicDirs.map((d) => path.resolve(String(d).trim())).filter(Boolean))];
    const missing = dirs.filter((d) => !fs.existsSync(d) || !fs.statSync(d).isDirectory());
    if (missing.length) return res.status(400).json({ error: `Folder not found: ${missing[0]}` });
    patch.musicDirs = dirs;
  }
  if (req.body?.scanIntervalMinutes != null) patch.scanIntervalMinutes = int(req.body.scanIntervalMinutes, 60, 0, 60 * 24 * 7);
  if (req.body?.scanOnStartup != null) patch.scanOnStartup = !!req.body.scanOnStartup;
  if (req.body?.watch != null) patch.watch = !!req.body.watch;
  if (req.body?.allowFileChanges != null) patch.allowFileChanges = !!req.body.allowFileChanges;
  if (req.body?.downloadsDir != null) {
    const d = String(req.body.downloadsDir).trim();
    if (d) {
      const abs = path.resolve(d);
      try { fs.mkdirSync(abs, { recursive: true }); } catch (err) { return res.status(400).json({ error: `Cannot use that folder: ${err.code || err.message}` }); }
      if (musicRoots().some((r) => abs === r || abs.startsWith(r + path.sep))) return res.status(400).json({ error: 'The downloads folder must be outside your music folders, or files would show up in the library before you file them.' });
      patch.downloadsDir = abs;
    } else patch.downloadsDir = '';
  }
  saveConfig(patch);
  scheduleScans();
  if (patch.musicDirs || patch.watch != null) watchLibrary();
  res.json({ ok: true });
});

admin.get('/browse', (req, res) => {
  const requested = String(req.query.path || '').trim();
  // No path: list sensible starting points (drives on Windows, / and home elsewhere).
  if (!requested) {
    const roots = [{ name: 'Home', path: os.homedir() }];
    if (process.platform === 'win32') {
      for (let c = 67; c <= 90; c++) {
        const d = String.fromCharCode(c) + ':\\';
        if (fs.existsSync(d)) roots.push({ name: d, path: d });
      }
    } else {
      roots.push({ name: '/', path: '/' });
      for (const m of ['/mnt', '/media', '/Volumes', '/srv']) if (fs.existsSync(m)) roots.push({ name: m, path: m });
    }
    return res.json({ path: '', parent: null, dirs: roots });
  }
  const dir = path.resolve(requested);
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith('.') && !e.name.startsWith('$'));
    const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => ({ name: e.name, path: path.join(dir, e.name) })).sort(byName);
    const parent = path.dirname(dir);
    const out = { path: dir, parent: parent === dir ? '' : parent, dirs };
    // ?files=video|audio|all also lists files (for the converter's file picker).
    if (req.query.files) {
      const want = String(req.query.files);
      out.files = entries.filter((e) => e.isFile()).filter((e) => {
        const ext = path.extname(e.name).toLowerCase();
        return want === 'all' || (want === 'video' ? VIDEO_EXT.has(ext) : true);
      }).map((e) => ({ name: e.name, path: path.join(dir, e.name) })).sort(byName).slice(0, 2000);
    }
    res.json(out);
  } catch (err) {
    res.status(400).json({ error: `Cannot open folder: ${err.code || err.message}` });
  }
});

admin.post('/scan', (req, res) => {
  if (scanStatus().running) return res.status(409).json({ error: 'A scan is already running' });
  scanLibrary({ full: !!req.body?.full });
  res.json(scanStatus());
});

admin.get('/scan', (req, res) => res.json(scanStatus({ issues: req.query.issues === '1' })));

// ───────────────────────── Files: tags, moving, organizing ─────────────────────────

/** Wrap async admin handlers: errors with .status become JSON responses. */
const h = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (err) {
    if (!err.status) console.error(err);
    if (!res.headersSent) res.status(err.status || 500).json({ error: err.message || 'Something went wrong' });
  }
};
const idList = (v) => (Array.isArray(v) ? v.map(idParam).filter(Boolean).slice(0, 20000) : []);

admin.get('/tools', h(async (req, res) => {
  res.json({ ...(await tools(req.query.refresh === '1')), allowFileChanges: !!getConfig().allowFileChanges });
}));

/** Clean incoming tag edits: only known keys; '' clears; numbers validated. */
function cleanTags(body) {
  const tags = {};
  for (const k of EDITABLE_TAGS) {
    if (!(k in (body || {}))) continue;
    let v = body[k];
    if (v === null || v === '') { tags[k] = null; continue; }
    if (['trackNo', 'discNo', 'year'].includes(k)) {
      v = int(v, null, 0, 9999);
      if (v == null) continue;
    }
    tags[k] = String(v).trim();
  }
  return tags;
}

// Body: { ids: [...], tags: { title?, artist?, album?, albumArtist?, trackNo?, discNo?, year?, genre?, composer?, comment? } }
admin.post('/tracks/tags', h(async (req, res) => {
  assertFileChangesAllowed();
  const ids = idList(req.body?.ids);
  const tags = cleanTags(req.body?.tags);
  if (!ids.length) return res.status(400).json({ error: 'No tracks selected' });
  if (!Object.keys(tags).length) return res.status(400).json({ error: 'Nothing to change' });
  if (ids.length > 1 && 'title' in tags) delete tags.title; // never give a whole album the same title
  res.json(await editTracks(ids, tags));
}));

// Body: { ids: [...], dir } — move files into one folder, keeping their names.
admin.post('/tracks/move', h(async (req, res) => {
  assertFileChangesAllowed();
  const dir = String(req.body?.dir || '').trim();
  if (!dir) return res.status(400).json({ error: 'Choose a destination folder' });
  assertInLibrary(dir);
  const rows = scopeTracks({ type: 'tracks', ids: idList(req.body?.ids) });
  const plan = await planMoves(rows, { dir });
  res.json(await applyMoves(plan, { mode: 'move' }));
}));

admin.get('/organize/templates', (_req, res) => res.json({ templates: TEMPLATES, roots: musicRoots() }));

// Body: { scope: { type, id?, ids? }, template, root?, mode: 'move'|'copy', dest?, dryRun }
admin.post('/organize', h(async (req, res) => {
  const b = req.body || {};
  const template = String(b.template || '').trim();
  const problem = validateTemplate(template);
  if (problem) return res.status(400).json({ error: problem });
  const mode = b.mode === 'copy' ? 'copy' : 'move';
  // Moves stay inside the library; copies (e.g. exporting a playlist to a USB stick) may go anywhere.
  const root = b.root ? path.resolve(String(b.root)) : null;
  if (root && mode === 'move') assertInLibrary(root);
  if (!root && mode === 'copy') return res.status(400).json({ error: 'Choose where to copy the files to' });
  const rows = scopeTracks(b.scope);
  if (!rows.length) return res.status(400).json({ error: 'No songs in that selection' });
  let playlist = null;
  if (b.scope?.type === 'playlist') playlist = q('SELECT name FROM playlists WHERE id = ?').get(idParam(b.scope.id))?.name;
  const plan = await planMoves(rows, { template, root, playlist });
  if (b.dryRun) {
    return res.json({ total: rows.length, changes: plan.length, unchanged: rows.length - plan.length, preview: plan.slice(0, 300).map((m) => ({ from: m.from, to: m.to })) });
  }
  assertFileChangesAllowed();
  res.json(await applyMoves(plan, { mode }));
}));

// ───────────────────────── Inbox: downloads & conversions ─────────────────────────

admin.get('/inbox', h(async (_req, res) => {
  res.json({ dir: inboxDir(), files: await listInbox(), jobs: listJobs(), tools: await tools(), formats: AUDIO_FORMATS, convertFormats: Object.keys(CONVERT_FORMATS) });
}));

admin.get('/inbox/jobs', (_req, res) => res.json(listJobs()));

admin.get('/inbox/file/:name', h(async (req, res) => {
  const file = inboxPath(req.params.name);
  res.sendFile(file, { dotfiles: 'deny', acceptRanges: true }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'File not found' });
  });
}));

admin.put('/inbox/tags/:name', h(async (req, res) => {
  const file = inboxPath(req.params.name);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'File not found' });
  const tags = cleanTags(req.body?.tags);
  if (!Object.keys(tags).length) return res.status(400).json({ error: 'Nothing to change' });
  await writeTags(file, tags);
  res.json({ ok: true });
}));

admin.put('/inbox/rename/:name', h(async (req, res) => {
  const from = inboxPath(req.params.name);
  const ext = path.extname(from);
  let to = String(req.body?.name || '').trim();
  if (!to) return res.status(400).json({ error: 'Enter a name' });
  if (!to.toLowerCase().endsWith(ext.toLowerCase())) to += ext;
  const target = inboxPath(to.replace(/[\\/:*?"<>|]/g, '_'));
  if (fs.existsSync(target)) return res.status(409).json({ error: 'A file with that name already exists' });
  fs.renameSync(from, target);
  res.json({ name: path.basename(target) });
}));

admin.delete('/inbox/:name', h(async (req, res) => {
  fs.rmSync(inboxPath(req.params.name), { force: true });
  res.json({ ok: true });
}));

admin.post('/inbox/download', h(async (req, res) => {
  const urls = String(req.body?.url || '').split(/\s+/).filter(Boolean).slice(0, 50);
  if (!urls.length) return res.status(400).json({ error: 'Paste a link' });
  const jobs = [];
  for (const url of urls) jobs.push(await queueDownload(url, { format: req.body?.format, playlist: !!req.body?.playlist, embedThumbnail: req.body?.embedThumbnail !== false }));
  res.json({ jobs });
}));

// Body: { name } (an Inbox file) or { path } (any file on the server), plus { format, bitrate, deleteSource, cover }
admin.post('/inbox/convert', h(async (req, res) => {
  const b = req.body || {};
  const source = b.name ? inboxPath(b.name) : path.resolve(String(b.path || ''));
  if (!b.name && !b.path) return res.status(400).json({ error: 'Choose a file to convert' });
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) return res.status(404).json({ error: 'File not found' });
  res.json(await queueConvert(source, { format: b.format, bitrate: b.bitrate, deleteSource: !!b.deleteSource && !!b.name, cover: b.cover !== false }));
}));

// Raw upload: POST /admin/inbox/upload?name=video.mp4 with the file as the body.
admin.post('/inbox/upload', h(async (req, res) => {
  const name = String(req.query.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Missing file name' });
  const max = Number(getConfig().maxUploadMB || 4096) * 1024 * 1024;
  if (Number(req.headers['content-length']) > max) return res.status(413).json({ error: 'File is too large' });
  res.json({ name: await saveUpload(name, req, max) });
}));

admin.post('/inbox/import', h(async (req, res) => {
  assertFileChangesAllowed();
  const b = req.body || {};
  const names = Array.isArray(b.names) ? b.names.map(String).slice(0, 2000) : [];
  if (!names.length) return res.status(400).json({ error: 'No files selected' });
  let dest;
  if (b.dir) dest = { dir: String(b.dir) };
  else {
    const template = String(b.template || TEMPLATES.album.template);
    const problem = validateTemplate(template);
    if (problem) return res.status(400).json({ error: problem });
    dest = { template, root: b.root ? String(b.root) : null };
  }
  const result = await importToLibrary(names, dest);
  const plId = idParam(b.playlistId);
  if (plId && result.imported.length && q('SELECT 1 FROM playlists WHERE id = ? AND user_id = ?').get(plId, req.user.id)) {
    addToPlaylist(plId, result.imported.map((i) => i.trackId).filter(Boolean));
  }
  res.json(result);
}));

admin.post('/inbox/jobs/:id/cancel', (req, res) => res.json({ ok: cancelJob(req.params.id) }));
admin.delete('/inbox/jobs', (_req, res) => { clearFinishedJobs(); res.json({ ok: true }); });

api.use((_req, res) => res.status(404).json({ error: 'Not found' }));
