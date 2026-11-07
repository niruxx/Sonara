import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { q, tx } from './db.js';
import { COVERS_DIR, getConfig, saveConfig } from './config.js';
import { scanLibrary, scanStatus, scheduleScans, watchLibrary, saveCover, applyCoverOverrides, IMAGE_EXT } from './scanner.js';
import { tools } from './tools.js';
import { deliveryPlan, serveTranscoded, transcodeToFile, FORMATS, cacheStats, clearCache, enforceCacheLimit } from './transcode.js';
import { writeZip } from './zip.js';
import { getLyrics, setLyrics } from './lyrics.js';
import { radioTrackIds } from './radio.js';
import { cleanRules, buildWhere, SORTS as SMART_SORTS, catalogue as smartCatalogue, RuleError } from './smart.js';
import { nowPlaying, scrobble, publicServices, connectListenBrainz, setEnabled, disconnect, lastfmAuthUrl, finishLastfm, pendingCount } from './scrobble.js';
import { artistInfo, findMissingCovers, coverStatus } from './metadata.js';
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
  can, requirePermission, PERMISSIONS, newTotpSecret, verifyTotp, totpUri,
} from './auth.js';
import { oidcEnabled, startUrl as oidcStartUrl, finish as oidcFinish } from './oidc.js';
import {
  eventsHandler, stateHandler, commandHandler, devicesFor, nowPlayingFor, createParty, getParty, joinParty, leaveParty, requestSong, voteRequest, removeRequest,
} from './connect.js';
import { newShareId, signedStreamPath, signedCoverPath, lanBaseUrl } from './public.js';
import { parsePlaylist, matchEntries, exportPlaylist } from './playlists.js';
import { listBackups, backupPath, createBackup, deleteBackup, stageRestore, restorePending, cancelRestore, scheduleBackups } from './backup.js';
import { tailLog, log } from './logger.js';
import { setupJukebox, jukeboxStatus } from './jukebox.js';
import { setupDlna, dlnaStatus, discoverRenderers } from './dlna.js';
import { baseUrl } from './oidc.js';
import { DATA_DIR } from './config.js';
import { podcastsApi } from './podcasts.js';
import { stationsApi } from './stations.js';
import { analysisApi, similarIds, mixIds, mixList, analysisStatus, setAnalysisRunning } from './analysis.js';
import { bookmarksApi } from './bookmarks.js';
import { identify, fingerprintStatus } from './fingerprint.js';
import { discographyApi } from './discography.js';
import { historyApi } from './history.js';
import { setupSnapcast, snapcastStatus, snapcastRooms } from './snapcast.js';
import { webhooksApi, setupIntegrations, mqttStatus } from './integrations.js';
import { appPasswordsApi } from './apppasswords.js';

export const api = express.Router();
api.use(express.json({ limit: '1mb' }));

const int = (v, def, min = 0, max = 1000) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
const page = (req, def = 100) => ({ limit: int(req.query.limit, def, 1, 500), offset: int(req.query.offset, 0, 0, 1e9) });

/** Wrap async handlers: errors with .status become JSON responses. */
const h = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (err) {
    if (!err.status) console.error(err);
    if (!res.headersSent) res.status(err.status || 500).json({ error: err.message || 'Something went wrong' });
  }
};

// ───────────────────────── SQL fragments ─────────────────────────

const TRACK_COLS = `
  t.id, t.title, t.artist, t.artist_id AS artistId, t.album, t.album_id AS albumId,
  t.album_artist AS albumArtist, t.album_artist_id AS albumArtistId, t.track_no AS trackNo,
  t.disc_no AS discNo, t.year, t.original_year AS originalYear, t.genre, t.duration, t.bitrate,
  t.sample_rate AS sampleRate, t.codec, t.lossless, t.cover, t.added_at AS addedAt,
  t.release_type AS releaseType, t.compilation, t.needs_transcode AS needsTranscode, (t.cue_file IS NOT NULL) AS cue,
  t.rg_track_gain AS rgTrackGain, t.rg_track_peak AS rgTrackPeak, t.rg_album_gain AS rgAlbumGain, t.rg_album_peak AS rgAlbumPeak,
  ROUND(-18 - an.loudness, 2) AS calcTrackGain, an.peak AS calcPeak, an.album_gain AS calcAlbumGain, an.album_peak AS calcAlbumPeak,
  an.bpm, an.musical_key AS musicalKey, an.camelot, an.energy,
  (f.track_id IS NOT NULL) AS favorite, COALESCE(r.rating, 0) AS rating,
  COALESCE(pc.n, 0) AS playCount, pc.last AS lastPlayed,
  (SELECT json_group_array(json_array(ta.artist_id, ta.name, ta.position)) FROM track_artists ta
    WHERE ta.track_id = t.id AND ta.role = 'artist') AS artists`;
// Per-user joins every track query needs (bind $uid).
const TRACK_JOINS = `
  LEFT JOIN favorites f ON f.track_id = t.id AND f.user_id = $uid
  LEFT JOIN ratings r ON r.track_id = t.id AND r.user_id = $uid
  LEFT JOIN (SELECT track_id, COUNT(*) AS n, MAX(played_at) AS last FROM plays WHERE user_id = $uid GROUP BY track_id) pc
    ON pc.track_id = t.id
  LEFT JOIN track_analysis an ON an.track_id = t.id AND an.error IS NULL`;
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
  return { ...t, artists, favorite: !!t.favorite, lossless: !!t.lossless, compilation: !!t.compilation, needsTranscode: !!t.needsTranscode, cue: !!t.cue };
};
const tracks = (rows) => rows.map(fixTrack);
const idParam = (v) => int(v, 0, 0, Number.MAX_SAFE_INTEGER);

// Shared with the Subsonic API (subsonic.js).
export { TRACK_COLS, TRACK_JOINS, TRACK_FROM, ALBUM_COLS, ALBUM_USER_COLS, ALBUM_USER_JOINS, ARTIST_IMAGE, fixTrack, tracks as fixTracks, tracksByIds, smartTracks, int, idParam };

// ───────────────────────── Auth ─────────────────────────

api.get('/auth/status', (req, res) => {
  const c = getConfig();
  res.json({
    setupRequired: userCount() === 0, user: publicUser(req.user), sharing: c.sharing !== false,
    passwordLogin: c.passwordLogin !== false || userCount() === 0,
    oidc: oidcEnabled() ? { label: c.oidcLabel || 'Single sign-on' } : null,
  });
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
  const { username, password, code } = req.body || {};
  if (getConfig().passwordLogin === false) return res.status(403).json({ error: 'Password sign-in is turned off. Use single sign-on.' });
  const user = typeof username === 'string' && q('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || typeof password !== 'string' || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Incorrect username or password' });
  }
  if (user.totp_secret) {
    if (!code) return res.status(401).json({ error: 'Enter the 6-digit code from your authenticator app', needCode: true });
    if (!verifyTotp(user.totp_secret, code)) return res.status(401).json({ error: 'That code is not right. Codes change every 30 seconds.', needCode: true });
  }
  setSessionCookie(req, res, createSession(user.id));
  log.info(`[auth] ${user.username} signed in`);
  res.json({ user: publicUser(user) });
});

// Single sign-on (OpenID Connect)
api.get('/auth/oidc/start', h(async (req, res) => {
  if (!oidcEnabled()) return res.status(404).json({ error: 'Single sign-on is not set up' });
  res.redirect(await oidcStartUrl(req));
}));

