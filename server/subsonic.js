// Subsonic / OpenSubsonic API at /rest, for the apps people already use:
// Symfonium, DSub, Ultrasonic, Substreamer, play:Sub, Tempo, Feishin, Supersonic, Sonixd…
//
// API version 1.16.1 with the OpenSubsonic extensions listed in EXTENSIONS. Responses are
// XML by default, JSON with f=json (and JSONP with f=jsonp&callback=…).
//
// Signing in (any of):
//   apiKey=<app password>                         OpenSubsonic API key
//   u=<user>&t=md5(<app password> + s)&s=<salt>  token, needs an app password
//   u=<user>&p=<password>  (or p=enc:<hex>)       an app password, or the account password
//                                                 (when allowed; never with two-factor sign-in)
//
// Ids: songs are numbers ("123"); everything else has a prefix: al- albums, ar- artists,
// pl- playlists, sp- smart playlists, pc- podcasts, pe- podcast episodes, rs- radio stations.
// They're the same ids Sonara uses elsewhere, so they stay stable across rescans and moves.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { q, libraryScope } from './db.js';
import { COVERS_DIR, PODCASTS_DIR, getConfig } from './config.js';
import { log } from './logger.js';
import {
  TRACK_COLS, TRACK_FROM, ALBUM_COLS, ALBUM_USER_COLS, ALBUM_USER_JOINS, ARTIST_IMAGE, fixTrack, smartTracks, api,
} from './api.js';
import { verifyPassword, libraryDirsOf, can, permissionsOf, validateCredentials, hashPassword } from './auth.js';
import { findAppPassword, appPasswordByKey, touchAppPassword } from './apppasswords.js';
import { deliveryPlan, serveTranscoded, transcodeToFile, FORMATS } from './transcode.js';
import { scanLibrary, scanStatus } from './scanner.js';
import { nowPlaying as scrobbleNowPlaying, scrobble as scrobbleSend, services } from './scrobble.js';
import { getLyrics } from './lyrics.js';
import { artistInfo } from './metadata.js';
import { radioTrackIds } from './radio.js';
import { similarIds } from './analysis.js';
import { nowPlayingFor } from './connect.js';
import { addPodcast, refreshPodcast, removeIfOrphan, queueDownload } from './podcasts.js';
import { newShareId } from './public.js';
import { baseUrl } from './oidc.js';

export const API_VERSION = '1.16.1';
const SERVER_VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const EXTENSIONS = [
  { name: 'apiKeyAuthentication', versions: [1] },
  { name: 'formPost', versions: [1] },
  { name: 'songLyrics', versions: [1] },
  { name: 'getPodcastEpisode', versions: [1] },
  { name: 'indexBasedQueue', versions: [1] },
];

// ───────────────────────── Errors and responses ─────────────────────────

class SubsonicError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new SubsonicError(code, message); };
const notFound = (what = 'Item') => fail(70, `${what} not found`);
const missing = (name) => fail(10, `Required parameter is missing: ${name}`);

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ESC[c]);

/**
 * JSON-shaped payload → Subsonic XML: scalars become attributes, objects and arrays become
 * child elements (one per array item), and a scalar `value` becomes the element's text.
 */
function toXml(name, obj, root = false) {
  const attrs = root ? [' xmlns="http://subsonic.org/restapi"'] : [];
  const kids = [];
  let text = null;
  for (const [k, v] of Object.entries(obj || {})) {
    if (v == null) continue;
    if (k === 'value' && typeof v !== 'object') { text = v; continue; }
    if (Array.isArray(v)) {
      for (const item of v) kids.push(item && typeof item === 'object' ? toXml(k, item) : `<${k}>${esc(item)}</${k}>`);
    } else if (typeof v === 'object') kids.push(toXml(k, v));
    else attrs.push(` ${k}="${esc(v)}"`);
  }
  const inner = kids.join('') + (text != null ? esc(text) : '');
  return inner ? `<${name}${attrs.join('')}>${inner}</${name}>` : `<${name}${attrs.join('')}/>`;
}

