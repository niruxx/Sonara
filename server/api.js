import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { q, tx } from './db.js';
import { COVERS_DIR, getConfig, saveConfig } from './config.js';
import { scanLibrary, scanStatus, scheduleScans } from './scanner.js';
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
  t.disc_no AS discNo, t.year, t.genre, t.duration, t.bitrate, t.sample_rate AS sampleRate,
  t.codec, t.lossless, t.cover, t.added_at AS addedAt,
  (f.track_id IS NOT NULL) AS favorite`;
const TRACK_FROM = `FROM tracks t LEFT JOIN favorites f ON f.track_id = t.id AND f.user_id = $uid`;

const ALBUM_COLS = `
  t.album_id AS id, MAX(t.album) AS name, MAX(t.album_artist) AS artist, t.album_artist_id AS artistId,
  MAX(t.year) AS year, MAX(t.cover) AS cover, COUNT(*) AS trackCount, SUM(t.duration) AS duration,
  MAX(t.added_at) AS addedAt, MAX(t.genre) AS genre`;

const ALBUM_SORTS = {
  name: 'name COLLATE NOCASE ASC',
  artist: 'artist COLLATE NOCASE ASC, year ASC',
  year: 'year DESC, name COLLATE NOCASE',
  recent: 'addedAt DESC',
  random: 'RANDOM()',
};
const TRACK_SORTS = {
  title: 't.title COLLATE NOCASE ASC',
  artist: 't.artist COLLATE NOCASE, t.album COLLATE NOCASE, t.disc_no, t.track_no',
  album: 't.album COLLATE NOCASE, t.disc_no, t.track_no',
  recent: 't.added_at DESC, t.album_id, t.disc_no, t.track_no',
  year: 't.year DESC, t.album_id, t.disc_no, t.track_no',
  duration: 't.duration DESC',
};

const fixTrack = (t) => t && { ...t, favorite: !!t.favorite, lossless: !!t.lossless };
const tracks = (rows) => rows.map(fixTrack);

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
    recentlyPlayed: tracks(q(`SELECT ${TRACK_COLS}, MAX(p.played_at) AS playedAt FROM plays p
      JOIN tracks t ON t.id = p.track_id LEFT JOIN favorites f ON f.track_id = t.id AND f.user_id = $uid
      WHERE p.user_id = $uid GROUP BY t.id ORDER BY playedAt DESC LIMIT 12`).all({ uid })),
    mostPlayed: tracks(q(`SELECT ${TRACK_COLS}, COUNT(p.id) AS plays FROM plays p
      JOIN tracks t ON t.id = p.track_id LEFT JOIN favorites f ON f.track_id = t.id AND f.user_id = $uid
      WHERE p.user_id = $uid GROUP BY t.id ORDER BY plays DESC LIMIT 10`).all({ uid })),
    topArtists: q(`SELECT t.album_artist_id AS id, MAX(t.album_artist) AS name, MAX(t.cover) AS cover, COUNT(p.id) AS plays
      FROM plays p JOIN tracks t ON t.id = p.track_id WHERE p.user_id = ? GROUP BY t.album_artist_id
      ORDER BY plays DESC LIMIT 8`).all(uid),
  });
});

api.get('/albums', (req, res) => {
  const { limit, offset } = page(req, 60);
  const order = ALBUM_SORTS[req.query.sort] || ALBUM_SORTS.name;
  const genre = req.query.genre;
  const where = genre ? 'WHERE t.genre = $genre' : '';
  res.json(q(`SELECT ${ALBUM_COLS} FROM tracks t ${where} GROUP BY t.album_id ORDER BY ${order} LIMIT $limit OFFSET $offset`)
    .all({ limit, offset, ...(genre ? { genre } : {}) }));
});

api.get('/albums/:id', (req, res) => {
  const album = q(`SELECT ${ALBUM_COLS} FROM tracks t WHERE t.album_id = ? GROUP BY t.album_id`).get(req.params.id);
  if (!album) return res.status(404).json({ error: 'Album not found' });
  album.tracks = tracks(q(`SELECT ${TRACK_COLS} ${TRACK_FROM} WHERE t.album_id = $id
    ORDER BY COALESCE(t.disc_no, 1), COALESCE(t.track_no, 9999), t.title COLLATE NOCASE`).all({ uid: req.user.id, id: req.params.id }));
  album.more = q(`SELECT ${ALBUM_COLS} FROM tracks t WHERE t.album_artist_id = ? AND t.album_id != ?
    GROUP BY t.album_id ORDER BY year DESC LIMIT 12`).all(album.artistId, album.id);
  res.json(album);
});

api.get('/artists', (req, res) => {
  const { limit, offset } = page(req, 100);
  res.json(q(`SELECT t.album_artist_id AS id, MAX(t.album_artist) AS name, MAX(t.cover) AS cover,
    COUNT(DISTINCT t.album_id) AS albumCount, COUNT(*) AS trackCount
    FROM tracks t GROUP BY t.album_artist_id ORDER BY name COLLATE NOCASE LIMIT ? OFFSET ?`).all(limit, offset));
});

api.get('/artists/:id', (req, res) => {
  const id = req.params.id;
  const artist = q(`SELECT album_artist_id AS id, MAX(album_artist) AS name, MAX(cover) AS cover,
    COUNT(DISTINCT album_id) AS albumCount, COUNT(*) AS trackCount, SUM(duration) AS duration
    FROM tracks WHERE album_artist_id = ? GROUP BY album_artist_id`).get(id)
    || q(`SELECT artist_id AS id, MAX(artist) AS name, MAX(cover) AS cover, 0 AS albumCount, COUNT(*) AS trackCount,
      SUM(duration) AS duration FROM tracks WHERE artist_id = ? GROUP BY artist_id`).get(id);
  if (!artist) return res.status(404).json({ error: 'Artist not found' });
  artist.albums = q(`SELECT ${ALBUM_COLS} FROM tracks t WHERE t.album_artist_id = ? GROUP BY t.album_id ORDER BY year DESC`).all(id);
  artist.appearsOn = q(`SELECT ${ALBUM_COLS} FROM tracks t WHERE t.album_id IN
    (SELECT album_id FROM tracks WHERE artist_id = ? AND album_artist_id != ?) GROUP BY t.album_id ORDER BY year DESC`).all(id, id);
  artist.topTracks = tracks(q(`SELECT ${TRACK_COLS}, (SELECT COUNT(*) FROM plays p WHERE p.track_id = t.id) AS plays
    ${TRACK_FROM} WHERE t.album_artist_id = $id OR t.artist_id = $id ORDER BY plays DESC, RANDOM() LIMIT 10`)
    .all({ uid: req.user.id, id }));
  res.json(artist);
});

api.get('/artists/:id/tracks', (req, res) => {
  res.json(tracks(q(`SELECT ${TRACK_COLS} ${TRACK_FROM} WHERE t.album_artist_id = $id OR t.artist_id = $id
    ORDER BY t.year, t.album_id, t.disc_no, t.track_no`).all({ uid: req.user.id, id: req.params.id })));
});

api.get('/tracks', (req, res) => {
  const { limit, offset } = page(req, 100);
  const order = TRACK_SORTS[req.query.sort] || TRACK_SORTS.title;
  res.json(tracks(q(`SELECT ${TRACK_COLS} ${TRACK_FROM} ORDER BY ${order} LIMIT $limit OFFSET $offset`)
    .all({ uid: req.user.id, limit, offset })));
});

api.get('/tracks/random', (req, res) => {
  const limit = int(req.query.limit, 100, 1, 500);
  res.json(tracks(q(`SELECT ${TRACK_COLS} ${TRACK_FROM} ORDER BY RANDOM() LIMIT $limit`).all({ uid: req.user.id, limit })));
});

api.get('/genres', (_req, res) => {
  res.json(q(`SELECT genre AS name, COUNT(*) AS trackCount, COUNT(DISTINCT album_id) AS albumCount, MAX(cover) AS cover
    FROM tracks WHERE genre IS NOT NULL AND genre != '' GROUP BY genre ORDER BY trackCount DESC`).all());
});

api.get('/search', (req, res) => {
  const term = String(req.query.q || '').trim();
  if (!term) return res.json({ tracks: [], albums: [], artists: [] });
  const like = `%${term.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
  res.json({
    artists: q(`SELECT album_artist_id AS id, MAX(album_artist) AS name, MAX(cover) AS cover, COUNT(DISTINCT album_id) AS albumCount
      FROM tracks WHERE album_artist LIKE ? ESCAPE '\\' GROUP BY album_artist_id ORDER BY COUNT(*) DESC LIMIT 8`).all(like),
    albums: q(`SELECT ${ALBUM_COLS} FROM tracks t WHERE t.album LIKE ? ESCAPE '\\' GROUP BY t.album_id LIMIT 12`).all(like),
    tracks: tracks(q(`SELECT ${TRACK_COLS} ${TRACK_FROM} WHERE t.title LIKE $like ESCAPE '\\'
      OR t.artist LIKE $like ESCAPE '\\' OR t.album LIKE $like ESCAPE '\\'
      ORDER BY (t.title LIKE $like ESCAPE '\\') DESC, t.title COLLATE NOCASE LIMIT 50`).all({ uid: req.user.id, like })),
  });
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
  res.json(tracks(q(`SELECT ${TRACK_COLS} FROM favorites f JOIN tracks t ON t.id = f.track_id
    WHERE f.user_id = $uid ORDER BY f.created_at DESC`).all({ uid: req.user.id })));
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
    LEFT JOIN favorites f ON f.track_id = t.id AND f.user_id = $uid WHERE pt.playlist_id = $pid ORDER BY pt.position`)
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
  saveConfig(patch);
  scheduleScans();
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
    const dirs = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$'))
      .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    const parent = path.dirname(dir);
    res.json({ path: dir, parent: parent === dir ? '' : parent, dirs });
  } catch (err) {
    res.status(400).json({ error: `Cannot open folder: ${err.code || err.message}` });
  }
});

admin.post('/scan', (req, res) => {
  if (scanStatus().running) return res.status(409).json({ error: 'A scan is already running' });
  scanLibrary({ full: !!req.body?.full });
  res.json(scanStatus());
});

admin.get('/scan', (_req, res) => res.json(scanStatus()));

api.use((_req, res) => res.status(404).json({ error: 'Not found' }));