api.get('/auth/oidc/callback', async (req, res) => {
  try {
    const user = await oidcFinish(req.query);
    setSessionCookie(req, res, createSession(user.id));
    log.info(`[auth] ${user.username} signed in with single sign-on`);
    res.redirect('/');
  } catch (err) {
    log.warn('[oidc] Sign-in failed:', err.message);
    res.redirect(`/?loginError=${encodeURIComponent(err.message)}`);
  }
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
  // Accounts created by single sign-on have no password yet and may set one.
  const hasPassword = String(req.user.password_hash).startsWith('scrypt$');
  if (hasPassword && !verifyPassword(String(current || ''), req.user.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  const problem = validateCredentials(req.user.username, password);
  if (problem) return res.status(400).json({ error: problem });
  q('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), req.user.id);
  q('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, req.sessionToken);
  res.json({ ok: true });
});

// ── Two-factor authentication
const totpSetups = new Map(); // userId -> { secret, at }

api.post('/me/2fa/setup', (req, res) => {
  if (req.user.totp_secret) return res.status(409).json({ error: 'Two-factor sign-in is already on' });
  const secret = newTotpSecret();
  totpSetups.set(req.user.id, { secret, at: Date.now() });
  res.json({ secret, uri: totpUri(secret, req.user.username) });
});

api.post('/me/2fa/enable', (req, res) => {
  const s = totpSetups.get(req.user.id);
  if (!s || Date.now() - s.at > 15 * 60000) return res.status(400).json({ error: 'Start the setup again' });
  if (!verifyTotp(s.secret, req.body?.code)) return res.status(400).json({ error: "That code didn't match. Check the time on your phone and try again." });
  q('UPDATE users SET totp_secret = ? WHERE id = ?').run(s.secret, req.user.id);
  totpSetups.delete(req.user.id);
  // Sign out other devices: they signed in without the second factor.
  q('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, req.sessionToken || '');
  log.info(`[auth] ${req.user.username} turned on two-factor sign-in`);
  res.json({ ok: true });
});

api.post('/me/2fa/disable', (req, res) => {
  if (!req.user.totp_secret) return res.json({ ok: true });
  if (!verifyTotp(req.user.totp_secret, req.body?.code)) return res.status(400).json({ error: 'Enter a current code from your authenticator app' });
  q('UPDATE users SET totp_secret = NULL WHERE id = ?').run(req.user.id);
  log.info(`[auth] ${req.user.username} turned off two-factor sign-in`);
  res.json({ ok: true });
});

// Friend activity: opt in to show others on this server what you're playing.
api.put('/me/activity-sharing', (req, res) => {
  q('UPDATE users SET share_activity = ? WHERE id = ?').run(req.body?.on ? 1 : 0, req.user.id);
  res.json({ ok: true, on: !!req.body?.on });
});

api.get('/activity', (req, res) => {
  const people = q('SELECT id, username FROM users WHERE share_activity = 1 AND id != ?').all(req.user.id);
  const visible = (id) => !!q('SELECT 1 FROM tracks WHERE id = ?').get(id); // respects this listener's folder access
  const out = [];
  for (const u of people) {
    const now = nowPlayingFor(u.id);
    if (now?.track?.id && visible(now.track.id)) { out.push({ user: u.username, playing: true, at: now.at, track: now.track }); continue; }
    const last = q(`SELECT p.played_at AS at, t.id, t.title, t.artist, t.artist_id AS artistId, t.album, t.album_id AS albumId, t.cover, t.duration
      FROM plays p JOIN tracks t ON t.id = p.track_id WHERE p.user_id = ? ORDER BY p.played_at DESC LIMIT 1`).get(u.id);
    if (last) out.push({ user: u.username, playing: false, at: last.at, track: { id: last.id, title: last.title, artist: last.artist, artistId: last.artistId, album: last.album, albumId: last.albumId, cover: last.cover, duration: last.duration } });
  }
  out.sort((a, b) => (a.playing === b.playing ? b.at - a.at : a.playing ? -1 : 1));
  res.json({ sharing: !!req.user.share_activity, friends: out });
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
      ${ARTIST_IMAGE('ta.artist_id', 'MAX(t.cover)')} AS cover, COUNT(p.id) AS plays
      FROM plays p JOIN tracks t ON t.id = p.track_id JOIN track_artists ta ON ta.track_id = t.id AND ta.role = 'artist'
      WHERE p.user_id = ? GROUP BY ta.artist_id
      ORDER BY plays DESC LIMIT 8`).all(uid),
    ...homeExtras(uid),
  });
});

/** "Continue listening", "On this day" and "Rediscover" home sections. */
function homeExtras(uid) {
  const DAY = 86400000;
  // Albums you started recently but didn't finish: resume after the furthest song you played.
  const partial = q(`SELECT t.album_id AS albumId, COUNT(DISTINCT p.track_id) AS heard, MAX(p.played_at) AS last
    FROM plays p JOIN tracks t ON t.id = p.track_id WHERE p.user_id = ? AND p.played_at > ?
    GROUP BY t.album_id ORDER BY last DESC LIMIT 30`).all(uid, Date.now() - 21 * DAY);
  const continueListening = [];
  for (const a of partial) {
    const list = q(`SELECT t.id, (SELECT MAX(played_at) FROM plays WHERE user_id = ? AND track_id = t.id) AS played FROM tracks t
      WHERE t.album_id = ? ORDER BY COALESCE(t.disc_no, 1), COALESCE(t.track_no, 9999), t.title COLLATE NOCASE`).all(uid, a.albumId);
    if (list.length < 3 || a.heard >= list.length) continue;
    // Resume after the most recently played song of the album.
    let lastIdx = -1, lastAt = 0;
    list.forEach((t, i) => { if (t.played && t.played > lastAt) { lastAt = t.played; lastIdx = i; } });
    if (lastIdx < 0 || lastIdx >= list.length - 1) continue;
    const album = q(`SELECT ${ALBUM_COLS} FROM tracks t WHERE t.album_id = ? GROUP BY t.album_id`).get(a.albumId);
    continueListening.push({ ...album, resumeIndex: lastIdx + 1, progress: (lastIdx + 1) / list.length });
    if (continueListening.length >= 8) break;
  }
  // Played on this calendar day in earlier years.
  const onThisDay = tracks(q(`SELECT ${TRACK_COLS}, MIN(CAST(strftime('%Y', p.played_at / 1000, 'unixepoch', 'localtime') AS INTEGER)) AS playedYear
    FROM plays p JOIN tracks t ON t.id = p.track_id ${TRACK_JOINS}
    WHERE p.user_id = $uid AND strftime('%m-%d', p.played_at / 1000, 'unixepoch', 'localtime') = strftime('%m-%d', 'now', 'localtime')
      AND strftime('%Y', p.played_at / 1000, 'unixepoch', 'localtime') < strftime('%Y', 'now', 'localtime')
    GROUP BY t.id ORDER BY COUNT(*) DESC, RANDOM() LIMIT 12`).all({ uid }));
  // Songs you loved (favorites, high ratings or many plays) but haven't heard in three months.
  const rediscover = tracks(q(`SELECT ${TRACK_COLS} ${TRACK_FROM}
    WHERE (f.track_id IS NOT NULL OR r.rating >= 4 OR pc.n >= 3) AND (pc.last IS NULL OR pc.last < $cutoff)
    ORDER BY RANDOM() LIMIT 12`).all({ uid, cutoff: Date.now() - 90 * DAY }));
  return { continueListening, onThisDay, rediscover };
}

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

const ARTIST_IMAGE = (idExpr, fallback) => `COALESCE((SELECT image FROM artist_images WHERE artist_id = ${idExpr}),
  (SELECT image FROM artist_info WHERE artist_id = ${idExpr}), ${fallback})`;

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
  const t = fixTrack(q(`SELECT ${TRACK_COLS}, COALESCE(t.cue_file, t.path) AS path, t.cue_start AS cueStart, t.cue_end AS cueEnd, t.size, t.mtime, t.mbz_track_id AS mbzTrackId, t.mbz_album_id AS mbzAlbumId,
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

const STREAM_COLS = 'id, path, mtime, size, bitrate, lossless, codec, sample_rate, needs_transcode, cue_file, cue_start, cue_end, title, artist, album, album_artist, track_no, disc_no, album_id';
const streamOpts = (req) => ({
  format: String(req.query.format || 'auto'),
  bitrate: int(req.query.bitrate, 0, 0, 1411),
  userMax: req.user.max_bitrate || 0,
  prefer: String(req.query.codec || 'opus'),
});

/**
 * ?format=auto|opus|mp3|aac|flac|raw &bitrate=kbps (0 = original) &wait=1 (wait for a full transcode; used for seeking)
 * Files the browser can play are sent as-is unless a bitrate limit applies.
 */
api.get('/stream/:id', async (req, res) => {
  const row = q(`SELECT ${STREAM_COLS} FROM tracks WHERE id = ?`).get(idParam(req.params.id));
  if (!row) return res.status(404).json({ error: 'Track not found' });
  try {
    const plan = deliveryPlan(row, streamOpts(req));
    if (plan) return await serveTranscoded(req, res, row, plan, { wait: req.query.wait === '1' });
  } catch (err) {
    if (!res.headersSent) res.status(err.status || 500).json({ error: err.message });
    return;
  }
  const type = MIME[path.extname(row.path).toLowerCase()];
  res.sendFile(row.path, { headers: type ? { 'Content-Type': type } : {}, dotfiles: 'allow', acceptRanges: true }, (err) => {
    if (err && !res.headersSent) res.status(err.status || 404).json({ error: 'File unavailable' });
  });
});

// ───────────────────────── Downloads ─────────────────────────

const cleanName = (s) => String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 150) || 'Untitled';
const disposition = (name) => `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'")}"; filename*=UTF-8''${encodeURIComponent(name)}`;

/** File to put in a download for a track: the original, or a transcode (?format=mp3&bitrate=320). */
async function downloadFile(row, req) {
  const opts = streamOpts(req);
  // Downloads default to the original file; cue tracks are cut out losslessly.
  const plan = deliveryPlan(row, { ...opts, format: opts.format === 'auto' ? 'raw' : opts.format });
  if (!plan) return { file: row.path, ext: path.extname(row.path) };
  return { file: await transcodeToFile(row, plan), ext: FORMATS[plan.format].ext };
}

const entryName = (row, ext, withDisc) => {
  const num = row.track_no ? `${withDisc && row.disc_no ? `${row.disc_no}-` : ''}${String(row.track_no).padStart(2, '0')} ` : '';
  return cleanName(`${num}${row.artist} - ${row.title}`) + ext;
};

api.get('/download/track/:id', requirePermission('download'), async (req, res) => {
  const row = q(`SELECT ${STREAM_COLS} FROM tracks WHERE id = ?`).get(idParam(req.params.id));
  if (!row) return res.status(404).json({ error: 'Track not found' });
  try {
    const { file, ext } = await downloadFile(row, req);
    res.setHeader('Content-Disposition', disposition(cleanName(`${row.artist} - ${row.title}`) + ext));
    res.sendFile(file, { dotfiles: 'allow' }, (err) => { if (err && !res.headersSent) res.status(404).json({ error: 'File unavailable' }); });
  } catch (err) {
    if (!res.headersSent) res.status(err.status || 500).json({ error: err.message });
  }
});

async function sendZip(req, res, rows, folder, cover) {
  const multiDisc = new Set(rows.map((r) => r.disc_no || 1)).size > 1;
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  // Resolve (and transcode) everything first so a failure can still be reported as an error.
  const entries = [];
  const used = new Set();
  try {
    for (const r of rows) {
      if (ac.signal.aborted) return;
      const { file, ext } = await downloadFile(r, req);
      let name = `${folder}/${entryName(r, ext, multiDisc)}`;
      for (let n = 2; used.has(name.toLowerCase()); n++) name = `${folder}/${entryName(r, ` (${n})${ext}`, multiDisc)}`;
      used.add(name.toLowerCase());
      entries.push({ name, path: file });
    }
  } catch (err) {
    if (!res.headersSent) res.status(err.status || 500).json({ error: err.message });
    return;
  }
  if (cover && fs.existsSync(path.join(COVERS_DIR, cover))) entries.push({ name: `${folder}/cover${path.extname(cover)}`, path: path.join(COVERS_DIR, cover) });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', disposition(`${folder}.zip`));
  try {
    await writeZip(res, entries, { signal: ac.signal });
    res.end();
  } catch {
    res.destroy();
  }
}

api.get('/download/album/:id', requirePermission('download'), async (req, res) => {
  const rows = q(`SELECT ${STREAM_COLS}, cover, year FROM tracks WHERE album_id = ? ORDER BY COALESCE(disc_no, 1), COALESCE(track_no, 9999), title`).all(req.params.id);
  if (!rows.length) return res.status(404).json({ error: 'Album not found' });
  const a = rows[0];
  await sendZip(req, res, rows, cleanName(`${a.album_artist} - ${a.album}${a.year ? ` (${a.year})` : ''}`), rows.find((r) => r.cover)?.cover);
});

api.get('/download/playlist/:id', requirePermission('download'), async (req, res) => {
  const pl = q(`SELECT id, name FROM playlists WHERE id = ? AND (user_id = ? OR visibility != 'private')`).get(idParam(req.params.id), req.user.id);
  if (!pl) return res.status(404).json({ error: 'Playlist not found' });
  const rows = q(`SELECT ${STREAM_COLS.split(', ').map((c) => 't.' + c).join(', ')}, pt.position FROM playlist_tracks pt
    JOIN tracks t ON t.id = pt.track_id WHERE pt.playlist_id = ? ORDER BY pt.position`).all(pl.id);
  if (!rows.length) return res.status(400).json({ error: 'This playlist is empty' });
  // Number playlist entries by their position instead of album track numbers.
  rows.forEach((r, i) => { r.track_no = i + 1; r.disc_no = null; });
  await sendZip(req, res, rows, cleanName(pl.name), null);
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

// ───────────────────────── Scrobbling ─────────────────────────

const SCROBBLE_COLS = 'id, title, artist, album, album_artist, track_no, duration, mbz_track_id';

api.post('/tracks/:id/nowplaying', (req, res) => {
  const t = q(`SELECT ${SCROBBLE_COLS} FROM tracks WHERE id = ?`).get(idParam(req.params.id));
  if (!t) return res.status(404).json({ error: 'Track not found' });
  nowPlaying(req.user.id, t);
  res.json({ ok: true });
});

// Sent by the player once a song has played for half its length or 4 minutes (the Last.fm rule).
api.post('/tracks/:id/scrobble', (req, res) => {
  const t = q(`SELECT ${SCROBBLE_COLS} FROM tracks WHERE id = ?`).get(idParam(req.params.id));
  if (!t) return res.status(404).json({ error: 'Track not found' });
  if (t.duration && t.duration < 30) return res.json({ ok: false, reason: 'too short' });
  const startedAt = Number(req.body?.startedAt);
  scrobble(req.user.id, t, Number.isFinite(startedAt) && startedAt > 0 && startedAt <= Date.now() ? startedAt : Date.now());
  res.json({ ok: true });
});

api.get('/me/services', (req, res) => res.json({ ...publicServices(req.user.id), pending: pendingCount(req.user.id) }));

api.put('/me/services/listenbrainz', h(async (req, res) => {
  res.json({ name: await connectListenBrainz(req.user.id, req.body?.token) });
}));

api.put('/me/services/:service/enabled', (req, res) => {
  setEnabled(req.user.id, req.params.service, !!req.body?.enabled);
  res.json(publicServices(req.user.id));
});

api.delete('/me/services/:service', (req, res) => {
  disconnect(req.user.id, String(req.params.service));
  res.json(publicServices(req.user.id));
});

// Last.fm web sign-in: we send the user to Last.fm, which returns to /api/lastfm/callback?token=…
api.get('/lastfm/connect', h(async (req, res) => {
  res.redirect(lastfmAuthUrl(`${req.protocol}://${req.get('host')}/api/lastfm/callback`));
}));

api.get('/lastfm/callback', h(async (req, res) => {
  try {
    await finishLastfm(req.user.id, String(req.query.token || ''));
    res.redirect('/settings?connected=lastfm');
  } catch (err) {
    res.redirect(`/settings?error=${encodeURIComponent(err.message)}`);
  }
}));

// ───────────────────────── Lyrics ─────────────────────────

const LYRIC_COLS = 'id, path, cue_file, mtime, title, artist, album, duration';

api.get('/tracks/:id/lyrics', h(async (req, res) => {
  const t = q(`SELECT ${LYRIC_COLS} FROM tracks WHERE id = ?`).get(idParam(req.params.id));
  if (!t) return res.status(404).json({ error: 'Track not found' });
  const l = await getLyrics(t, { refresh: req.query.refresh === '1' && !!req.user.is_admin });
  res.json(l ? { ...l, found: true } : { found: false, online: !!getConfig().onlineLyrics });
}));

// Admins can paste lyrics (plain or LRC). Stored in the database; files aren't changed.
api.put('/tracks/:id/lyrics', requireAdmin, (req, res) => {
  const t = q(`SELECT ${LYRIC_COLS} FROM tracks WHERE id = ?`).get(idParam(req.params.id));
  if (!t) return res.status(404).json({ error: 'Track not found' });
  setLyrics(t, String(req.body?.text || '').slice(0, 100000));
  res.json({ ok: true });
});

// ───────────────────────── Radio ─────────────────────────

// ?seed=track:12 | album:<id> | artist:<id> | genre:<name>  &exclude=1,2,3  &limit=50
/** Full track rows for ids, in the same order (missing ones dropped). */
function tracksByIds(uid, ids) {
  if (!ids?.length) return [];
  const rows = tracks(q(`SELECT ${TRACK_COLS} ${TRACK_FROM} WHERE t.id IN (SELECT value FROM json_each($ids))`).all({ uid, ids: JSON.stringify(ids) }));
  const byId = new Map(rows.map((t) => [t.id, t]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

// "Sounds like": nearest songs by their analysed sound.
api.get('/tracks/:id/similar', (req, res) => {
  const ids = similarIds(idParam(req.params.id), { limit: int(req.query.limit, 30, 1, 200) });
  if (ids == null) return res.status(409).json({ error: 'This song hasn’t been analysed yet. Play it once (or let the server analyse the library) and try again.' });
  res.json(tracksByIds(req.user.id, ids));
});

// Mood and time-of-day mixes.
api.get('/mixes', (req, res) => res.json(mixList(req.user.id)));
api.get('/mixes/:id', (req, res) => res.json(tracksByIds(req.user.id, mixIds(req.user.id, String(req.params.id), int(req.query.limit, 60, 1, 200)))));

api.get('/radio', h(async (req, res) => {
  const m = String(req.query.seed || '').match(/^(track|album|artist|genre|sound):(.+)$/);
  if (!m) return res.status(400).json({ error: 'Invalid seed' });
  const exclude = String(req.query.exclude || '').split(',').map(Number).filter(Boolean).slice(0, 3000);
  if (m[1] === 'sound') {
    const ids = similarIds(idParam(m[2]), { limit: int(req.query.limit, 50, 1, 200), exclude });
    if (ids == null) return res.status(409).json({ error: 'This song hasn’t been analysed yet. Play it once and try again.' });
    return res.json(tracksByIds(req.user.id, ids));
  }
  const ids = await radioTrackIds(req.user.id, { type: m[1], id: m[2] }, { limit: int(req.query.limit, 50, 1, 200), exclude });
  if (!ids.length) return res.json([]);
  const rows = tracks(q(`SELECT ${TRACK_COLS} ${TRACK_FROM} WHERE t.id IN (SELECT value FROM json_each($ids))`).all({ uid: req.user.id, ids: JSON.stringify(ids) }));
  const byId = new Map(rows.map((t) => [t.id, t]));
  res.json(ids.map((id) => byId.get(id)).filter(Boolean));
}));

// ───────────────────────── Sync (apps that keep an offline copy) ─────────────────────────

// Removed songs are remembered this long; a client that last synced earlier starts over.
export const TOMBSTONE_DAYS = 180;

/**
 * What changed in the library since a point in time, for apps that keep their own copy.
 * ?since=<ms, from the previous answer's `now`> &cursor=<from `next`> &limit=1-5000
 * Song ids are stable: re-tagging, re-scanning, and moving or renaming files (in Sonara or
 * outside it) keep them, so offline copies, favorites and playlists stay attached.
 */
api.get('/library/changes', (req, res) => {
  const now = Date.now();
  let since = Math.max(0, Number(req.query.since) || 0);
  const reset = since > 0 && since < now - TOMBSTONE_DAYS * 86400000;
  if (reset) since = 0;
  const limit = int(req.query.limit, 1000, 1, 5000);
  // Cursor "updatedAt:id" continues a page within the same sync.
  const [cAt, cId] = String(req.query.cursor || '').split(':').map(Number);
  const after = req.query.cursor && Number.isFinite(cAt) && Number.isFinite(cId) ? { at: cAt, id: cId } : { at: since, id: -1 };
  const rows = q(`SELECT ${TRACK_COLS}, t.updated_at AS updatedAt ${TRACK_FROM}
    WHERE t.updated_at > $at OR (t.updated_at = $at AND t.id > $id)
    ORDER BY t.updated_at, t.id LIMIT $lim`).all({ uid: req.user.id, at: after.at, id: after.id, lim: limit + 1 });
  const more = rows.length > limit;
  if (more) rows.pop();
  const last = rows.at(-1);
  res.json({
    now,
    reset, // true: drop everything you have and take this as the whole library
    tracks: tracks(rows),
    // Only on the first page of a sync, so paging doesn't repeat them.
    removed: since && !req.query.cursor ? q('SELECT track_id AS id FROM track_tombstones WHERE removed_at >= ?').all(since).map((r) => r.id) : [],
    favorites: req.query.cursor ? undefined : q('SELECT track_id AS id FROM favorites WHERE user_id = ?').all(req.user.id).map((r) => r.id),
    more,
    next: more ? `${last.updatedAt}:${last.id}` : null,
  });
});

// ───────────────────────── Smart playlists ─────────────────────────

const SMART_COLS = 'id, name, description, rules, sort, max_tracks AS maxTracks, created_at AS createdAt, updated_at AS updatedAt';
const smartRow = (row) => row && { ...row, rules: JSON.parse(row.rules), smart: true };

function smartTracks(uid, spec, sort, max, { countOnly = false } = {}) {
  const { where, params } = buildWhere(spec);
  if (countOnly) {
    const r = q(`SELECT COUNT(*) AS n, COALESCE(SUM(t.duration), 0) AS duration ${TRACK_FROM} ${where}`).get({ uid, ...params });
    return max ? { n: Math.min(r.n, max), duration: r.n > max ? null : r.duration } : r;
  }
  const order = SMART_SORTS[sort] || SMART_SORTS.random;
  return tracks(q(`SELECT ${TRACK_COLS} ${TRACK_FROM} ${where} ORDER BY ${order} LIMIT $lim`).all({ uid, ...params, lim: max || 5000 }));
}

function cleanSmart(b) {
  const name = String(b?.name || '').trim().slice(0, 100);
  if (!name) throw new RuleError('Name is required');
  return {
    name, description: String(b?.description || '').slice(0, 500), rules: cleanRules(b?.rules),
    sort: SMART_SORTS[b?.sort] ? b.sort : 'random', max: int(b?.maxTracks, 0, 0, 5000),
  };
}

api.get('/smart-playlists/fields', (_req, res) => res.json(smartCatalogue()));

api.get('/smart-playlists', (req, res) => {
  const rows = q(`SELECT ${SMART_COLS} FROM smart_playlists WHERE user_id = ? ORDER BY updated_at DESC`).all(req.user.id).map(smartRow);
  res.json(rows.map((p) => {
    try {
      const c = smartTracks(req.user.id, p.rules, p.sort, p.maxTracks, { countOnly: true });
      const covers = smartTracks(req.user.id, p.rules, 'added', 12).map((t) => t.cover).filter(Boolean);
      return { ...p, trackCount: c.n, duration: c.duration, covers: [...new Set(covers)].slice(0, 4) };
    } catch { return { ...p, trackCount: 0, covers: [] }; }
  }));
});

api.post('/smart-playlists/preview', h(async (req, res) => {
  const rules = cleanRules(req.body?.rules);
  const c = smartTracks(req.user.id, rules, 'random', int(req.body?.maxTracks, 0, 0, 5000), { countOnly: true });
  res.json({ count: c.n, sample: smartTracks(req.user.id, rules, req.body?.sort, 8) });
}));

api.post('/smart-playlists', h(async (req, res) => {
  const s = cleanSmart(req.body);
  const now = Date.now();
  const { lastInsertRowid } = q(`INSERT INTO smart_playlists (user_id, name, description, rules, sort, max_tracks, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(req.user.id, s.name, s.description, JSON.stringify(s.rules), s.sort, s.max, now, now);
  res.json(smartRow(q(`SELECT ${SMART_COLS} FROM smart_playlists WHERE id = ?`).get(Number(lastInsertRowid))));
}));

const ownSmart = (req) => smartRow(q(`SELECT ${SMART_COLS} FROM smart_playlists WHERE id = ? AND user_id = ?`).get(idParam(req.params.id), req.user.id));

api.get('/smart-playlists/:id', h(async (req, res) => {
  const p = ownSmart(req);
  if (!p) return res.status(404).json({ error: 'Playlist not found' });
  p.tracks = smartTracks(req.user.id, p.rules, p.sort, p.maxTracks);
  p.trackCount = p.tracks.length;
  p.duration = p.tracks.reduce((a, t) => a + (t.duration || 0), 0);
  p.covers = [...new Set(p.tracks.map((t) => t.cover).filter(Boolean))].slice(0, 4);
  res.json(p);
}));

api.put('/smart-playlists/:id', h(async (req, res) => {
  const p = ownSmart(req);
  if (!p) return res.status(404).json({ error: 'Playlist not found' });
  const s = cleanSmart({ ...p, ...req.body });
  q(`UPDATE smart_playlists SET name = ?, description = ?, rules = ?, sort = ?, max_tracks = ?, updated_at = ? WHERE id = ?`)
    .run(s.name, s.description, JSON.stringify(s.rules), s.sort, s.max, Date.now(), p.id);
  res.json({ ok: true });
}));

api.delete('/smart-playlists/:id', (req, res) => {
  q('DELETE FROM smart_playlists WHERE id = ? AND user_id = ?').run(idParam(req.params.id), req.user.id);
  res.json({ ok: true });
});

// ───────────────────────── Listening stats ─────────────────────────

// ?period=week|month|year|all|<YYYY>
api.get('/stats/listening', (req, res) => {
  const uid = req.user.id;
  const period = String(req.query.period || 'month');
  const now = new Date();
  let from = 0, to = Date.now() + 1;
  if (period === 'week') from = Date.now() - 7 * 86400000;
  else if (period === 'month') from = Date.now() - 30 * 86400000;
  else if (period === 'year') from = Date.now() - 365 * 86400000;
  else if (/^\d{4}$/.test(period)) { from = new Date(Number(period), 0, 1).getTime(); to = new Date(Number(period) + 1, 0, 1).getTime(); }
  const P = { uid, from, to };
  const W = 'p.user_id = $uid AND p.played_at >= $from AND p.played_at < $to';
  const totals = q(`SELECT COUNT(*) AS plays, COALESCE(SUM(t.duration), 0) AS seconds, COUNT(DISTINCT p.track_id) AS tracks,
    COUNT(DISTINCT t.album_id) AS albums, COUNT(DISTINCT t.artist_id) AS artists, MIN(p.played_at) AS first
    FROM plays p JOIN tracks t ON t.id = p.track_id WHERE ${W}`).get(P);
  const topArtists = q(`SELECT ta.artist_id AS id, MAX(ta.name) AS name, ${ARTIST_IMAGE('ta.artist_id', 'MAX(t.cover)')} AS cover,
    COUNT(*) AS plays, SUM(t.duration) AS seconds
    FROM plays p JOIN tracks t ON t.id = p.track_id JOIN track_artists ta ON ta.track_id = t.id AND ta.role = 'artist'
    WHERE ${W} GROUP BY ta.artist_id ORDER BY plays DESC LIMIT 10`).all(P);
  const topAlbums = q(`SELECT t.album_id AS id, MAX(t.album) AS name, MAX(t.album_artist) AS artist, t.album_artist_id AS artistId,
    MAX(t.cover) AS cover, MAX(t.year) AS year, COUNT(*) AS plays
    FROM plays p JOIN tracks t ON t.id = p.track_id WHERE ${W} GROUP BY t.album_id ORDER BY plays DESC LIMIT 10`).all(P);
  const topTracks = tracks(q(`SELECT ${TRACK_COLS}, COUNT(p.id) AS periodPlays FROM plays p JOIN tracks t ON t.id = p.track_id ${TRACK_JOINS}
    WHERE ${W} GROUP BY t.id ORDER BY periodPlays DESC LIMIT 10`).all(P));
  const topGenres = q(`SELECT g.genre AS name, COUNT(*) AS plays FROM plays p JOIN track_genres g ON g.track_id = p.track_id
    WHERE ${W} GROUP BY g.genre ORDER BY plays DESC LIMIT 8`).all(P);
  const byHour = Array(24).fill(0);
  for (const r of q(`SELECT CAST(strftime('%H', p.played_at / 1000, 'unixepoch', 'localtime') AS INTEGER) AS h, SUM(t.duration) AS s
    FROM plays p JOIN tracks t ON t.id = p.track_id WHERE ${W} GROUP BY h`).all(P)) byHour[r.h] = Math.round((r.s || 0) / 60);
  const byWeekday = Array(7).fill(0);
  for (const r of q(`SELECT CAST(strftime('%w', p.played_at / 1000, 'unixepoch', 'localtime') AS INTEGER) AS d, SUM(t.duration) AS s
    FROM plays p JOIN tracks t ON t.id = p.track_id WHERE ${W} GROUP BY d`).all(P)) byWeekday[r.d] = Math.round((r.s || 0) / 60);
  // Listening over time: per day for week/month, per month otherwise.
  const daily = period === 'week' || period === 'month';
  const fmt = daily ? '%Y-%m-%d' : '%Y-%m';
  const timeline = q(`SELECT strftime('${fmt}', p.played_at / 1000, 'unixepoch', 'localtime') AS bucket, SUM(t.duration) AS s, COUNT(*) AS plays
    FROM plays p JOIN tracks t ON t.id = p.track_id WHERE ${W} GROUP BY bucket ORDER BY bucket`).all(P)
    .map((r) => ({ bucket: r.bucket, minutes: Math.round((r.s || 0) / 60), plays: r.plays }));
  const years = q(`SELECT DISTINCT strftime('%Y', played_at / 1000, 'unixepoch', 'localtime') AS y FROM plays WHERE user_id = ? ORDER BY y DESC`).all(uid).map((r) => Number(r.y));
  res.json({ period, from: from || totals.first, to: Math.min(to, Date.now()), daily, totals, topArtists, topAlbums, topTracks, topGenres, byHour, byWeekday, timeline, years, now: now.getTime() });
});

// ───────────────────────── Artist info (online, optional) ─────────────────────────

api.get('/artists/:id/info', h(async (req, res) => {
  const a = q(`SELECT artist_id AS id, MAX(name) AS name FROM track_artists WHERE artist_id = ? GROUP BY artist_id`).get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Artist not found' });
  const info = await artistInfo(a.id, a.name, { refresh: req.query.refresh === '1' && !!req.user.is_admin });
  res.json(info ? { bio: info.bio, source: info.bio_source, url: info.url, image: info.image, mbid: info.mbid } : { bio: null, enabled: !!getConfig().onlineArtistInfo });
}));

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
  p.visibility, p.user_id AS ownerId, (SELECT username FROM users WHERE id = p.user_id) AS owner, (p.source_path IS NOT NULL) AS fromFile,
  (SELECT COUNT(*) FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id WHERE pt.playlist_id = p.id) AS trackCount,
  (SELECT SUM(t.duration) FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id WHERE pt.playlist_id = p.id) AS duration`;
const VISIBILITY = new Set(['private', 'public', 'collaborative']);

/** Owner: everything. Others: read public/collaborative playlists; edit the songs of collaborative ones. */
function withAccess(pl, user) {
  if (!pl) return pl;
  const own = pl.ownerId === user.id;
  const perm = can(user, 'playlists');
  pl.owned = own;
  pl.fromFile = !!pl.fromFile;
  // Playlists from .m3u files are rebuilt on every scan, so their songs aren't editable here.
  pl.canEdit = !pl.fromFile && perm && (own || pl.visibility === 'collaborative');
  pl.canManage = own && perm;
  return pl;
}

/** mode: 'read' | 'edit' (songs) | 'manage' (rename, delete, sharing). */
function ownPlaylist(req, res, mode = 'manage') {
  const pl = withAccess(q(`SELECT ${PLAYLIST_COLS} FROM playlists p WHERE p.id = ? AND (p.user_id = ? OR p.visibility != 'private')`)
    .get(int(req.params.id, 0, 0, Number.MAX_SAFE_INTEGER), req.user.id), req.user);
  if (!pl) { res.status(404).json({ error: 'Playlist not found' }); return null; }
  if ((mode === 'edit' && !pl.canEdit) || (mode === 'manage' && !pl.canManage)) {
    res.status(403).json({ error: pl.fromFile && mode === 'edit' ? 'This playlist comes from a file in your music folder. Edit the file instead.' : "You can't change this playlist" });
    return null;
  }
  return pl;
}

function playlistCovers(id) {
  return q(`SELECT DISTINCT t.cover FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
    WHERE pt.playlist_id = ? AND t.cover IS NOT NULL ORDER BY pt.position LIMIT 4`).all(id).map((r) => r.cover);
}

api.get('/playlists', (req, res) => {
  const rows = q(`SELECT ${PLAYLIST_COLS} FROM playlists p WHERE p.user_id = ? OR p.visibility != 'private'
    ORDER BY (p.user_id = ?) DESC, p.updated_at DESC`).all(req.user.id, req.user.id);
  res.json(rows.map((p) => ({ ...withAccess(p, req.user), covers: playlistCovers(p.id) })));
});

function newPlaylist(user, name, description = '') {
  const now = Date.now();
  const { lastInsertRowid } = q('INSERT INTO playlists (user_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(user.id, name, String(description || '').slice(0, 500), now, now);
  return Number(lastInsertRowid);
}

api.post('/playlists', requirePermission('playlists'), (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 100);
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const id = newPlaylist(req.user, name, req.body?.description);
  if (Array.isArray(req.body?.trackIds)) addToPlaylist(id, req.body.trackIds, req.user.id);
  res.json(withAccess(q(`SELECT ${PLAYLIST_COLS} FROM playlists p WHERE p.id = ?`).get(id), req.user));
});

// Import an M3U / M3U8 / XSPF file: raw file as the body, ?name=file.m3u
api.post('/playlists/import', requirePermission('playlists'), express.text({ type: () => true, limit: '5mb' }), (req, res) => {
  const fileName = String(req.query.name || 'Imported playlist');
  const text = typeof req.body === 'string' ? req.body : '';
  if (!text.trim()) return res.status(400).json({ error: 'That file is empty' });
  const { name, entries } = parsePlaylist(text, fileName);
  if (!entries.length) return res.status(400).json({ error: 'No songs found in that file' });
  const { ids, missing } = matchEntries(entries);
  if (!ids.length) return res.status(400).json({ error: `None of the ${entries.length} songs are in your library`, missing: missing.slice(0, 200) });
  const title = (name || fileName.replace(/\.(m3u8?|xspf|csv|tsv|txt)$/i, '')).trim().slice(0, 100) || 'Imported playlist';
  const id = newPlaylist(req.user, title, `Imported from ${fileName}`.slice(0, 500));
  addToPlaylist(id, ids, req.user.id);
  res.json({ id, name: title, matched: ids.length, total: entries.length, missing: missing.slice(0, 200) });
});

api.get('/playlists/:id', (req, res) => {
  const pl = ownPlaylist(req, res, 'read');
  if (!pl) return;
  pl.covers = playlistCovers(pl.id);
  pl.tracks = tracks(q(`SELECT ${TRACK_COLS}, pt.id AS entryId, (SELECT username FROM users WHERE id = pt.added_by) AS addedBy
    FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
    ${TRACK_JOINS} WHERE pt.playlist_id = $pid ORDER BY pt.position`)
    .all({ uid: req.user.id, pid: pl.id }));
  res.json(pl);
});

// ?format=m3u8 | m3u | xspf. Paths are relative to the music folder (absolute for admins with ?absolute=1).
api.get('/playlists/:id/export', (req, res) => {
  const pl = ownPlaylist(req, res, 'read');
  if (!pl) return;
  const format = ['m3u', 'm3u8', 'xspf'].includes(req.query.format) ? req.query.format : 'm3u8';
  const rows = q(`SELECT COALESCE(t.cue_file, t.path) AS path, t.title, t.artist, t.album, t.duration FROM playlist_tracks pt
    JOIN tracks t ON t.id = pt.track_id WHERE pt.playlist_id = ? ORDER BY pt.position`).all(pl.id);
  const roots = musicRoots();
  const absolute = !!req.user.is_admin && req.query.absolute === '1';
  const pathFor = (r) => {
    if (absolute) return r.path;
    const root = roots.find((d) => r.path.startsWith(d + path.sep));
    return root ? path.relative(root, r.path) : path.basename(r.path);
  };
  const body = exportPlaylist(pl.name, rows, format, { pathFor });
  res.setHeader('Content-Type', format === 'xspf' ? 'application/xspf+xml; charset=utf-8' : format === 'm3u8' ? 'audio/x-mpegurl; charset=utf-8' : 'audio/x-mpegurl');
  res.setHeader('Content-Disposition', disposition(`${cleanName(pl.name)}.${format}`));
  res.send(format === 'm3u' ? Buffer.from(body, 'latin1') : body);
});

api.put('/playlists/:id', (req, res) => {
  const pl = ownPlaylist(req, res, 'manage');
  if (!pl) return;
  const name = req.body?.name != null ? String(req.body.name).trim().slice(0, 100) : pl.name;
  const description = req.body?.description != null ? String(req.body.description).slice(0, 500) : pl.description;
  const visibility = VISIBILITY.has(req.body?.visibility) ? req.body.visibility : pl.visibility;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  q('UPDATE playlists SET name = ?, description = ?, visibility = ?, updated_at = ? WHERE id = ?').run(name, description, visibility, Date.now(), pl.id);
  res.json({ ok: true });
});

api.delete('/playlists/:id', (req, res) => {
  const pl = ownPlaylist(req, res, 'manage');
  if (!pl) return;
  q('DELETE FROM playlists WHERE id = ?').run(pl.id);
  q(`DELETE FROM shares WHERE kind = 'playlist' AND ref = ?`).run(String(pl.id));
  res.json({ ok: true });
});

function addToPlaylist(id, trackIds, by = null) {
  const ids = trackIds.map((n) => int(n, 0, 0, Number.MAX_SAFE_INTEGER)).filter(Boolean).slice(0, 5000);
  tx(() => {
    let pos = q('SELECT COALESCE(MAX(position), -1) AS p FROM playlist_tracks WHERE playlist_id = ?').get(id).p;
    const ins = q('INSERT INTO playlist_tracks (playlist_id, track_id, position, added_by) SELECT ?, id, ?, ? FROM tracks WHERE id = ?');
    for (const tid of ids) ins.run(id, ++pos, by, tid);
    q('UPDATE playlists SET updated_at = ? WHERE id = ?').run(Date.now(), id);
  });
  return ids.length;
}

api.post('/playlists/:id/tracks', (req, res) => {
  const pl = ownPlaylist(req, res, 'edit');
  if (!pl) return;
  if (!Array.isArray(req.body?.trackIds)) return res.status(400).json({ error: 'trackIds must be an array' });
  res.json({ added: addToPlaylist(pl.id, req.body.trackIds, req.user.id) });
});

api.delete('/playlists/:id/tracks/:entryId', (req, res) => {
  const pl = ownPlaylist(req, res, 'edit');
  if (!pl) return;
  q('DELETE FROM playlist_tracks WHERE id = ? AND playlist_id = ?').run(int(req.params.entryId, 0, 0, Number.MAX_SAFE_INTEGER), pl.id);
  q('UPDATE playlists SET updated_at = ? WHERE id = ?').run(Date.now(), pl.id);
  res.json({ ok: true });
});

// Reorder: body { entryIds: [...] } in the new order.
api.put('/playlists/:id/order', (req, res) => {
  const pl = ownPlaylist(req, res, 'edit');
  if (!pl) return;
  if (!Array.isArray(req.body?.entryIds)) return res.status(400).json({ error: 'entryIds must be an array' });
  tx(() => {
    const upd = q('UPDATE playlist_tracks SET position = ? WHERE id = ? AND playlist_id = ?');
    req.body.entryIds.forEach((eid, i) => upd.run(i, int(eid, 0, 0, Number.MAX_SAFE_INTEGER), pl.id));
    q('UPDATE playlists SET updated_at = ? WHERE id = ?').run(Date.now(), pl.id);
  });
  res.json({ ok: true });
});

// ───────────────────────── Share links ─────────────────────────

const SHARE_COLS = `id, kind, ref, title, description, allow_download AS allowDownload, expires_at AS expiresAt,
  created_at AS createdAt, views, last_viewed_at AS lastViewedAt`;
const shareOut = (req, s) => s && { ...s, allowDownload: !!s.allowDownload, url: `${baseUrl(req)}/s/${s.id}`, expired: !!(s.expiresAt && s.expiresAt < Date.now()) };

api.get('/shares', (req, res) => {
  res.json(q(`SELECT ${SHARE_COLS} FROM shares WHERE user_id = ? ORDER BY created_at DESC`).all(req.user.id).map((s) => shareOut(req, s)));
});

// Body: { kind: track|album|playlist, id, expiresInDays (0 = never), allowDownload, description }
api.post('/shares', requirePermission('share'), (req, res) => {
  if (!getConfig().sharing) return res.status(403).json({ error: 'Sharing is turned off on this server' });
  const b = req.body || {};
  const kind = ['track', 'album', 'playlist'].includes(b.kind) ? b.kind : null;
  if (!kind) return res.status(400).json({ error: 'Choose what to share' });
  let title;
  let ref = String(b.id ?? '');
  if (kind === 'track') {
    const t = q('SELECT id, title, artist FROM tracks WHERE id = ?').get(idParam(ref));
    if (!t) return res.status(404).json({ error: 'Track not found' });
    title = `${t.title} · ${t.artist}`;
    ref = String(t.id);
  } else if (kind === 'album') {
    const a = q('SELECT MAX(album) AS album, MAX(album_artist) AS artist FROM tracks WHERE album_id = ?').get(ref);
    if (!a?.album) return res.status(404).json({ error: 'Album not found' });
    title = `${a.album} · ${a.artist}`;
  } else {
    req.params.id = ref;
    const pl = ownPlaylist(req, res, 'read');
    if (!pl) return;
    title = pl.name;
    ref = String(pl.id);
  }
  const days = int(b.expiresInDays, 0, 0, 3650);
  const id = newShareId();
  const allowDownload = b.allowDownload && can(req.user, 'download') ? 1 : 0;
  q(`INSERT INTO shares (id, user_id, kind, ref, title, description, allow_download, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, req.user.id, kind, ref, title.slice(0, 200), String(b.description || '').slice(0, 500), allowDownload, days ? Date.now() + days * 86400000 : null, Date.now());
  res.json(shareOut(req, q(`SELECT ${SHARE_COLS} FROM shares WHERE id = ?`).get(id)));
});

api.put('/shares/:id', (req, res) => {
  const s = q('SELECT * FROM shares WHERE id = ?').get(String(req.params.id));
  if (!s || (s.user_id !== req.user.id && !req.user.is_admin)) return res.status(404).json({ error: 'Share not found' });
  const b = req.body || {};
  if (b.expiresInDays != null) {
    const days = int(b.expiresInDays, 0, 0, 3650);
    q('UPDATE shares SET expires_at = ? WHERE id = ?').run(days ? Date.now() + days * 86400000 : null, s.id);
  }
  if (b.allowDownload != null) q('UPDATE shares SET allow_download = ? WHERE id = ?').run(b.allowDownload && can(req.user, 'download') ? 1 : 0, s.id);
  if (b.description != null) q('UPDATE shares SET description = ? WHERE id = ?').run(String(b.description).slice(0, 500), s.id);
  res.json(shareOut(req, q(`SELECT ${SHARE_COLS} FROM shares WHERE id = ?`).get(s.id)));
});

api.delete('/shares/:id', (req, res) => {
  const s = q('SELECT user_id FROM shares WHERE id = ?').get(String(req.params.id));
  if (s && (s.user_id === req.user.id || req.user.is_admin)) q('DELETE FROM shares WHERE id = ?').run(String(req.params.id));
  res.json({ ok: true });
});

// ───────────────────────── Connect: remote control, casting, parties ─────────────────────────

api.get('/connect/events', eventsHandler);
api.post('/connect/state', stateHandler);
api.post('/connect/command', h(commandHandler));
api.get('/connect/devices', (req, res) => res.json(devicesFor(req.user, String(req.query.device || ''))));

// A stream URL a Chromecast can fetch without signing in (expires after a few hours).
api.post('/connect/cast-url', (req, res) => {
  const t = q('SELECT id, title, artist, album, cover FROM tracks WHERE id = ?').get(idParam(req.body?.trackId));
  if (!t) return res.status(404).json({ error: 'Track not found' });
  const base = lanBaseUrl(String(req.body?.peer || ''));
  const pub = getConfig().publicUrl ? getConfig().publicUrl.replace(/\/+$/, '') : base;
  res.json({
    url: pub + signedStreamPath(t.id, { format: req.body?.format === 'original' ? 'original' : 'mp3' }),
    contentType: req.body?.format === 'original' ? 'audio/*' : 'audio/mpeg',
    cover: t.cover ? pub + signedCoverPath(t.cover) : null,
  });
});

api.post('/party', createParty);
api.get('/party/:id', getParty);
api.post('/party/:id/join', joinParty);
api.post('/party/:id/leave', leaveParty);
api.post('/party/:id/requests', requestSong);
api.post('/party/:id/requests/:rid/vote', voteRequest);
api.delete('/party/:id/requests/:rid', removeRequest);

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
  if (req.body?.maxBitrate != null) {
    q('UPDATE users SET max_bitrate = ? WHERE id = ?').run(int(req.body.maxBitrate, 0, 0, 1411), id);
  }
  if (req.body?.permissions && typeof req.body.permissions === 'object') {
    const perms = {};
    for (const k of Object.keys(PERMISSIONS)) if (typeof req.body.permissions[k] === 'boolean') perms[k] = req.body.permissions[k];
    q('UPDATE users SET permissions = ? WHERE id = ?').run(JSON.stringify(perms), id);
  }
  if (req.body?.libraryDirs !== undefined) {
    // null = the whole library; otherwise a list of folders inside the music folders.
    let dirs = null;
    if (Array.isArray(req.body.libraryDirs)) {
      const roots = musicRoots();
      dirs = [...new Set(req.body.libraryDirs.map((d) => path.resolve(String(d).trim())).filter(Boolean))];
      const outside = dirs.find((d) => !roots.some((r) => d === r || d.startsWith(r + path.sep)));
      if (outside) return res.status(400).json({ error: `Not inside a music folder: ${outside}` });
      if (!dirs.length) return res.status(400).json({ error: 'Choose at least one folder, or allow the whole library' });
    }
    q('UPDATE users SET library_dirs = ? WHERE id = ?').run(dirs ? JSON.stringify(dirs) : null, id);
  }
  if (req.body?.resetTwoFactor) {
    q('UPDATE users SET totp_secret = NULL WHERE id = ?').run(id);
    log.info(`[auth] ${req.user.username} turned off two-factor sign-in for ${user.username}`);
  }
  res.json({ ok: true });
});

admin.delete('/users/:id', (req, res) => {
  const id = int(req.params.id, 0, 0, Number.MAX_SAFE_INTEGER);
  if (id === req.user.id) return res.status(400).json({ error: "You can't delete yourself" });
  q('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

admin.get('/settings', (req, res) => {
  const c = getConfig();
  res.json({
    musicDirs: c.musicDirs.map((d) => ({ path: d, exists: fs.existsSync(d) })),
    scanIntervalMinutes: c.scanIntervalMinutes,
    scanOnStartup: c.scanOnStartup,
    watch: c.watch !== false,
    allowFileChanges: !!c.allowFileChanges,
    transcodeCacheMB: c.transcodeCacheMB ?? 2048,
    onlineLyrics: !!c.onlineLyrics, onlineArtistInfo: !!c.onlineArtistInfo, onlineCovers: !!c.onlineCovers,
    onlinePodcastDirectory: !!c.onlinePodcastDirectory, onlineRadioDirectory: !!c.onlineRadioDirectory, onlineDiscography: !!c.onlineDiscography,
    podcastRefreshHours: Number(c.podcastRefreshHours ?? 6), podcastDownloadMB: Number(c.podcastDownloadMB) || 1024,
    analysis: c.analysis !== false,
    subsonic: c.subsonic !== false, subsonicMainPassword: c.subsonicMainPassword !== false,
    snapcast: !!c.snapcast, snapcastHost: c.snapcastHost || '127.0.0.1', snapcastPort: Number(c.snapcastPort) || 4953, snapcastStatus: snapcastStatus(),
    mqttUrl: c.mqttUrl ? String(c.mqttUrl).replace(/\/\/([^:@/]+):[^@/]*@/, '//$1:••••@') : '', mqttPrefix: c.mqttPrefix || 'sonara', mqttStatus: mqttStatus(),
    acoustidApiKey: c.acoustidApiKey || '', fingerprint: fingerprintStatus(),
    lastfmApiKey: c.lastfmApiKey || '', lastfmSecretSet: !!c.lastfmSecret, fanartApiKey: c.fanartApiKey || '', onlineContact: c.onlineContact || '',
    downloadsDir: inboxDir(),
    publicUrl: c.publicUrl || '', sharing: c.sharing !== false, importPlaylists: c.importPlaylists !== false,
    jukebox: !!c.jukebox, jukeboxStatus: jukeboxStatus(), dlna: !!c.dlna, dlnaFormat: c.dlnaFormat || 'mp3', dlnaStatus: dlnaStatus(),
    proxyAuthHeader: c.proxyAuthHeader || '', proxyAuthTrusted: [].concat(c.proxyAuthTrusted || []).join(', '), proxyAuthAutoCreate: !!c.proxyAuthAutoCreate,
    oidcIssuer: c.oidcIssuer || '', oidcClientId: c.oidcClientId || '', oidcClientSecretSet: !!c.oidcClientSecret, oidcLabel: c.oidcLabel || '',
    oidcUsernameClaim: c.oidcUsernameClaim || 'preferred_username', oidcAdminGroup: c.oidcAdminGroup || '', oidcAutoCreate: !!c.oidcAutoCreate,
    oidcRedirectUri: `${baseUrl(req)}/api/auth/oidc/callback`, passwordLogin: c.passwordLogin !== false,
    logFormat: c.logFormat || 'text', logRequests: !!c.logRequests, metrics: !!c.metrics, metricsTokenSet: !!c.metricsToken,
    backupIntervalHours: Number(c.backupIntervalHours) || 0, backupKeep: Number(c.backupKeep) || 10,
    dataDir: DATA_DIR, docker: fs.existsSync('/.dockerenv'),
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
  if (req.body?.transcodeCacheMB != null) patch.transcodeCacheMB = int(req.body.transcodeCacheMB, 2048, 0, 1024 * 1024);
  for (const k of ['onlineLyrics', 'onlineArtistInfo', 'onlineCovers', 'onlinePodcastDirectory', 'onlineRadioDirectory', 'onlineDiscography']) if (req.body?.[k] != null) patch[k] = !!req.body[k];
  if (req.body?.analysis != null) { patch.analysis = !!req.body.analysis; setTimeout(() => setAnalysisRunning(patch.analysis), 0); }
  if (req.body?.podcastRefreshHours != null) patch.podcastRefreshHours = int(req.body.podcastRefreshHours, 6, 0, 24 * 7);
  if (req.body?.podcastDownloadMB != null) patch.podcastDownloadMB = int(req.body.podcastDownloadMB, 1024, 16, 1024 * 64);
  for (const k of ['lastfmApiKey', 'lastfmSecret', 'fanartApiKey', 'onlineContact', 'acoustidApiKey']) if (req.body?.[k] != null) patch[k] = String(req.body[k]).trim().slice(0, 200);
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
  const b = req.body || {};
  if (b.snapcast != null) patch.snapcast = !!b.snapcast;
  if (b.snapcastHost != null) patch.snapcastHost = String(b.snapcastHost).trim().slice(0, 200) || '127.0.0.1';
  if (b.snapcastPort != null) patch.snapcastPort = int(b.snapcastPort, 4953, 1, 65535);
  if (b.mqttUrl != null && !String(b.mqttUrl).includes('••••')) patch.mqttUrl = String(b.mqttUrl).trim().slice(0, 500);
  if (b.mqttPrefix != null) patch.mqttPrefix = String(b.mqttPrefix).trim().replace(/[#+\s]/g, '').slice(0, 60) || 'sonara';
  for (const k of ['subsonic', 'subsonicMainPassword', 'sharing', 'importPlaylists', 'jukebox', 'dlna', 'proxyAuthAutoCreate', 'oidcAutoCreate', 'logRequests', 'metrics']) if (b[k] != null) patch[k] = !!b[k];
  for (const k of ['proxyAuthHeader', 'oidcIssuer', 'oidcClientId', 'oidcClientSecret', 'oidcLabel', 'oidcUsernameClaim', 'oidcAdminGroup', 'metricsToken', 'mpvPath']) {
    if (b[k] != null) patch[k] = String(b[k]).trim().slice(0, 500);
  }
  if (b.publicUrl != null) {
    const u = String(b.publicUrl).trim().replace(/\/+$/, '');
    if (u && !/^https?:\/\/[^\s/]+/.test(u)) return res.status(400).json({ error: 'The public address must start with http:// or https://' });
    patch.publicUrl = u;
  }
  if (b.proxyAuthTrusted != null) patch.proxyAuthTrusted = String(b.proxyAuthTrusted).split(/[\s,]+/).filter(Boolean).slice(0, 50);
  if (b.dlnaFormat != null) patch.dlnaFormat = b.dlnaFormat === 'original' ? 'original' : 'mp3';
  if (b.logFormat != null) patch.logFormat = b.logFormat === 'json' ? 'json' : 'text';
  if (b.backupIntervalHours != null) patch.backupIntervalHours = int(b.backupIntervalHours, 0, 0, 24 * 30);
  if (b.backupKeep != null) patch.backupKeep = int(b.backupKeep, 10, 1, 500);
  if (b.passwordLogin != null) {
    if (!b.passwordLogin && !oidcEnabled() && !(patch.proxyAuthHeader ?? getConfig().proxyAuthHeader)) {
      return res.status(400).json({ error: 'Set up single sign-on or proxy sign-in before turning off passwords, or nobody could sign in.' });
    }
    patch.passwordLogin = !!b.passwordLogin;
  }
  saveConfig(patch);
  if (patch.jukebox != null || patch.mpvPath != null) setupJukebox().catch(() => {});
  if (patch.dlna != null) setupDlna();
  if (patch.snapcast != null || patch.snapcastHost != null || patch.snapcastPort != null) {
    setupSnapcast({ restart: true }).catch(() => {});
  }
  if (patch.mqttUrl != null || patch.mqttPrefix != null) setupIntegrations();
  if (patch.backupIntervalHours != null) scheduleBackups();
  if (patch.transcodeCacheMB != null) enforceCacheLimit().catch(() => {});
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

admin.get('/scan/history', (_req, res) => {
  res.json(q(`SELECT id, started_at AS startedAt, finished_at AS finishedAt, full, found, added, updated, removed, errors, skipped,
    playlists, error FROM scan_history ORDER BY id DESC LIMIT 100`).all().map((r) => ({ ...r, full: !!r.full })));
});

// ───────────────────────── Operations: logs, backups, reports, speakers ─────────────────────────

admin.get('/logs', (req, res) => {
  res.json(tailLog({ limit: int(req.query.limit, 500, 1, 5000), level: String(req.query.level || ''), search: String(req.query.q || '') }));
});

admin.get('/backups', (_req, res) => res.json({ backups: listBackups(), restorePending: restorePending(), docker: fs.existsSync('/.dockerenv') }));
admin.post('/backups', h(async (_req, res) => res.json(createBackup())));
admin.get('/backups/:name', h(async (req, res) => {
  res.download(backupPath(req.params.name), req.params.name);
}));
admin.delete('/backups/:name', h(async (req, res) => { deleteBackup(req.params.name); res.json({ ok: true }); }));
admin.post('/backups/:name/restore', h(async (req, res) => res.json(await stageRestore({ name: req.params.name }))));
admin.delete('/restore', (_req, res) => { cancelRestore(); res.json({ ok: true }); });

// Upload a .db file to restore: raw body.
admin.post('/restore/upload', h(async (req, res) => {
  const tmp = path.join(DATA_DIR, `upload-${Date.now()}.db.tmp`);
  try {
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tmp);
      let size = 0;
      req.on('data', (c) => { size += c.length; if (size > 4 * 1024 ** 3) { req.destroy(); reject(Object.assign(new Error('File is too large'), { status: 413 })); } });
      req.pipe(out);
      out.on('finish', resolve);
      out.on('error', reject);
      req.on('error', reject);
    });
    res.json(await stageRestore({ uploadedFile: tmp }));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}));

// Exit so the service manager (systemd, launchd, Docker) starts Sonara again, applying a staged restore.
admin.post('/restart', (req, res) => {
  log.info(`[admin] Restart requested by ${req.user.username}`);
  res.json({ ok: true });
  // A non-zero exit code makes systemd (Restart=on-failure) and launchd (KeepAlive) start us again.
  setTimeout(() => process.emit('sonara:restart'), 300).unref();
});

admin.get('/reports/duplicates', (_req, res) => {
  // Same artist + title with similar length (within 3 s), or the same MusicBrainz recording.
  const groups = q(`SELECT lower(trim(artist)) AS a, lower(trim(title)) AS t, CAST(ROUND(duration / 3.0) AS INTEGER) AS d,
      json_group_array(id) AS ids, COUNT(*) AS n
    FROM tracks GROUP BY a, t, d HAVING n > 1 ORDER BY n DESC, a, t LIMIT 500`).all();
  const mbz = q(`SELECT mbz_track_id AS m, json_group_array(id) AS ids, COUNT(*) AS n FROM tracks
    WHERE mbz_track_id IS NOT NULL AND mbz_track_id != '' GROUP BY mbz_track_id HAVING n > 1 LIMIT 500`).all();
  const seen = new Set();
  const out = [];
  const detail = q(`SELECT id, title, artist, album, album_id AS albumId, duration, bitrate, codec, lossless, size, cover,
    COALESCE(cue_file, path) AS file FROM tracks WHERE id IN (SELECT value FROM json_each(?))`);
  for (const g of [...mbz.map((x) => ({ ...x, reason: 'Same MusicBrainz recording' })), ...groups.map((x) => ({ ...x, reason: 'Same artist, title and length' }))]) {
    const ids = JSON.parse(g.ids).sort((a, b) => a - b);
    const key = ids.join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    const rows = detail.all(JSON.stringify(ids)).map((r) => ({ ...r, lossless: !!r.lossless }));
    out.push({ reason: g.reason, tracks: rows });
    if (out.length >= 300) break;
  }
  res.json({ groups: out, total: out.reduce((a, g) => a + g.tracks.length - 1, 0) });
});

admin.get('/reports/missing', (_req, res) => {
  const checks = {
    cover: ['No cover art', 't.cover IS NULL'],
    year: ['No year', 't.year IS NULL OR t.year = 0'],
    genre: ['No genre', "t.genre IS NULL OR t.genre = ''"],
    trackNo: ['No track number', 't.track_no IS NULL'],
    artist: ['Unknown artist', "t.artist = 'Unknown Artist' OR t.artist = ''"],
    album: ['Unknown album', "t.album = 'Unknown Album' OR t.album = ''"],
    replayGain: ['No ReplayGain', 't.rg_track_gain IS NULL AND t.rg_album_gain IS NULL'],
    mbz: ['No MusicBrainz IDs', "t.mbz_track_id IS NULL OR t.mbz_track_id = ''"],
  };
  const out = {};
  for (const [k, [label, where]] of Object.entries(checks)) {
    const c = q(`SELECT COUNT(*) AS tracks, COUNT(DISTINCT t.album_id) AS albums FROM tracks t WHERE ${where}`).get();
    const albums = q(`SELECT t.album_id AS id, MAX(t.album) AS name, MAX(t.album_artist) AS artist, MAX(t.cover) AS cover, COUNT(*) AS n
      FROM tracks t WHERE ${where} GROUP BY t.album_id ORDER BY n DESC LIMIT 60`).all();
    out[k] = { label, tracks: c.tracks, albumCount: c.albums, albums };
  }
  res.json({ total: q('SELECT COUNT(*) AS n FROM tracks').get().n, checks: out });
});

admin.get('/shares', (req, res) => {
  res.json(q(`SELECT ${SHARE_COLS}, (SELECT username FROM users WHERE id = shares.user_id) AS owner FROM shares ORDER BY created_at DESC LIMIT 500`).all().map((s) => shareOut(req, s)));
});

admin.get('/speakers', (_req, res) => res.json({ jukebox: jukeboxStatus(), dlna: dlnaStatus() }));
admin.post('/speakers/discover', h(async (_req, res) => {
  if (!getConfig().dlna) return res.status(400).json({ error: 'Turn on network speakers first' });
  await discoverRenderers();
  res.json({ jukebox: jukeboxStatus(), dlna: dlnaStatus() });
}));

// ───────────────────────── Files: tags, moving, organizing ─────────────────────────

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
// Identify a song by its sound (Chromaprint + AcoustID).
admin.post('/tracks/:id/identify', h(async (req, res) => res.json(await identify(idParam(req.params.id)))));

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

// ───────── Album cover editing ─────────

/** Recognise JPEG / PNG / WebP by their first bytes. */
function imageType(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

function setAlbumCover(albumId, data) {
  const type = imageType(data);
  if (!type) throw Object.assign(new Error('Use a JPEG, PNG or WebP image'), { status: 400 });
  const cover = saveCover(data, type);
  q(`INSERT INTO cover_overrides (album_id, cover, created_at) VALUES (?, ?, ?)
    ON CONFLICT(album_id) DO UPDATE SET cover = excluded.cover, created_at = excluded.created_at`).run(albumId, cover, Date.now());
  applyCoverOverrides();
  log.info(`[covers] New cover for album ${albumId}`);
  return { cover };
}

const albumExists = (id) => !!q('SELECT 1 FROM tracks WHERE album_id = ? LIMIT 1').get(id);
const MAX_COVER = 20 * 1024 * 1024;

// Upload: raw image as the body.
admin.post('/albums/:id/cover', express.raw({ type: () => true, limit: MAX_COVER }), h(async (req, res) => {
  if (!albumExists(req.params.id)) return res.status(404).json({ error: 'Album not found' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'No image received' });
  res.json(setAlbumCover(req.params.id, req.body));
}));

// From a web address (the server downloads it) or an image file from the album's folder.
admin.post('/albums/:id/cover/from', h(async (req, res) => {
  if (!albumExists(req.params.id)) return res.status(404).json({ error: 'Album not found' });
  const { url, candidate } = req.body || {};
  if (candidate) {
    if (!/^[a-f0-9]{40}\.(jpg|png|webp)$/.test(String(candidate))) return res.status(400).json({ error: 'Invalid image' });
    return res.json(setAlbumCover(req.params.id, fs.readFileSync(path.join(COVERS_DIR, candidate))));
  }
  let u;
  try { u = new URL(String(url || '')); } catch { return res.status(400).json({ error: 'Enter a web address' }); }
  if (!['http:', 'https:'].includes(u.protocol)) return res.status(400).json({ error: 'Only http and https addresses work' });
  const r = await fetch(u, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'Sonara' } }).catch(() => null);
  if (!r?.ok) return res.status(400).json({ error: "Couldn't download that image" });
  if (Number(r.headers.get('content-length')) > MAX_COVER) return res.status(400).json({ error: 'That image is too large' });
  const data = Buffer.from(await r.arrayBuffer());
  if (data.length > MAX_COVER) return res.status(400).json({ error: 'That image is too large' });
  res.json(setAlbumCover(req.params.id, data));
}));

// Images to choose from: pictures in the album's folders, plus art found online earlier.
admin.get('/albums/:id/cover/candidates', h(async (req, res) => {
  const dirs = [...new Set(q('SELECT COALESCE(cue_file, path) AS p FROM tracks WHERE album_id = ?').all(req.params.id).map((r) => path.dirname(r.p)))];
  const out = [];
  for (const dir of dirs.slice(0, 5)) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!IMAGE_EXT.includes(path.extname(n).toLowerCase())) continue;
      try {
        const data = fs.readFileSync(path.join(dir, n));
        if (data.length > MAX_COVER || !imageType(data)) continue;
        out.push({ cover: saveCover(data, imageType(data)), name: n });
      } catch { /* unreadable */ }
      if (out.length >= 24) break;
    }
  }
  const online = q('SELECT cover FROM cover_lookups WHERE album_id = ? AND cover IS NOT NULL').get(req.params.id);
  if (online) out.push({ cover: online.cover, name: 'Cover Art Archive' });
  const override = q('SELECT cover FROM cover_overrides WHERE album_id = ?').get(req.params.id);
  res.json({ candidates: out.filter((c, i) => out.findIndex((x) => x.cover === c.cover) === i), custom: !!override });
}));

// Go back to the art from the files (rescans the album's files).
admin.delete('/albums/:id/cover', h(async (req, res) => {
  q('DELETE FROM cover_overrides WHERE album_id = ?').run(req.params.id);
  q('UPDATE tracks SET mtime = 0 WHERE album_id = ?').run(req.params.id);
  scanLibrary();
  res.json({ ok: true });
}));

admin.get('/covers', (_req, res) => res.json(coverStatus()));
admin.post('/covers', h(async (req, res) => {
  if (!getConfig().onlineCovers) return res.status(400).json({ error: 'Turn on cover art lookup first' });
  findMissingCovers({ all: !!req.body?.all }).catch(() => {});
  res.json(coverStatus());
}));

admin.get('/snapcast/rooms', h(async (_req, res) => res.json({ rooms: await snapcastRooms() })));

admin.get('/transcode', h(async (_req, res) => res.json(await cacheStats())));
admin.delete('/transcode', h(async (_req, res) => { await clearCache(); res.json(await cacheStats()); }));

admin.post('/inbox/jobs/:id/cancel', (req, res) => res.json({ ok: cancelJob(req.params.id) }));
admin.delete('/inbox/jobs', (_req, res) => { clearFinishedJobs(); res.json({ ok: true }); });

api.use(analysisApi);
api.use('/bookmarks', bookmarksApi);
api.use(discographyApi);
api.use('/me/history', historyApi);
api.use('/me/webhooks', webhooksApi);
api.use('/me/app-passwords', appPasswordsApi);
api.use('/podcasts', podcastsApi);
api.use('/stations', stationsApi);

api.use((_req, res) => res.status(404).json({ error: 'Not found' }));