function send(req, res, body = {}, status = 'ok') {
  const payload = { status, version: API_VERSION, type: 'sonara', serverVersion: SERVER_VERSION, openSubsonic: true, ...body };
  const f = String(param(req, 'f') || 'xml');
  if (f === 'json' || f === 'jsonp') {
    const json = JSON.stringify({ 'subsonic-response': payload });
    const cb = String(param(req, 'callback') || '');
    if (f === 'jsonp' && /^[\w$.]{1,100}$/.test(cb)) return res.type('application/javascript').send(`${cb}(${json});`);
    return res.type('application/json').send(json);
  }
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>${toXml('subsonic-response', payload, true)}`);
}

// ───────────────────────── Parameters ─────────────────────────

// Parameters come in the query string or (OpenSubsonic formPost) a form body, and may repeat.
function all(req, name) {
  const out = [];
  for (const src of [req.query, req.body]) {
    const v = src?.[name];
    if (v == null) continue;
    out.push(...(Array.isArray(v) ? v : [v]).map(String));
  }
  return out;
}
const param = (req, name) => all(req, name)[0];
const need = (req, name) => { const v = param(req, name); if (v == null || v === '') missing(name); return v; };
const num = (req, name, def, min = 0, max = 1e9) => {
  const n = Number.parseInt(param(req, name), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
const bool = (req, name, def = false) => {
  const v = param(req, name);
  return v == null ? def : v === 'true' || v === '1';
};

// ───────────────────────── Ids ─────────────────────────

const PREFIX = { al: 'album', ar: 'artist', pl: 'playlist', sp: 'smart', pc: 'podcast', pe: 'episode', rs: 'station' };
function parseId(id) {
  const s = String(id ?? '');
  if (/^\d+$/.test(s)) return { kind: 'song', id: Number(s) };
  const m = s.match(/^([a-z]{2})-(.+)$/);
  if (m && PREFIX[m[1]]) return { kind: PREFIX[m[1]], id: m[2] };
  return { kind: null, id: s };
}
const songId = (s) => { const p = parseId(s); if (p.kind !== 'song') notFound('Song'); return p.id; };

// ───────────────────────── Shapes ─────────────────────────

const iso = (ms) => (ms ? new Date(Number(ms)).toISOString() : undefined);
const secs = (d) => (d ? Math.round(d) : 0);
const AUDIO_MIME = {
  mp3: 'audio/mpeg', flac: 'audio/flac', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg',
  opus: 'audio/ogg', wav: 'audio/wav', webm: 'audio/webm', wma: 'audio/x-ms-wma', ape: 'audio/x-ape', wv: 'audio/x-wavpack',
  aif: 'audio/aiff', aiff: 'audio/aiff', dsf: 'audio/x-dsf', dff: 'audio/x-dff', alac: 'audio/mp4',
};
const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|]/g, '_').trim() || 'Unknown';

// Extra per-song columns the Subsonic shapes need, on top of the web app's TRACK_COLS.
const SONG_COLS = `${TRACK_COLS}, COALESCE(t.cue_file, t.path) AS file, t.cue_file AS cueFile, t.size, t.mbz_track_id AS mbzTrackId,
  f.created_at AS starredAt,
  (SELECT json_group_array(g.genre) FROM track_genres g WHERE g.track_id = t.id) AS genresJson,
  (SELECT json_group_array(json_array(ta.artist_id, ta.name)) FROM (SELECT * FROM track_artists WHERE track_id = t.id AND role = 'album' ORDER BY position) ta) AS albumArtistsJson`;
const SONG_FROM = TRACK_FROM;
const json = (s, def) => { try { return JSON.parse(s) ?? def; } catch { return def; } };

/** How stream?id= delivers a song when the app asks for nothing in particular. */
function defaultPlan(t) {
  return deliveryPlan({ needs_transcode: t.needsTranscode, cue_file: t.cueFile, lossless: t.lossless, bitrate: t.bitrate },
    { format: 'auto', prefer: 'mp3' });
}

function song(row) {
  const t = fixTrack(row);
  const ext = path.extname(t.file || '').slice(1).toLowerCase();
  const plan = defaultPlan(t);
  const outExt = plan ? FORMATS[plan.format].ext.slice(1) : ext;
  // Songs cut out of a cue sheet only exist as transcodes: describe what the app will get.
  const suffix = t.cueFile ? outExt : ext;
  const size = t.cueFile ? Math.round((t.duration || 0) * (plan?.bitrate || 900) * 125) : t.size;
  const albumArtists = json(t.albumArtistsJson, []).map(([id, name]) => ({ id: `ar-${id}`, name }));
  const genres = json(t.genresJson, []).filter(Boolean);
  const trackGain = t.rgTrackGain ?? t.calcTrackGain;
  const albumGain = t.rgAlbumGain ?? t.calcAlbumGain;
  const out = {
    id: String(t.id),
    parent: `al-${t.albumId}`,
    isDir: false,
    title: t.title,
    album: t.album,
    artist: t.artist,
    track: t.trackNo || undefined,
    year: t.year || undefined,
    genre: genres[0] || t.genre || undefined,
    coverArt: t.cover ? `al-${t.albumId}` : undefined,
    size: size || undefined,
    contentType: AUDIO_MIME[suffix] || 'audio/mpeg',
    suffix,
    transcodedContentType: plan && !t.cueFile ? FORMATS[plan.format].mime.split(';')[0] : undefined,
    transcodedSuffix: plan && !t.cueFile ? outExt : undefined,
    duration: secs(t.duration),
    bitRate: t.bitrate ? Math.round(t.bitrate / 1000) : undefined,
    samplingRate: t.sampleRate || undefined,
    path: `${safeName(t.albumArtist)}/${safeName(t.album)}/${t.trackNo ? `${String(t.trackNo).padStart(2, '0')} - ` : ''}${safeName(t.title)}.${suffix}`,
    isVideo: false,
    playCount: t.playCount || 0,
    played: iso(t.lastPlayed),
    discNumber: t.discNo || undefined,
    created: iso(t.addedAt),
    starred: t.favorite ? iso(t.starredAt || t.addedAt) : undefined,
    userRating: t.rating || undefined,
    albumId: `al-${t.albumId}`,
    artistId: `ar-${t.artistId}`,
    type: 'music',
    mediaType: 'song',
    bpm: t.bpm ? Math.round(t.bpm) : undefined,
    musicBrainzId: t.mbzTrackId || undefined,
    genres: genres.map((name) => ({ name })),
    artists: t.artists.map((a) => ({ id: `ar-${a.id}`, name: a.name })),
    displayArtist: t.artist,
    albumArtists: albumArtists.length ? albumArtists : [{ id: `ar-${t.albumArtistId}`, name: t.albumArtist }],
    displayAlbumArtist: t.albumArtist,
    replayGain: trackGain != null || albumGain != null ? {
      trackGain: trackGain ?? undefined, albumGain: albumGain ?? undefined,
      trackPeak: t.rgTrackPeak ?? t.calcPeak ?? undefined, albumPeak: t.rgAlbumPeak ?? t.calcAlbumPeak ?? undefined,
    } : undefined,
  };
  return out;
}

const songs = (uid, where, params = {}, tail = '') =>
  q(`SELECT ${SONG_COLS} ${SONG_FROM} ${where} ${tail}`).all({ uid, ...params }).map(song);

/** Songs by id, in the order given, skipping missing ones. */
function songsByIds(uid, ids) {
  if (!ids.length) return [];
  const rows = songs(uid, 'WHERE t.id IN (SELECT value FROM json_each($ids))', { ids: JSON.stringify(ids) });
  const byId = new Map(rows.map((s) => [Number(s.id), s]));
  return ids.map((id) => byId.get(Number(id))).filter(Boolean);
}

const ALBUM_STAR = `(SELECT created_at FROM starred_items s WHERE s.user_id = $uid AND s.kind = 'album' AND s.item_id = t.album_id) AS starredAt`;
const ALBUM_SELECT = `SELECT ${ALBUM_COLS} ${ALBUM_USER_COLS}, ${ALBUM_STAR} FROM tracks t ${ALBUM_USER_JOINS}`;

function album(a) {
  const type = a.compilation ? 'compilation' : a.releaseType || 'album';
  return {
    id: `al-${a.id}`,
    name: a.name,
    artist: a.artist,
    artistId: `ar-${a.artistId}`,
    coverArt: a.cover ? `al-${a.id}` : undefined,
    songCount: a.trackCount,
    duration: secs(a.duration),
    playCount: a.playCount || 0,
    played: iso(a.lastPlayed),
    created: iso(a.addedAt),
    year: a.year || undefined,
    genre: a.genre || undefined,
    genres: a.genre ? [{ name: a.genre }] : [],
    starred: iso(a.starredAt),
    userRating: a.rating ? Math.round(a.rating) : undefined,
    isCompilation: !!a.compilation,
    releaseTypes: [type[0].toUpperCase() + type.slice(1)],
    originalReleaseDate: a.originalYear ? { year: a.originalYear } : undefined,
    displayArtist: a.artist,
    artists: [{ id: `ar-${a.artistId}`, name: a.artist }],
    sortName: a.name,
  };
}

/** An album as a folder ("Child" with isDir), for the folder-style calls. */
const albumDir = (a) => ({
  id: `al-${a.id}`, parent: `ar-${a.artistId}`, isDir: true, title: a.name, name: a.name, album: a.name, artist: a.artist,
  year: a.year || undefined, genre: a.genre || undefined, coverArt: a.cover ? `al-${a.id}` : undefined,
  created: iso(a.addedAt), starred: iso(a.starredAt), playCount: a.playCount || 0, duration: secs(a.duration),
  songCount: a.trackCount, artistId: `ar-${a.artistId}`, mediaType: 'album',
});

const ARTIST_SELECT = `SELECT t.album_artist_id AS id, MAX(t.album_artist) AS name, ${ARTIST_IMAGE('t.album_artist_id', 'MAX(t.cover)')} AS cover,
  COUNT(DISTINCT t.album_id) AS albumCount,
  (SELECT created_at FROM starred_items s WHERE s.user_id = $uid AND s.kind = 'artist' AND s.item_id = t.album_artist_id) AS starredAt
  FROM tracks t`;

const artist = (a) => ({
  id: `ar-${a.id}`, name: a.name, coverArt: `ar-${a.id}`, albumCount: a.albumCount || 0, starred: iso(a.starredAt),
  sortName: a.name, roles: ['albumartist'],
});

// ───────────────────────── Folders and indexes ─────────────────────────

const ARTICLES = ['The', 'El', 'La', 'Los', 'Las', 'Le', 'Les'];
const IGNORED_ARTICLES = ARTICLES.join(' ');
function indexKey(name) {
  let n = String(name || '').trim();
  for (const a of ARTICLES) if (n.toLowerCase().startsWith(`${a.toLowerCase()} `)) { n = n.slice(a.length + 1); break; }
  const c = n.normalize('NFD').replace(/[̀-ͯ]/g, '').charAt(0).toUpperCase();
  return /\p{L}/u.test(c) ? c : '#';
}
function grouped(list, shape) {
  const map = new Map();
  for (const a of list) {
    const k = indexKey(a.name);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(shape(a));
  }
  return [...map].sort(([a], [b]) => (a === '#') - (b === '#') || a.localeCompare(b)).map(([name, artist]) => ({ name, artist }));
}

const isUnder = (p, dir) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);

/** Music folders this user can see: [{ id, name, path }]. */
function musicFolders(user) {
  const dirs = libraryDirsOf(user);
  return getConfig().musicDirs.map((d, i) => ({ id: i + 1, name: path.basename(d) || d, path: path.resolve(d) }))
    .filter((f) => !dirs || dirs.some((d) => isUnder(d, f.path) || isUnder(f.path, d)));
}

/** Run fn with the library narrowed to one music folder (musicFolderId), on top of the user's own limits. */
function inFolder(req, fn) {
  const id = num(req, 'musicFolderId', null, 1);
  if (id == null) return fn();
  const folder = musicFolders(req.user).find((f) => f.id === id);
  if (!folder) notFound('Music folder');
  const userDirs = libraryDirsOf(req.user);
  const dirs = userDirs ? userDirs.filter((d) => isUnder(d, folder.path)).concat(userDirs.some((d) => isUnder(folder.path, d)) ? [folder.path] : []) : [folder.path];
  return libraryScope.run({ dirs: dirs.length ? dirs : ['\u0000'], userId: req.user.id }, fn);
}

const lastModified = () => Math.max(
  q('SELECT MAX(updated_at) AS m FROM tracks').get().m || 0,
  q('SELECT MAX(removed_at) AS m FROM track_tombstones').get().m || 0,
);

// ───────────────────────── Now playing (for getNowPlaying) ─────────────────────────

const playingNow = new Map(); // userId -> { trackId, at, client }
function notePlaying(user, trackId, client) {
  playingNow.set(user.id, { trackId: Number(trackId), at: Date.now(), client: String(client || 'Subsonic app').slice(0, 60) });
}

// ───────────────────────── Playlists ─────────────────────────

const PLAYLIST_SELECT = `SELECT p.id, p.name, p.description, p.user_id AS ownerId, u.username AS owner, p.visibility,
  p.created_at AS createdAt, p.updated_at AS updatedAt,
  (SELECT COUNT(*) FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id WHERE pt.playlist_id = p.id) AS songCount,
  (SELECT COALESCE(SUM(t.duration), 0) FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id WHERE pt.playlist_id = p.id) AS duration
  FROM playlists p JOIN users u ON u.id = p.user_id`;

const playlistShape = (p, user) => ({
  id: `pl-${p.id}`, name: p.name, comment: p.description || undefined, owner: p.owner, public: p.visibility !== 'private',
  songCount: p.songCount, duration: secs(p.duration), created: iso(p.createdAt), changed: iso(p.updatedAt), coverArt: `pl-${p.id}`,
  readonly: !(p.ownerId === user.id || p.visibility === 'collaborative'),
});

function playlistFor(user, rawId, mode = 'read') {
  const { kind, id } = parseId(rawId);
  if (kind !== 'playlist') notFound('Playlist');
  const p = q(`${PLAYLIST_SELECT} WHERE p.id = ?`).get(Number(id));
  if (!p) notFound('Playlist');
  const own = p.ownerId === user.id;
  if (!own && p.visibility === 'private') notFound('Playlist');
  if (mode === 'edit' && !(own || p.visibility === 'collaborative')) fail(50, 'Only its owner can change this playlist');
  if (mode === 'manage' && !own) fail(50, 'Only its owner can do that');
  if (mode !== 'read' && !can(user, 'playlists')) fail(50, 'You don’t have permission to edit playlists');
  return p;
}

const SMART_SELECT = `SELECT s.id, s.name, s.description, s.rules, s.sort, s.max_tracks AS maxTracks, s.created_at AS createdAt,
  s.updated_at AS updatedAt, u.username AS owner FROM smart_playlists s JOIN users u ON u.id = s.user_id`;

function setPlaylistTracks(playlistId, ids, by) {
  q('DELETE FROM playlist_tracks WHERE playlist_id = ?').run(playlistId);
  const ins = q('INSERT INTO playlist_tracks (playlist_id, track_id, position, added_by) VALUES (?, ?, ?, ?)');
  ids.forEach((tid, i) => ins.run(playlistId, tid, i, by));
  q('UPDATE playlists SET updated_at = ? WHERE id = ?').run(Date.now(), playlistId);
}

const existingSongIds = (ids) => {
  if (!ids.length) return [];
  const ok = new Set(q('SELECT id FROM tracks WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids)).map((r) => r.id));
  return ids.filter((id) => ok.has(id));
};

// ───────────────────────── Podcasts and radio ─────────────────────────

const EPISODE_SELECT = `SELECT e.id, e.podcast_id AS podcastId, p.title AS podcast, p.image AS cover, e.title, e.description,
  e.published_at AS publishedAt, e.duration, e.mime, e.size, e.file IS NOT NULL AS downloaded,
  COALESCE(pp.position, 0) AS position FROM podcast_episodes e JOIN podcasts p ON p.id = e.podcast_id
  LEFT JOIN podcast_progress pp ON pp.episode_id = e.id AND pp.user_id = $uid`;

const episodeShape = (e) => {
  const suffix = (String(e.mime || '').match(/\/(?:x-)?(\w+)/)?.[1] || 'mp3').replace('mpeg', 'mp3');
  return {
    id: `pe-${e.id}`, streamId: `pe-${e.id}`, channelId: `pc-${e.podcastId}`, parent: `pc-${e.podcastId}`, isDir: false,
    title: e.title, album: e.podcast, artist: e.podcast, description: e.description || undefined,
    // Sonara streams any episode (downloaded or straight from the feed), so every one is playable.
    status: 'completed', publishDate: iso(e.publishedAt), duration: secs(e.duration), size: e.size || undefined,
    contentType: e.mime || 'audio/mpeg', suffix, coverArt: e.cover ? `pc-${e.podcastId}` : undefined,
    type: 'podcast', mediaType: 'podcast', isVideo: false,
  };
};

// ───────────────────────── Media helpers ─────────────────────────

const STREAM_COLS = 'id, path, mtime, size, bitrate, lossless, codec, sample_rate, needs_transcode, cue_file, cue_start, cue_end, title, artist, album, album_artist, track_no, disc_no, album_id';
const MIME_BY_EXT = { '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav' };

function sendOriginal(res, file) {
  const type = MIME_BY_EXT[path.extname(file).toLowerCase()];
  return new Promise((resolve) => {
    res.sendFile(file, { headers: type ? { 'Content-Type': type } : {}, dotfiles: 'allow', acceptRanges: true }, (err) => {
      if (err && !res.headersSent) res.status(err.status || 404).end();
      resolve();
    });
  });
}

/** Hand a request to one of the web app's own routes (podcast episode streams), keeping the signed-in user. */
function delegate(req, res, url) {
  return new Promise((resolve) => {
    req.url = url;
    res.on('finish', resolve).on('close', resolve);
    api(req, res, () => { if (!res.headersSent) res.status(404).end(); resolve(); });
  });
}

const COVER_FILE = /^[a-f0-9]{40}\.(jpg|png|webp)$/;

async function coverFor(rawId, user) {
  const { kind, id } = parseId(rawId);
  if (kind === 'song') return q('SELECT cover FROM tracks WHERE id = ?').get(id)?.cover;
  if (kind === 'album') return q('SELECT MAX(cover) AS c FROM tracks WHERE album_id = ?').get(id)?.c;
  if (kind === 'artist') {
    // A photo from the folder or found online, else the artist's newest album cover.
    const candidates = [
      q('SELECT image FROM artist_images WHERE artist_id = ?').get(id)?.image,
      q('SELECT image FROM artist_info WHERE artist_id = ?').get(id)?.image,
      q('SELECT cover FROM tracks WHERE album_artist_id = ? AND cover IS NOT NULL ORDER BY year DESC LIMIT 1').get(id)?.cover,
      q(`SELECT t.cover FROM track_artists ta JOIN tracks t ON t.id = ta.track_id WHERE ta.artist_id = ? AND t.cover IS NOT NULL LIMIT 1`).get(id)?.cover,
    ];
    return candidates.find((c) => c && COVER_FILE.test(c) && fs.existsSync(path.join(COVERS_DIR, c)));
  }
  if (kind === 'playlist') {
    const p = playlistFor(user, rawId);
    return q(`SELECT t.cover FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id WHERE pt.playlist_id = ? AND t.cover IS NOT NULL
      ORDER BY pt.position LIMIT 1`).get(p.id)?.cover;
  }
  if (kind === 'podcast') return q('SELECT image FROM podcasts WHERE id = ?').get(Number(id))?.image;
  if (kind === 'station') return q('SELECT image FROM radio_stations WHERE id = ? AND user_id = ?').get(Number(id), user.id)?.image;
  return null;
}

// ───────────────────────── Methods ─────────────────────────
// Each returns the response body (without the subsonic-response wrapper), or sends a file itself (raw: true).

const M = {};
const RAW = new Set();

M.ping = () => ({});
M.getLicense = () => ({ license: { valid: true, email: 'sonara@localhost', licenseExpires: '2999-12-31T00:00:00.000Z' } });
M.getOpenSubsonicExtensions = () => ({ openSubsonicExtensions: EXTENSIONS });
M.tokenInfo = (req) => ({ tokenInfo: { username: req.user.username } });

M.getMusicFolders = (req) => ({ musicFolders: { musicFolder: musicFolders(req.user).map(({ id, name }) => ({ id, name })) } });

M.getIndexes = (req) => inFolder(req, () => {
  const lm = lastModified();
  const since = num(req, 'ifModifiedSince', 0, 0, 1e15);
  if (since && since >= lm) return { indexes: { lastModified: lm, ignoredArticles: IGNORED_ARTICLES } };
  const list = q(`${ARTIST_SELECT} GROUP BY t.album_artist_id ORDER BY name COLLATE NOCASE`).all({ uid: req.user.id });
  return { indexes: { lastModified: lm, ignoredArticles: IGNORED_ARTICLES, index: grouped(list, (a) => ({ id: `ar-${a.id}`, name: a.name, starred: iso(a.starredAt), coverArt: `ar-${a.id}` })) } };
});

M.getArtists = (req) => inFolder(req, () => {
  const list = q(`${ARTIST_SELECT} GROUP BY t.album_artist_id ORDER BY name COLLATE NOCASE`).all({ uid: req.user.id });
  return { artists: { ignoredArticles: IGNORED_ARTICLES, lastModified: lastModified(), index: grouped(list, artist) } };
});

function artistRow(uid, id) {
  return q(`${ARTIST_SELECT} WHERE t.album_artist_id = $id GROUP BY t.album_artist_id`).get({ uid, id })
    || q(`SELECT ta.artist_id AS id, MAX(ta.name) AS name, ${ARTIST_IMAGE('ta.artist_id', 'MAX(t.cover)')} AS cover, 0 AS albumCount,
      (SELECT created_at FROM starred_items s WHERE s.user_id = $uid AND s.kind = 'artist' AND s.item_id = ta.artist_id) AS starredAt
      FROM track_artists ta JOIN tracks t ON t.id = ta.track_id WHERE ta.artist_id = $id GROUP BY ta.artist_id`).get({ uid, id });
}
const albumsOfArtist = (uid, id) => q(`${ALBUM_SELECT} WHERE t.album_id IN
  (SELECT t2.album_id FROM track_artists ta JOIN tracks t2 ON t2.id = ta.track_id WHERE ta.artist_id = $id AND ta.role = 'album')
  GROUP BY t.album_id ORDER BY year, name COLLATE NOCASE`).all({ uid, id });
const albumRow = (uid, id) => q(`${ALBUM_SELECT} WHERE t.album_id = $id GROUP BY t.album_id`).get({ uid, id });
const albumSongs = (uid, id) => songs(uid, 'WHERE t.album_id = $id', { id }, 'ORDER BY COALESCE(t.disc_no, 1), COALESCE(t.track_no, 9999), t.title COLLATE NOCASE');

M.getMusicDirectory = (req) => {
  const raw = need(req, 'id');
  const { kind, id } = parseId(raw);
  const uid = req.user.id;
  if (kind === 'artist') {
    const a = artistRow(uid, id) || notFound('Artist');
    return { directory: { id: raw, name: a.name, starred: iso(a.starredAt), child: albumsOfArtist(uid, id).map(albumDir) } };
  }
  if (kind === 'album') {
    const a = albumRow(uid, id) || notFound('Album');
    return { directory: { id: raw, parent: `ar-${a.artistId}`, name: a.name, starred: iso(a.starredAt), playCount: a.playCount || 0, child: albumSongs(uid, id) } };
  }
  return notFound('Directory');
};

M.getGenres = () => ({
  genres: {
    genre: q(`SELECT g.genre AS name, COUNT(*) AS songCount, COUNT(DISTINCT t.album_id) AS albumCount
      FROM track_genres g JOIN tracks t ON t.id = g.track_id GROUP BY g.genre ORDER BY g.genre COLLATE NOCASE`).all()
      .map((g) => ({ value: g.name, songCount: g.songCount, albumCount: g.albumCount })),
  },
});

M.getArtist = (req) => {
  const { kind, id } = parseId(need(req, 'id'));
  if (kind !== 'artist') notFound('Artist');
  const a = artistRow(req.user.id, id) || notFound('Artist');
  const albums = albumsOfArtist(req.user.id, id);
  return { artist: { ...artist({ ...a, albumCount: albums.length }), album: albums.map(album) } };
};

M.getAlbum = (req) => {
  const { kind, id } = parseId(need(req, 'id'));
  if (kind !== 'album') notFound('Album');
  const a = albumRow(req.user.id, id) || notFound('Album');
  return { album: { ...album(a), song: albumSongs(req.user.id, id) } };
};

M.getSong = (req) => {
  const s = songs(req.user.id, 'WHERE t.id = $id', { id: songId(need(req, 'id')) })[0];
  return { song: s || notFound('Song') };
};

async function artistInfoBody(req) {
  const { kind, id } = parseId(need(req, 'id'));
  let artistId = id;
  if (kind === 'album') artistId = q('SELECT album_artist_id AS a FROM tracks WHERE album_id = ? LIMIT 1').get(id)?.a;
  else if (kind === 'song') artistId = q('SELECT artist_id AS a FROM tracks WHERE id = ?').get(id)?.a;
  else if (kind !== 'artist') notFound('Artist');
  const a = artistId && artistRow(req.user.id, artistId);
  if (!a) notFound('Artist');
  // Online lookups can be slow: answer with what's cached after a few seconds.
  const info = await Promise.race([artistInfo(a.id, a.name).catch(() => null), new Promise((r) => setTimeout(() => r(null), 4000))])
    || q('SELECT * FROM artist_info WHERE artist_id = ?').get(a.id);
  const count = num(req, 'count', 20, 0, 100);
  const similar = q(`SELECT DISTINCT ta2.artist_id AS id FROM track_artists ta JOIN tracks t ON t.id = ta.track_id
    JOIN tracks t2 ON t2.album_id = t.album_id JOIN track_artists ta2 ON ta2.track_id = t2.id AND ta2.role = 'artist'
    WHERE ta.artist_id = ? AND ta2.artist_id != ? LIMIT ?`).all(a.id, a.id, count).map((r) => artistRow(req.user.id, r.id)).filter(Boolean);
  return {
    biography: info?.bio || undefined, musicBrainzId: info?.mbid || undefined, lastFmUrl: info?.url || undefined,
    similarArtist: similar.map(artist),
  };
}
M.getArtistInfo = async (req) => ({ artistInfo: await artistInfoBody(req) });
M.getArtistInfo2 = async (req) => ({ artistInfo2: await artistInfoBody(req) });

function albumInfoBody(req) {
  const { kind, id } = parseId(need(req, 'id'));
  if (kind !== 'album') notFound('Album');
  const a = q('SELECT MAX(mbz_album_id) AS mbid FROM tracks WHERE album_id = ?').get(id);
  return { notes: undefined, musicBrainzId: a?.mbid || undefined };
}
M.getAlbumInfo = (req) => ({ albumInfo: albumInfoBody(req) });
M.getAlbumInfo2 = (req) => ({ albumInfo: albumInfoBody(req) });

async function similarSongs(req) {
  const raw = need(req, 'id');
  const { kind, id } = parseId(raw);
  const count = num(req, 'count', 50, 1, 500);
  let ids = null;
  if (kind === 'song') ids = similarIds(id, { limit: count }); // by analysed sound when available
  if (!ids?.length) {
    const type = { song: 'track', album: 'album', artist: 'artist' }[kind] || notFound('Item');
    ids = await radioTrackIds(req.user.id, { type, id: kind === 'song' ? id : String(id) }, { limit: count });
  }
  return songsByIds(req.user.id, ids);
}
M.getSimilarSongs = async (req) => ({ similarSongs: { song: await similarSongs(req) } });
M.getSimilarSongs2 = async (req) => ({ similarSongs2: { song: await similarSongs(req) } });

M.getTopSongs = (req) => {
  const name = need(req, 'artist');
  const count = num(req, 'count', 50, 1, 500);
  const a = q('SELECT artist_id AS id FROM track_artists WHERE name = ? COLLATE NOCASE LIMIT 1').get(name);
  if (!a) return { topSongs: { song: [] } };
  return {
    topSongs: {
      song: songs(req.user.id, 'WHERE t.id IN (SELECT track_id FROM track_artists WHERE artist_id = $id)', { id: a.id, n: count },
        'ORDER BY (SELECT COUNT(*) FROM plays p WHERE p.track_id = t.id) DESC, rating DESC, t.title COLLATE NOCASE LIMIT $n'),
    },
  };
};

// ── Lists

const ALBUM_LISTS = {
  random: { order: 'RANDOM()' },
  newest: { order: 'addedAt DESC' },
  highest: { order: 'rating DESC, name COLLATE NOCASE', having: 'HAVING rating IS NOT NULL' },
  frequent: { order: 'playCount DESC, lastPlayed DESC', having: 'HAVING playCount > 0' },
  recent: { order: 'lastPlayed DESC', having: 'HAVING lastPlayed IS NOT NULL' },
  alphabeticalByName: { order: 'name COLLATE NOCASE' },
  alphabeticalByArtist: { order: 'artist COLLATE NOCASE, year, name COLLATE NOCASE' },
  starred: { order: 'starredAt DESC', having: 'HAVING starredAt IS NOT NULL' },
  byYear: { order: 'year' },
  byGenre: { order: 'name COLLATE NOCASE' },
};

function albumList(req) {
  const type = need(req, 'type');
  const spec = ALBUM_LISTS[type] || fail(0, `Unknown list type: ${type}`);
  const size = num(req, 'size', 10, 1, 500);
  const offset = num(req, 'offset', 0, 0);
  const where = [];
  const params = { uid: req.user.id, size, offset };
  let order = spec.order;
  if (type === 'byYear') {
    const from = num(req, 'fromYear', 0, 0, 9999);
    const to = num(req, 'toYear', 9999, 0, 9999);
    where.push('t.year BETWEEN $lo AND $hi');
    Object.assign(params, { lo: Math.min(from, to), hi: Math.max(from, to) });
    if (from > to) order = 'year DESC';
  }
  if (type === 'byGenre') {
    where.push('t.id IN (SELECT track_id FROM track_genres WHERE genre = $genre)');
    params.genre = need(req, 'genre');
  }
  return inFolder(req, () => q(`${ALBUM_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} GROUP BY t.album_id
    ${spec.having || ''} ORDER BY ${order} LIMIT $size OFFSET $offset`).all(params));
}
M.getAlbumList = (req) => ({ albumList: { album: albumList(req).map(albumDir) } });
M.getAlbumList2 = (req) => ({ albumList2: { album: albumList(req).map(album) } });

M.getRandomSongs = (req) => inFolder(req, () => {
  const where = [];
  const params = { n: num(req, 'size', 10, 1, 500) };
  if (param(req, 'genre')) { where.push('t.id IN (SELECT track_id FROM track_genres WHERE genre = $genre)'); params.genre = param(req, 'genre'); }
  if (param(req, 'fromYear')) { where.push('t.year >= $from'); params.from = num(req, 'fromYear', 0); }
  if (param(req, 'toYear')) { where.push('t.year <= $to'); params.to = num(req, 'toYear', 9999); }
  return { randomSongs: { song: songs(req.user.id, where.length ? `WHERE ${where.join(' AND ')}` : '', params, 'ORDER BY RANDOM() LIMIT $n') } };
});

M.getSongsByGenre = (req) => inFolder(req, () => ({
  songsByGenre: {
    song: songs(req.user.id, 'WHERE t.id IN (SELECT track_id FROM track_genres WHERE genre = $genre)',
      { genre: need(req, 'genre'), n: num(req, 'count', 10, 1, 500), o: num(req, 'offset', 0) },
      'ORDER BY t.album COLLATE NOCASE, t.disc_no, t.track_no LIMIT $n OFFSET $o'),
  },
}));

M.getNowPlaying = (req) => {
  const entries = [];
  const users = q('SELECT id, username, share_activity FROM users').all();
  for (const u of users) {
    if (u.id !== req.user.id && !u.share_activity) continue;
    const web = nowPlayingFor(u.id);
    const app = playingNow.get(u.id);
    const pick = web && (!app || web.at > app.at) ? { trackId: web.track?.id, at: web.at, client: 'Sonara' } : app;
    if (!pick?.trackId || Date.now() - pick.at > 30 * 60000) continue;
    const s = songs(req.user.id, 'WHERE t.id = $id', { id: Number(pick.trackId) })[0];
    if (s) entries.push({ ...s, username: u.username, minutesAgo: Math.floor((Date.now() - pick.at) / 60000), playerId: 0, playerName: pick.client });
  }
  return { nowPlaying: { entry: entries } };
};

function starred(req) {
  const uid = req.user.id;
  return inFolder(req, () => ({
    artist: q(`${ARTIST_SELECT} WHERE t.album_artist_id IN (SELECT item_id FROM starred_items WHERE user_id = $uid AND kind = 'artist')
      GROUP BY t.album_artist_id ORDER BY name COLLATE NOCASE`).all({ uid }),
    album: q(`${ALBUM_SELECT} WHERE t.album_id IN (SELECT item_id FROM starred_items WHERE user_id = $uid AND kind = 'album')
      GROUP BY t.album_id ORDER BY starredAt DESC`).all({ uid }),
    song: songs(uid, 'WHERE f.track_id IS NOT NULL', {}, 'ORDER BY f.created_at DESC'),
  }));
}
M.getStarred = (req) => { const s = starred(req); return { starred: { artist: s.artist.map(artist), album: s.album.map(albumDir), song: s.song } }; };
M.getStarred2 = (req) => { const s = starred(req); return { starred2: { artist: s.artist.map(artist), album: s.album.map(album), song: s.song } }; };

// ── Search

function search(req) {
  // An empty query lists everything (apps such as Symfonium sync the whole library this way).
  const raw = String(param(req, 'query') ?? '').replace(/^"+|"+$/g, '').trim();
  const words = raw ? raw.split(/\s+/).slice(0, 8).map((w) => `%${w.replace(/[\\%_*]/g, (c) => (c === '*' ? '%' : `\\${c}`))}%`) : [];
  const like = (expr) => (words.length ? `WHERE ${words.map((_, i) => `${expr} LIKE $w${i} ESCAPE '\\'`).join(' AND ')}` : '');
  const params = Object.fromEntries(words.map((w, i) => [`w${i}`, w]));
  const uid = req.user.id;
  const page = (count, offset) => ({ n: num(req, count, 20, 0, 5000), o: num(req, offset, 0) });
  return inFolder(req, () => {
    const ar = page('artistCount', 'artistOffset');
    const al = page('albumCount', 'albumOffset');
    const so = page('songCount', 'songOffset');
    return {
      artist: ar.n ? q(`${ARTIST_SELECT} ${like('t.album_artist')} GROUP BY t.album_artist_id ORDER BY name COLLATE NOCASE LIMIT $n OFFSET $o`)
        .all({ uid, ...params, ...ar }) : [],
      album: al.n ? q(`${ALBUM_SELECT} ${like("(t.album || ' ' || t.album_artist)")} GROUP BY t.album_id ORDER BY name COLLATE NOCASE LIMIT $n OFFSET $o`)
        .all({ uid, ...params, ...al }) : [],
      song: so.n ? songs(uid, like("(t.title || ' ' || t.artist || ' ' || t.album)"), { ...params, ...so },
        words.length ? 'ORDER BY t.title COLLATE NOCASE LIMIT $n OFFSET $o' : 'ORDER BY t.id LIMIT $n OFFSET $o') : [],
    };
  });
}
M.search2 = (req) => { const r = search(req); return { searchResult2: { artist: r.artist.map(artist), album: r.album.map(albumDir), song: r.song } }; };
M.search3 = (req) => { const r = search(req); return { searchResult3: { artist: r.artist.map(artist), album: r.album.map(album), song: r.song } }; };
M.search = (req) => {
  const r = search({ ...req, query: { ...req.query, query: param(req, 'any') || param(req, 'title') || param(req, 'artist') || param(req, 'album') || '' } });
  return { searchResult: { offset: 0, totalHits: r.song.length, match: r.song } };
};

// ── Playlists

M.getPlaylists = (req) => {
  const u = req.user;
  let owner = u.id;
  const asUser = param(req, 'username');
  if (asUser && asUser.toLowerCase() !== u.username.toLowerCase()) {
    if (!u.is_admin) fail(50, 'Only admins can list other people’s playlists');
    owner = q('SELECT id FROM users WHERE username = ?').get(asUser)?.id ?? notFound('User');
  }
  const regular = q(`${PLAYLIST_SELECT} WHERE p.user_id = ? OR (p.visibility != 'private' AND ? = ?) ORDER BY p.name COLLATE NOCASE`)
    .all(owner, owner, u.id).map((p) => playlistShape(p, u));
  const smart = owner === u.id ? q(`${SMART_SELECT} WHERE s.user_id = ? ORDER BY s.name COLLATE NOCASE`).all(u.id).map((s) => {
    const n = smartTracks(u.id, JSON.parse(s.rules), s.sort, s.maxTracks, { countOnly: true });
    return { id: `sp-${s.id}`, name: s.name, comment: s.description || 'Smart playlist', owner: s.owner, public: false, songCount: n.n,
      duration: secs(n.duration), created: iso(s.createdAt), changed: iso(Date.now()), coverArt: undefined, readonly: true };
  }) : [];
  return { playlists: { playlist: [...regular, ...smart] } };
};

M.getPlaylist = (req) => {
  const raw = need(req, 'id');
  const { kind, id } = parseId(raw);
  const u = req.user;
  if (kind === 'smart') {
    const s = q(`${SMART_SELECT} WHERE s.id = ? AND s.user_id = ?`).get(Number(id), u.id) || notFound('Playlist');
    const list = smartTracks(u.id, JSON.parse(s.rules), s.sort, s.maxTracks);
    const entry = songsByIds(u.id, list.map((x) => x.id));
    return { playlist: { id: raw, name: s.name, comment: s.description || 'Smart playlist', owner: s.owner, public: false, songCount: entry.length,
      duration: entry.reduce((a, x) => a + x.duration, 0), created: iso(s.createdAt), changed: iso(Date.now()), readonly: true, entry } };
  }
  const p = playlistFor(u, raw);
  const ids = q(`SELECT pt.track_id AS id FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id WHERE pt.playlist_id = ? ORDER BY pt.position`)
    .all(p.id).map((r) => r.id);
  return { playlist: { ...playlistShape(p, u), entry: songsByIds(u.id, ids) } };
};

M.createPlaylist = (req) => {
  const u = req.user;
  const ids = existingSongIds(all(req, 'songId').map(songId));
  const existing = param(req, 'playlistId');
  let pid;
  if (existing) {
    const p = playlistFor(u, existing, 'edit');
    pid = p.id;
    if (param(req, 'name')) q('UPDATE playlists SET name = ? WHERE id = ?').run(String(param(req, 'name')).slice(0, 200), pid);
  } else {
    if (!can(u, 'playlists')) fail(50, 'You don’t have permission to create playlists');
    const name = String(need(req, 'name')).trim().slice(0, 200) || missing('name');
    const now = Date.now();
    pid = Number(q('INSERT INTO playlists (user_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(u.id, name, '', now, now).lastInsertRowid);
  }
  setPlaylistTracks(pid, ids, u.id);
  return M.getPlaylist({ ...req, query: { id: `pl-${pid}` }, body: {} });
};

M.updatePlaylist = (req) => {
  const u = req.user;
  const p = playlistFor(u, need(req, 'playlistId'), 'edit');
  const own = p.ownerId === u.id;
  if (param(req, 'name') != null) q('UPDATE playlists SET name = ? WHERE id = ?').run(String(param(req, 'name')).trim().slice(0, 200) || p.name, p.id);
  if (param(req, 'comment') != null) q('UPDATE playlists SET description = ? WHERE id = ?').run(String(param(req, 'comment')).slice(0, 2000), p.id);
  if (param(req, 'public') != null && own) {
    const pub = bool(req, 'public');
    // "public" in Subsonic means others can listen; a collaborative playlist stays collaborative.
    if (!pub) q("UPDATE playlists SET visibility = 'private' WHERE id = ?").run(p.id);
    else if (p.visibility === 'private') q("UPDATE playlists SET visibility = 'public' WHERE id = ?").run(p.id);
  }
  const remove = new Set(all(req, 'songIndexToRemove').map(Number).filter(Number.isInteger));
  const add = existingSongIds(all(req, 'songIdToAdd').map(songId));
  if (remove.size || add.length) {
    const cur = q('SELECT track_id AS id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position').all(p.id).map((r) => r.id);
    setPlaylistTracks(p.id, [...cur.filter((_, i) => !remove.has(i)), ...add], u.id);
  } else q('UPDATE playlists SET updated_at = ? WHERE id = ?').run(Date.now(), p.id);
  return {};
};

M.deletePlaylist = (req) => {
  const p = playlistFor(req.user, need(req, 'id'), 'manage');
  q('DELETE FROM playlists WHERE id = ?').run(p.id);
  return {};
};

// ── Media

RAW.add('stream');
M.stream = async (req, res) => {
  const raw = need(req, 'id');
  const { kind, id } = parseId(raw);
  if (kind === 'episode') return delegate(req, res, `/podcasts/episodes/${Number(id)}/stream`);
  if (kind !== 'song') notFound('Song');
  const row = q(`SELECT ${STREAM_COLS} FROM tracks WHERE id = ?`).get(id) || notFound('Song');
  notePlaying(req.user, row.id, param(req, 'c'));
  const fmt = String(param(req, 'format') || 'auto').toLowerCase();
  const format = ['mp3', 'opus', 'aac', 'flac', 'raw'].includes(fmt) ? fmt : fmt === 'ogg' ? 'opus' : fmt === 'm4a' ? 'aac' : 'auto';
  const plan = deliveryPlan(row, {
    format, bitrate: num(req, 'maxBitRate', 0, 0, 1411), userMax: req.user.max_bitrate || 0,
    prefer: ['mp3', 'opus', 'aac'].includes(format) ? format : 'mp3',
  });
  if (plan) return serveTranscoded(req, res, row, plan);
  return sendOriginal(res, row.path);
};

RAW.add('download');
M.download = async (req, res) => {
  if (!can(req.user, 'download')) fail(50, 'You don’t have permission to download music');
  const { kind, id } = parseId(need(req, 'id'));
  if (kind === 'episode') return delegate(req, res, `/podcasts/episodes/${Number(id)}/stream`);
  if (kind !== 'song') fail(0, 'Download songs one at a time');
  const row = q(`SELECT ${STREAM_COLS} FROM tracks WHERE id = ?`).get(id) || notFound('Song');
  // The original file; songs from a cue sheet are cut out losslessly.
  const plan = deliveryPlan(row, { format: 'raw', userMax: req.user.max_bitrate || 0 });
  const file = plan ? await transcodeToFile(row, plan) : row.path;
  const ext = plan ? FORMATS[plan.format].ext : path.extname(row.path);
  const name = `${safeName(row.artist)} - ${safeName(row.title)}${ext}`;
  res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'")}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  return sendOriginal(res, file);
};

RAW.add('getCoverArt');
M.getCoverArt = async (req, res) => {
  const file = await coverFor(need(req, 'id'), req.user);
  if (!file || !COVER_FILE.test(file) || !fs.existsSync(path.join(COVERS_DIR, file))) notFound('Cover art');
  // Covers are named by their content, so they never change.
  await new Promise((resolve) => res.sendFile(path.join(COVERS_DIR, file), { maxAge: '365d', immutable: true }, () => resolve()));
};

RAW.add('getAvatar');
M.getAvatar = () => notFound('Avatar');

/** LRC text → [{ start ms, value }] or null when it isn't synced. */
function lrcLines(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const stamps = [...line.matchAll(/\[(\d+):(\d+(?:[.:]\d+)?)\]/g)];
    if (!stamps.length) continue;
    const value = line.replace(/\[[^\]]*\]/g, '').trim();
    for (const s of stamps) out.push({ start: Math.round((Number(s[1]) * 60 + Number(String(s[2]).replace(':', '.'))) * 1000), value });
  }
  return out.length ? out.sort((a, b) => a.start - b.start) : null;
}

const LYRIC_COLS = 'id, path, cue_file, mtime, title, artist, album, duration';
M.getLyrics = async (req) => {
  const a = param(req, 'artist') || '';
  const t = param(req, 'title') || '';
  const row = q(`SELECT ${LYRIC_COLS} FROM tracks WHERE title = ? COLLATE NOCASE AND (? = '' OR artist = ? COLLATE NOCASE) LIMIT 1`).get(t, a, a);
  const ly = row && await getLyrics(row).catch(() => null);
  if (!ly?.text) return { lyrics: {} };
  const synced = ly.synced ? lrcLines(ly.text) : null;
  return { lyrics: { artist: row.artist, title: row.title, value: synced ? synced.map((l) => l.value).join('\n') : ly.text } };
};

M.getLyricsBySongId = async (req) => {
  const row = q(`SELECT ${LYRIC_COLS} FROM tracks WHERE id = ?`).get(songId(need(req, 'id'))) || notFound('Song');
  const ly = await getLyrics(row).catch(() => null);
  if (!ly?.text) return { lyricsList: { structuredLyrics: [] } };
  const synced = ly.synced ? lrcLines(ly.text) : null;
  return {
    lyricsList: {
      structuredLyrics: [{
        displayArtist: row.artist, displayTitle: row.title, lang: 'xxx', offset: 0, synced: !!synced,
        line: synced || String(ly.text).split(/\r?\n/).map((value) => ({ value })),
      }],
    },
  };
};

// ── Annotation

function starUnstar(req, on) {
  const uid = req.user.id;
  const now = Date.now();
  const songIds = [];
  const items = [];
  for (const raw of all(req, 'id')) {
    const { kind, id } = parseId(raw);
    if (kind === 'song') songIds.push(id);
    else if (kind === 'album' || kind === 'artist') items.push([kind, String(id)]);
  }
  for (const raw of all(req, 'albumId')) { const p = parseId(raw); items.push(['album', String(p.kind === 'album' ? p.id : raw)]); }
  for (const raw of all(req, 'artistId')) { const p = parseId(raw); items.push(['artist', String(p.kind === 'artist' ? p.id : raw)]); }
  if (!songIds.length && !items.length) missing('id');
  for (const id of existingSongIds(songIds)) {
    if (on) q('INSERT OR IGNORE INTO favorites (user_id, track_id, created_at) VALUES (?, ?, ?)').run(uid, id, now);
    else q('DELETE FROM favorites WHERE user_id = ? AND track_id = ?').run(uid, id);
  }
  for (const [kind, id] of items) {
    if (on) q('INSERT OR IGNORE INTO starred_items (user_id, kind, item_id, created_at) VALUES (?, ?, ?, ?)').run(uid, kind, id, now);
    else q('DELETE FROM starred_items WHERE user_id = ? AND kind = ? AND item_id = ?').run(uid, kind, id);
  }
  return {};
}
M.star = (req) => starUnstar(req, true);
M.unstar = (req) => starUnstar(req, false);

M.setRating = (req) => {
  const { kind, id } = parseId(need(req, 'id'));
  const rating = num(req, 'rating', null, 0, 5) ?? missing('rating');
  if (kind !== 'song') return {}; // Sonara rates songs; album and artist ratings come from their songs.
  if (!q('SELECT 1 FROM tracks WHERE id = ?').get(id)) notFound('Song');
  if (!rating) q('DELETE FROM ratings WHERE user_id = ? AND track_id = ?').run(req.user.id, id);
  else q(`INSERT INTO ratings (user_id, track_id, rating, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, track_id) DO UPDATE SET rating = excluded.rating, updated_at = excluded.updated_at`).run(req.user.id, id, rating, Date.now());
  return {};
};

const SCROBBLE_COLS = 'id, title, artist, album, album_artist, track_no, duration, mbz_track_id';
M.scrobble = (req) => {
  const ids = all(req, 'id');
  if (!ids.length) missing('id');
  const times = all(req, 'time').map(Number);
  const submission = bool(req, 'submission', true);
  ids.forEach((raw, i) => {
    const { kind, id } = parseId(raw);
    if (kind !== 'song') return;
    const t = q(`SELECT ${SCROBBLE_COLS} FROM tracks WHERE id = ?`).get(id);
    if (!t) return;
    if (!submission) {
      notePlaying(req.user, t.id, param(req, 'c'));
      scrobbleNowPlaying(req.user.id, t);
      return;
    }
    const at = Number.isFinite(times[i]) && times[i] > 0 && times[i] <= Date.now() + 60000 ? times[i] : Date.now();
    // The same play reported twice (apps retry when offline) only counts once.
    if (q('SELECT 1 FROM plays WHERE user_id = ? AND track_id = ? AND ABS(played_at - ?) < 60000').get(req.user.id, t.id, at)) return;
    q('INSERT INTO plays (user_id, track_id, played_at) VALUES (?, ?, ?)').run(req.user.id, t.id, at);
    if (!t.duration || t.duration >= 30) scrobbleSend(req.user.id, t, at);
  });
  return {};
};

// ── Bookmarks and the play queue

M.getBookmarks = (req) => {
  const rows = q(`SELECT b.track_id AS trackId, b.position, b.label, b.created_at AS createdAt FROM bookmarks b
    WHERE b.user_id = ? AND b.track_id IS NOT NULL AND b.id IN (SELECT MAX(id) FROM bookmarks WHERE user_id = ? AND track_id IS NOT NULL GROUP BY track_id)
    ORDER BY b.created_at DESC`).all(req.user.id, req.user.id);
  const byId = new Map(songsByIds(req.user.id, rows.map((r) => r.trackId)).map((s) => [Number(s.id), s]));
  return {
    bookmarks: {
      bookmark: rows.filter((r) => byId.has(r.trackId)).map((r) => ({
        position: Math.round(r.position * 1000), username: req.user.username, comment: r.label || undefined,
        created: iso(r.createdAt), changed: iso(r.createdAt), entry: byId.get(r.trackId),
      })),
    },
  };
};

// Subsonic keeps one bookmark per song; Sonara can have several, so this replaces the song's bookmarks.
M.createBookmark = (req) => {
  const id = songId(need(req, 'id'));
  if (!q('SELECT 1 FROM tracks WHERE id = ?').get(id)) notFound('Song');
  const position = num(req, 'position', null, 0, 1e10) ?? missing('position');
  q('DELETE FROM bookmarks WHERE user_id = ? AND track_id = ?').run(req.user.id, id);
  q('INSERT INTO bookmarks (user_id, track_id, position, label, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(req.user.id, id, position / 1000, String(param(req, 'comment') || '').slice(0, 200), Date.now());
  return {};
};

M.deleteBookmark = (req) => {
  q('DELETE FROM bookmarks WHERE user_id = ? AND track_id = ?').run(req.user.id, songId(need(req, 'id')));
  return {};
};

// The play queue is the same one the web player saves, so listening moves between Sonara and apps.
M.getPlayQueue = (req) => {
  const row = q('SELECT state, updated_at FROM player_state WHERE user_id = ?').get(req.user.id);
  let state = null;
  try { state = JSON.parse(row?.state || 'null'); } catch { /* empty */ }
  if (!state?.queue?.length) return {};
  const entry = songsByIds(req.user.id, state.queue);
  const current = state.queue[state.index];
  return {
    playQueue: {
      current: current != null ? String(current) : undefined, position: Math.round((state.time || 0) * 1000),
      username: req.user.username, changed: iso(row.updated_at), changedBy: state.device || 'Sonara', entry,
    },
  };
};

// OpenSubsonic indexBasedQueue: the same queue, with the position given as an index (the same
// song can be in a queue twice).
M.getPlayQueueByIndex = (req) => {
  const pq = M.getPlayQueue(req).playQueue;
  if (!pq) return {};
  const state = JSON.parse(q('SELECT state FROM player_state WHERE user_id = ?').get(req.user.id).state);
  const { current, ...rest } = pq;
  return { playQueueByIndex: { ...rest, currentIndex: Math.min(state.index || 0, Math.max(0, pq.entry.length - 1)) } };
};
M.savePlayQueueByIndex = (req) => savePlayQueue(req, (ids) => num(req, 'currentIndex', 0, 0, Math.max(0, ids.length - 1)));

M.savePlayQueue = (req) => savePlayQueue(req, (ids) => {
  const current = param(req, 'current');
  return Math.max(0, current != null ? ids.indexOf(Number(current)) : 0);
});

function savePlayQueue(req, indexOf) {
  const ids = existingSongIds(all(req, 'id').map((x) => parseId(x)).filter((p) => p.kind === 'song').map((p) => p.id)).slice(0, 5000);
  const old = (() => { try { return JSON.parse(q('SELECT state FROM player_state WHERE user_id = ?').get(req.user.id)?.state || '{}'); } catch { return {}; } })();
  const index = indexOf(ids);
  const state = {
    ...old, queue: ids, original: [], index, time: (num(req, 'position', 0, 0, 1e10) || 0) / 1000, shuffle: false,
    device: String(param(req, 'c') || 'Subsonic app').slice(0, 80),
  };
  q(`INSERT INTO player_state (user_id, state, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`).run(req.user.id, JSON.stringify(state), Date.now());
  return {};
}

// ── Shares

const shareShape = (req, s) => {
  let entry = [];
  if (s.kind === 'track') entry = songsByIds(req.user.id, [Number(s.ref)]);
  else if (s.kind === 'album') entry = albumSongs(req.user.id, s.ref);
  else if (s.kind === 'playlist') {
    entry = songsByIds(req.user.id, q('SELECT track_id AS id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position').all(Number(s.ref)).map((r) => r.id));
  }
  return {
    id: s.id, url: `${baseUrl(req)}/s/${s.id}`, description: s.description || s.title, username: req.user.username,
    created: iso(s.created_at), expires: iso(s.expires_at), lastVisited: iso(s.last_viewed_at), visitCount: s.views, entry,
  };
};

M.getShares = (req) => ({
  shares: { share: q('SELECT * FROM shares WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id).map((s) => shareShape(req, s)) },
});

M.createShare = (req) => {
  if (!getConfig().sharing) fail(50, 'Sharing is turned off on this server');
  if (!can(req.user, 'share')) fail(50, 'You don’t have permission to create share links');
  const ids = all(req, 'id');
  if (!ids.length) missing('id');
  if (ids.length > 1) fail(0, 'Share one song, album or playlist at a time');
  const { kind, id } = parseId(ids[0]);
  let title;
  let ref;
  let k;
  if (kind === 'song') {
    const t = q('SELECT id, title, artist FROM tracks WHERE id = ?').get(id) || notFound('Song');
    [k, ref, title] = ['track', String(t.id), `${t.title} · ${t.artist}`];
  } else if (kind === 'album') {
    const a = q('SELECT MAX(album) AS album, MAX(album_artist) AS artist FROM tracks WHERE album_id = ?').get(id);
    if (!a?.album) notFound('Album');
    [k, ref, title] = ['album', String(id), `${a.album} · ${a.artist}`];
  } else if (kind === 'playlist') {
    const p = playlistFor(req.user, ids[0]);
    [k, ref, title] = ['playlist', String(p.id), p.name];
  } else fail(0, 'Only songs, albums and playlists can be shared');
  const expires = num(req, 'expires', 0, 0, 1e14);
  const sid = newShareId();
  q(`INSERT INTO shares (id, user_id, kind, ref, title, description, allow_download, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`)
    .run(sid, req.user.id, k, ref, title.slice(0, 200), String(param(req, 'description') || '').slice(0, 500), expires > Date.now() ? expires : null, Date.now());
  return { shares: { share: [shareShape(req, q('SELECT * FROM shares WHERE id = ?').get(sid))] } };
};

M.updateShare = (req) => {
  const s = q('SELECT * FROM shares WHERE id = ? AND user_id = ?').get(need(req, 'id'), req.user.id) || notFound('Share');
  if (param(req, 'description') != null) q('UPDATE shares SET description = ? WHERE id = ?').run(String(param(req, 'description')).slice(0, 500), s.id);
  if (param(req, 'expires') != null) { const e = num(req, 'expires', 0, 0, 1e14); q('UPDATE shares SET expires_at = ? WHERE id = ?').run(e > 0 ? e : null, s.id); }
  return {};
};

M.deleteShare = (req) => {
  const r = q('DELETE FROM shares WHERE id = ? AND user_id = ?').run(need(req, 'id'), req.user.id);
  if (!r.changes) notFound('Share');
  return {};
};

// ── Podcasts

const PODCAST_SELECT = `SELECT p.id, p.title, p.description, p.image, p.feed_url AS url, p.last_error AS error FROM podcasts p
  JOIN podcast_subscriptions s ON s.podcast_id = p.id AND s.user_id = $uid`;

M.getPodcasts = (req) => {
  const uid = req.user.id;
  const withEpisodes = bool(req, 'includeEpisodes', true);
  const only = param(req, 'id');
  const rows = q(`${PODCAST_SELECT} ${only ? 'WHERE p.id = $id' : ''} ORDER BY p.title COLLATE NOCASE`).all({ uid, ...(only ? { id: Number(parseId(only).id) } : {}) });
  if (only && !rows.length) notFound('Podcast');
  return {
    podcasts: {
      channel: rows.map((p) => ({
        id: `pc-${p.id}`, url: p.url, title: p.title, description: p.description || undefined, coverArt: p.image ? `pc-${p.id}` : undefined,
        status: p.error ? 'error' : 'completed', errorMessage: p.error || undefined,
        episode: withEpisodes ? q(`${EPISODE_SELECT} WHERE e.podcast_id = $pid ORDER BY e.published_at DESC LIMIT 500`).all({ uid, pid: p.id }).map(episodeShape) : undefined,
      })),
    },
  };
};

M.getNewestPodcasts = (req) => ({
  newestPodcasts: {
    episode: q(`${EPISODE_SELECT} WHERE e.podcast_id IN (SELECT podcast_id FROM podcast_subscriptions WHERE user_id = $uid)
      ORDER BY e.published_at DESC LIMIT $n`).all({ uid: req.user.id, n: num(req, 'count', 20, 1, 500) }).map(episodeShape),
  },
});

M.getPodcastEpisode = (req) => {
  const { kind, id } = parseId(need(req, 'id'));
  if (kind !== 'episode') notFound('Episode');
  const e = q(`${EPISODE_SELECT} WHERE e.id = $id`).get({ uid: req.user.id, id: Number(id) }) || notFound('Episode');
  return { podcastEpisode: episodeShape(e) };
};

M.refreshPodcasts = async (req) => {
  const ids = q('SELECT podcast_id AS id FROM podcast_subscriptions WHERE user_id = ?').all(req.user.id).map((r) => r.id);
  // Feeds can be slow: refresh in the background, like the Subsonic API expects.
  Promise.allSettled(ids.map((id) => refreshPodcast(id, { force: true }))).catch(() => {});
  return {};
};

M.createPodcastChannel = async (req) => {
  try { await addPodcast(need(req, 'url'), req.user); } catch (err) { if (err instanceof SubsonicError) throw err; fail(0, err.message); }
  return {};
};

M.deletePodcastChannel = (req) => {
  const { kind, id } = parseId(need(req, 'id'));
  if (kind !== 'podcast') notFound('Podcast');
  const pid = Number(id);
  q('DELETE FROM podcast_subscriptions WHERE user_id = ? AND podcast_id = ?').run(req.user.id, pid);
  q('DELETE FROM podcast_progress WHERE user_id = ? AND episode_id IN (SELECT id FROM podcast_episodes WHERE podcast_id = ?)').run(req.user.id, pid);
  removeIfOrphan(pid);
  return {};
};

M.downloadPodcastEpisode = (req) => {
  const { kind, id } = parseId(need(req, 'id'));
  if (kind !== 'episode') notFound('Episode');
  if (req.user.is_admin) queueDownload(Number(id));
  return {};
};

M.deletePodcastEpisode = (req) => {
  const { kind, id } = parseId(need(req, 'id'));
  if (kind !== 'episode') notFound('Episode');
  if (!req.user.is_admin) fail(50, 'Only admins can delete downloaded episodes');
  const e = q('SELECT file FROM podcast_episodes WHERE id = ?').get(Number(id)) || notFound('Episode');
  if (e.file) {
    fs.rmSync(path.join(PODCASTS_DIR, e.file), { force: true });
    q('UPDATE podcast_episodes SET file = NULL, file_size = NULL WHERE id = ?').run(Number(id));
  }
  return {};
};

// ── Internet radio (each person's own stations)

const stationShape = (s) => ({ id: `rs-${s.id}`, name: s.name, streamUrl: s.stream_url, homePageUrl: s.homepage || undefined, coverArt: s.image ? `rs-${s.id}` : undefined });
const httpUrl = (v, name) => {
  try { const u = new URL(String(v)); if (['http:', 'https:'].includes(u.protocol)) return u.href; } catch { /* invalid */ }
  return fail(0, `${name} must be an http:// or https:// address`);
};

M.getInternetRadioStations = (req) => ({
  internetRadioStations: { internetRadioStation: q('SELECT * FROM radio_stations WHERE user_id = ? ORDER BY name COLLATE NOCASE').all(req.user.id).map(stationShape) },
});

M.createInternetRadioStation = (req) => {
  const url = httpUrl(need(req, 'streamUrl'), 'The stream');
  const name = String(need(req, 'name')).trim().slice(0, 200);
  const home = param(req, 'homepageUrl') ? httpUrl(param(req, 'homepageUrl'), 'The homepage') : null;
  q(`INSERT INTO radio_stations (user_id, name, stream_url, homepage, tags, created_at) VALUES (?, ?, ?, ?, '', ?)`).run(req.user.id, name, url, home, Date.now());
  return {};
};

M.updateInternetRadioStation = (req) => {
  const { kind, id } = parseId(need(req, 'id'));
  const s = kind === 'station' && q('SELECT * FROM radio_stations WHERE id = ? AND user_id = ?').get(Number(id), req.user.id);
  if (!s) notFound('Station');
  q('UPDATE radio_stations SET name = ?, stream_url = ?, homepage = ? WHERE id = ?').run(
    String(param(req, 'name') ?? s.name).trim().slice(0, 200) || s.name,
    param(req, 'streamUrl') ? httpUrl(param(req, 'streamUrl'), 'The stream') : s.stream_url,
    param(req, 'homepageUrl') != null ? (param(req, 'homepageUrl') ? httpUrl(param(req, 'homepageUrl'), 'The homepage') : null) : s.homepage,
    s.id,
  );
  return {};
};

M.deleteInternetRadioStation = (req) => {
  const { kind, id } = parseId(need(req, 'id'));
  const r = kind === 'station' && q('DELETE FROM radio_stations WHERE id = ? AND user_id = ?').run(Number(id), req.user.id);
  if (!r?.changes) notFound('Station');
  return {};
};

// ── Users and the server

function userShape(u) {
  const p = permissionsOf(u);
  const scrobbling = Object.values(services(u.id) || {}).some((s) => s?.enabled !== false);
  return {
    username: u.username, email: '', scrobblingEnabled: scrobbling, maxBitRate: u.max_bitrate || 0,
    adminRole: !!u.is_admin, settingsRole: true, downloadRole: p.download, uploadRole: !!u.is_admin, playlistRole: p.playlists,
    coverArtRole: !!u.is_admin, commentRole: false, podcastRole: true, streamRole: true, jukeboxRole: p.jukebox, shareRole: p.share,
    videoConversionRole: false, folder: musicFolders(u).map((f) => f.id),
  };
}

M.getUser = (req) => {
  const name = param(req, 'username') || req.user.username;
  if (name.toLowerCase() !== req.user.username.toLowerCase() && !req.user.is_admin) fail(50, 'Only admins can look up other people');
  const u = q('SELECT * FROM users WHERE username = ?').get(name) || notFound('User');
  return { user: userShape(u) };
};

M.getUsers = (req) => {
  if (!req.user.is_admin) fail(50, 'Admins only');
  return { users: { user: q('SELECT * FROM users ORDER BY username COLLATE NOCASE').all().map(userShape) } };
};

M.changePassword = (req) => {
  const name = need(req, 'username');
  const u = q('SELECT * FROM users WHERE username = ?').get(name) || notFound('User');
  if (u.id !== req.user.id && !req.user.is_admin) fail(50, 'You can only change your own password');
  // Changing the account password needs the account itself, not an app password.
  if (req.subsonicVia === 'app') fail(50, 'Change your password in Sonara’s settings');
  let pw = need(req, 'password');
  if (pw.startsWith('enc:')) pw = Buffer.from(pw.slice(4), 'hex').toString('utf8');
  const problem = validateCredentials(u.username, pw);
  if (problem) fail(0, problem);
  q('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(pw), u.id);
  q('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  return {};
};
for (const m of ['createUser', 'updateUser', 'deleteUser']) M[m] = () => fail(50, 'Manage people in Sonara’s settings');

M.getScanStatus = () => {
  const s = scanStatus();
  return { scanStatus: { scanning: !!s.running, count: s.running ? s.processed : q('SELECT COUNT(*) AS n FROM tracks').get().n, folderCount: getConfig().musicDirs.length, lastScan: iso(s.finishedAt) } };
};

M.startScan = (req) => {
  if (!req.user.is_admin) fail(50, 'Only admins can scan the library');
  scanLibrary({ full: bool(req, 'fullScan') }).catch((err) => log.warn('[subsonic] Scan failed:', err.message));
  return M.getScanStatus(req);
};

// ── Not offered by Sonara (answered politely so apps don't stumble)

M.getVideos = () => ({ videos: {} });
M.getChatMessages = () => ({ chatMessages: {} });
M.addChatMessage = () => ({});
for (const m of ['getVideoInfo', 'getCaptions', 'hls', 'getTranscodeDecision']) M[m] = () => notFound('Video');
M.jukeboxControl = () => fail(50, 'Use Sonara’s devices menu to play on the server speakers');

// ───────────────────────── Sign-in ─────────────────────────

const failures = new Map(); // ip -> { n, reset }
function tooManyFailures(ip) {
  const f = failures.get(ip);
  return f && f.reset > Date.now() && f.n >= 20;
}
function noteFailure(ip) {
  const now = Date.now();
  const f = failures.get(ip);
  if (!f || f.reset < now) failures.set(ip, { n: 1, reset: now + 15 * 60000 });
  else f.n++;
}
setInterval(() => { const now = Date.now(); for (const [k, f] of failures) if (f.reset < now) failures.delete(k); }, 10 * 60000).unref();

const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');
const same = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** Who is calling, or a Subsonic error. Sets req.subsonicVia: 'app' (app password) or 'password'. */
function authenticate(req) {
  const cfg = getConfig();
  const ip = req.ip;
  if (tooManyFailures(ip)) fail(40, 'Too many failed sign-ins. Try again in a few minutes.');
  const apiKey = param(req, 'apiKey');
  const u = param(req, 'u');
  if (apiKey != null) {
    if (u != null || param(req, 'p') != null || param(req, 't') != null) fail(43, 'Use either an API key or a username and password, not both');
    const row = appPasswordByKey(apiKey);
    if (!row) { noteFailure(ip); fail(44, 'Invalid API key'); }
    touchAppPassword(row.id, param(req, 'c'));
    req.subsonicVia = 'app';
    return q('SELECT * FROM users WHERE id = ?').get(row.user_id);
  }
  if (u == null) missing('u');
  const user = q('SELECT * FROM users WHERE username = ?').get(String(u));
  const t = param(req, 't');
  const s = param(req, 's');
  let p = param(req, 'p');
  if (t != null || s != null) {
    if (t == null || s == null) missing(t == null ? 't' : 's');
    const app = user && findAppPassword(user.id, (secret) => same(md5(secret + s), String(t).toLowerCase()));
    if (app) { touchAppPassword(app.id, param(req, 'c')); req.subsonicVia = 'app'; return user; }
    noteFailure(ip);
    fail(40, 'Wrong username or password. Token sign-in needs an app password: create one in Sonara under Settings → Account → App passwords.');
  }
  if (p == null) missing('p');
  if (p.startsWith('enc:')) p = Buffer.from(p.slice(4), 'hex').toString('utf8');
  if (user) {
    const app = findAppPassword(user.id, (secret) => same(secret, p));
    if (app) { touchAppPassword(app.id, param(req, 'c')); req.subsonicVia = 'app'; return user; }
    const mainAllowed = cfg.subsonicMainPassword !== false && cfg.passwordLogin !== false && !user.totp_secret;
    if (mainAllowed && verifyPassword(p, user.password_hash)) { req.subsonicVia = 'password'; return user; }
  }
  noteFailure(ip);
  return fail(40, user?.totp_secret
    ? 'This account uses two-factor sign-in. Create an app password in Sonara (Settings → Account → App passwords) and use it here.'
    : 'Wrong username or password');
}

// ───────────────────────── Router ─────────────────────────

export const subsonicApi = express.Router();
subsonicApi.use(express.urlencoded({ extended: false, limit: '1mb' }));

// Apps on other origins (web clients such as Feishin in a browser) call this directly.
subsonicApi.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }
  next();
});

subsonicApi.all('/:method', async (req, res) => {
  const name = req.params.method.replace(/\.view$/, '');
  try {
    if (getConfig().subsonic === false) fail(0, 'The Subsonic API is turned off on this server');
    const handler = M[name];
    // getOpenSubsonicExtensions works without signing in, so apps can check what's supported first.
    if (name !== 'getOpenSubsonicExtensions') {
      const user = authenticate(req);
      if (!user) fail(40, 'Wrong username or password');
      req.user = user;
    }
    if (!handler) fail(0, `Sonara doesn't support ${name}`);
    const dirs = req.user ? libraryDirsOf(req.user) : null;
    // Always set the scope (null = whole library), so nothing from an outer request leaks in.
    await libraryScope.run({ dirs, userId: req.user?.id }, async () => {
      if (RAW.has(name)) return handler(req, res);
      const body = await handler(req, res);
      if (!res.headersSent) send(req, res, body);
    });
  } catch (err) {
    if (res.headersSent) return;
    if (err instanceof SubsonicError) {
      // Missing media gets a real 404 so players don't try to decode an XML error as audio.
      if (RAW.has(name) && err.code === 70) return res.status(404).end();
      return send(req, res, { error: { code: err.code, message: err.message } }, 'failed');
    }
    log.warn(`[subsonic] ${name} failed:`, err.message);
    send(req, res, { error: { code: 0, message: err.message || 'Something went wrong' } }, 'failed');
  }
});

/** Every method this server answers, for the docs and tests. */
export const subsonicMethods = () => Object.keys(M).sort();
