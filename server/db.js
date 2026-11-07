// SQLite database using Node's built-in `node:sqlite` (no native build step,
// so installs work the same on Linux, macOS and Windows).
//
// Schema changes go in MIGRATIONS (append only!). They run automatically at
// startup, which is what lets the update script pull new code safely onto an
// existing database.

import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { DB_FILE, DATA_DIR, BACKUPS_DIR } from './config.js';
import { log } from './logger.js';

// A restore uploaded from Settings is swapped in here, before the database is opened.
export const RESTORE_FILE = path.join(DATA_DIR, 'restore-pending.db');
if (fs.existsSync(RESTORE_FILE)) {
  try {
    if (fs.existsSync(DB_FILE)) {
      const stamp = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+/, '');
      const cur = new DatabaseSync(DB_FILE);
      cur.prepare('VACUUM INTO ?').run(path.join(BACKUPS_DIR, `sonara-${stamp}-before-restore.db`));
      cur.close();
    }
    for (const ext of ['-wal', '-shm']) fs.rmSync(DB_FILE + ext, { force: true });
    fs.renameSync(RESTORE_FILE, DB_FILE);
    log.info('[db] Restored the database from an uploaded backup');
  } catch (err) {
    log.error('[db] Could not restore the uploaded backup, keeping the current database', err);
    fs.rmSync(RESTORE_FILE, { force: true });
  }
}

export const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
`);

const MIGRATIONS = [
  // 1 — initial schema
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX idx_sessions_user ON sessions(user_id);

  CREATE TABLE tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    mtime INTEGER NOT NULL,
    size INTEGER NOT NULL,
    title TEXT NOT NULL,
    artist TEXT NOT NULL,
    artist_id TEXT NOT NULL,
    album TEXT NOT NULL,
    album_id TEXT NOT NULL,
    album_artist TEXT NOT NULL,
    album_artist_id TEXT NOT NULL,
    track_no INTEGER,
    disc_no INTEGER,
    year INTEGER,
    genre TEXT,
    duration REAL,
    bitrate INTEGER,
    sample_rate INTEGER,
    codec TEXT,
    lossless INTEGER NOT NULL DEFAULT 0,
    cover TEXT,
    added_at INTEGER NOT NULL
  );
  CREATE INDEX idx_tracks_album ON tracks(album_id, disc_no, track_no);
  CREATE INDEX idx_tracks_artist ON tracks(artist_id);
  CREATE INDEX idx_tracks_album_artist ON tracks(album_artist_id);
  CREATE INDEX idx_tracks_added ON tracks(added_at);
  CREATE INDEX idx_tracks_title ON tracks(title COLLATE NOCASE);

  CREATE TABLE favorites (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, track_id)
  );

  CREATE TABLE plays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    played_at INTEGER NOT NULL
  );
  CREATE INDEX idx_plays_user ON plays(user_id, played_at);
  CREATE INDEX idx_plays_track ON plays(track_id);

  CREATE TABLE playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE playlist_tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    position INTEGER NOT NULL
  );
  CREATE INDEX idx_playlist_tracks ON playlist_tracks(playlist_id, position);
  `,

  // 2 — richer metadata (multi-artist, multi-genre, MusicBrainz, ReplayGain,
  // release info), artist images, ratings and server-side player state.
  `
  ALTER TABLE tracks ADD COLUMN original_year INTEGER;
  ALTER TABLE tracks ADD COLUMN release_type TEXT;
  ALTER TABLE tracks ADD COLUMN compilation INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tracks ADD COLUMN mbz_track_id TEXT;
  ALTER TABLE tracks ADD COLUMN mbz_album_id TEXT;
  ALTER TABLE tracks ADD COLUMN mbz_artist_id TEXT;
  ALTER TABLE tracks ADD COLUMN rg_track_gain REAL;
  ALTER TABLE tracks ADD COLUMN rg_track_peak REAL;
  ALTER TABLE tracks ADD COLUMN rg_album_gain REAL;
  ALTER TABLE tracks ADD COLUMN rg_album_peak REAL;
  CREATE INDEX idx_tracks_year ON tracks(year);

  -- Every credited artist of a track. role: 'artist' (track artists) or 'album' (album artists).
  CREATE TABLE track_artists (
    track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    artist_id TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (track_id, role, artist_id)
  );
  CREATE INDEX idx_track_artists_artist ON track_artists(artist_id);

  CREATE TABLE track_genres (
    track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    genre TEXT NOT NULL,
    PRIMARY KEY (track_id, genre)
  );
  CREATE INDEX idx_track_genres_genre ON track_genres(genre);

  CREATE TABLE artist_images (
    artist_id TEXT PRIMARY KEY,
    image TEXT NOT NULL
  );

  CREATE TABLE ratings (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    rating INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, track_id)
  );

  CREATE TABLE player_state (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    state TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  -- Backfill from existing columns so the library works before the next scan...
  INSERT INTO track_artists (track_id, artist_id, name, role, position) SELECT id, artist_id, artist, 'artist', 0 FROM tracks;
  INSERT OR IGNORE INTO track_artists (track_id, artist_id, name, role, position) SELECT id, album_artist_id, album_artist, 'album', 0 FROM tracks;
  INSERT INTO track_genres (track_id, genre) SELECT id, genre FROM tracks WHERE genre IS NOT NULL AND genre != '';
  -- ...and make the next scan re-read every file to pick up the new tags.
  UPDATE tracks SET mtime = 0;
  `,

  // 3 — transcoding (formats browsers can't play), cue sheets, per-user bitrate limits.
  `
  ALTER TABLE tracks ADD COLUMN needs_transcode INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tracks ADD COLUMN cue_file TEXT;
  ALTER TABLE tracks ADD COLUMN cue_start REAL;
  ALTER TABLE tracks ADD COLUMN cue_end REAL;
  CREATE INDEX idx_tracks_cue ON tracks(cue_file);
  ALTER TABLE users ADD COLUMN max_bitrate INTEGER NOT NULL DEFAULT 0;
  UPDATE tracks SET needs_transcode = 1 WHERE codec LIKE '%ALAC%';
  `,

  // 4 — lyrics, smart playlists, online artist info, scrobbling.
  `
  -- Looked-up lyrics per track. text NULL = nothing found (so we don't keep looking).
  CREATE TABLE lyrics (
    track_id INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
    text TEXT,
    synced INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL,
    file_mtime INTEGER,
    fetched_at INTEGER NOT NULL
  );

  CREATE TABLE smart_playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    rules TEXT NOT NULL,
    sort TEXT NOT NULL DEFAULT 'random',
    max_tracks INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE artist_info (
    artist_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    mbid TEXT,
    bio TEXT,
    bio_source TEXT,
    url TEXT,
    image TEXT,
    fetched_at INTEGER NOT NULL
  );

  -- Per-user connections to Last.fm / ListenBrainz.
  CREATE TABLE user_services (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (user_id, service)
  );

  -- Scrobbles waiting to be sent (retried when a service is down).
  CREATE TABLE scrobble_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service TEXT NOT NULL,
    payload TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_scrobble_next ON scrobble_queue(next_at);

  -- Albums we already asked the Cover Art Archive about.
  CREATE TABLE cover_lookups (
    album_id TEXT PRIMARY KEY,
    tried_at INTEGER NOT NULL,
    found INTEGER NOT NULL DEFAULT 0,
    cover TEXT
  );
  `,

  // 5 — sharing, collaborative playlists, playlist files, permissions, library access,
  // two-factor and external sign-in, scan history.
  `
  -- JSON: { download, share, playlists, jukebox } (missing keys use the defaults).
  ALTER TABLE users ADD COLUMN permissions TEXT NOT NULL DEFAULT '{}';
  -- JSON array of folders this user may see; NULL = the whole library.
  ALTER TABLE users ADD COLUMN library_dirs TEXT;
  ALTER TABLE users ADD COLUMN totp_secret TEXT;
  ALTER TABLE users ADD COLUMN auth_source TEXT NOT NULL DEFAULT 'local';
  ALTER TABLE users ADD COLUMN external_id TEXT;
  CREATE INDEX idx_users_external ON users(auth_source, external_id);

  -- private | public (everyone can listen) | collaborative (everyone can add, remove and reorder)
  ALTER TABLE playlists ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private';
  -- Playlists imported automatically from .m3u files in the music folders.
  ALTER TABLE playlists ADD COLUMN source_path TEXT;
  ALTER TABLE playlists ADD COLUMN source_mtime INTEGER;
  ALTER TABLE playlist_tracks ADD COLUMN added_by INTEGER;

  CREATE TABLE shares (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,           -- track | album | playlist
    ref TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    allow_download INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER,           -- NULL = never
    created_at INTEGER NOT NULL,
    views INTEGER NOT NULL DEFAULT 0,
    last_viewed_at INTEGER
  );
  CREATE INDEX idx_shares_user ON shares(user_id);

  CREATE TABLE scan_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER NOT NULL,
    full INTEGER NOT NULL DEFAULT 0,
    found INTEGER NOT NULL DEFAULT 0,
    added INTEGER NOT NULL DEFAULT 0,
    updated INTEGER NOT NULL DEFAULT 0,
    removed INTEGER NOT NULL DEFAULT 0,
    errors INTEGER NOT NULL DEFAULT 0,
    skipped INTEGER NOT NULL DEFAULT 0,
    playlists INTEGER NOT NULL DEFAULT 0,
    error TEXT
  );
  `,

  // 6 — album covers chosen in the UI (re-applied after every scan).
  `
  CREATE TABLE cover_overrides (
    album_id TEXT PRIMARY KEY,
    cover TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,

  // 7 — podcasts and internet radio.
  `
  -- One row per feed, shared by everyone who subscribes to it.
  CREATE TABLE podcasts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_url TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    link TEXT,
    image TEXT,                   -- cached cover (file in data/covers)
    image_url TEXT,
    etag TEXT,
    last_modified TEXT,
    last_checked INTEGER,
    last_error TEXT,
    trusted INTEGER NOT NULL DEFAULT 0,       -- added by an admin: may live on the local network
    auto_download INTEGER NOT NULL DEFAULT 0, -- keep the newest N episodes downloaded (0 = off)
    created_at INTEGER NOT NULL
  );

  CREATE TABLE podcast_subscriptions (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    podcast_id INTEGER NOT NULL REFERENCES podcasts(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, podcast_id)
  );
  CREATE INDEX idx_podcast_subs_podcast ON podcast_subscriptions(podcast_id);

  CREATE TABLE podcast_episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    podcast_id INTEGER NOT NULL REFERENCES podcasts(id) ON DELETE CASCADE,
    guid TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    published_at INTEGER,
    duration REAL,
    audio_url TEXT NOT NULL,
    mime TEXT,
    size INTEGER,
    season INTEGER,
    episode INTEGER,
    file TEXT,                    -- downloaded copy (relative to data/podcasts)
    file_size INTEGER,
    UNIQUE (podcast_id, guid)
  );
  CREATE INDEX idx_podcast_episodes_date ON podcast_episodes(podcast_id, published_at);

  CREATE TABLE podcast_progress (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    episode_id INTEGER NOT NULL REFERENCES podcast_episodes(id) ON DELETE CASCADE,
    position REAL NOT NULL DEFAULT 0,
    played INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, episode_id)
  );

  -- Internet radio stations, per user.
  CREATE TABLE radio_stations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    stream_url TEXT NOT NULL,
    homepage TEXT,
    image TEXT,
    tags TEXT NOT NULL DEFAULT '',
    country TEXT,
    codec TEXT,
    bitrate INTEGER,
    plays INTEGER NOT NULL DEFAULT 0,
    last_played_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_radio_stations_user ON radio_stations(user_id);
  `,
];

function migrate() {
  const { user_version: current } = db.prepare('PRAGMA user_version').get();
  for (let v = current; v < MIGRATIONS.length; v++) {
    log.info(`[db] Applying migration ${v + 1}`);
    tx(() => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

/** Run fn inside a transaction (nesting-safe via savepoints). */
let depth = 0;
export function tx(fn) {
  const sp = `sp${depth}`;
  db.exec(depth === 0 ? 'BEGIN' : `SAVEPOINT ${sp}`);
  depth++;
  try {
    const result = fn();
    depth--;
    db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
    return result;
  } catch (err) {
    depth--;
    db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}`);
    throw err;
  }
}

// ───────── Per-user library access ─────────
// Users can be limited to some music folders. Rather than threading a filter
// through every query, the request runs inside `libraryScope` and q() rewrites
// reads of the tracks table (FROM/JOIN tracks [alias]) into a filtered sub-select.

export const libraryScope = new AsyncLocalStorage();
const dirCache = new Map();
db.function('sonara_in_dirs', { deterministic: true }, (p, json) => {
  let dirs = dirCache.get(json);
  if (!dirs) { dirs = JSON.parse(json); dirCache.set(json, dirs); }
  const s = String(p);
  return dirs.some((d) => s === d || s.startsWith(d.endsWith(path.sep) ? d : d + path.sep)) ? 1 : 0;
});
const KEYWORDS = new Set(['WHERE', 'GROUP', 'ORDER', 'LIMIT', 'JOIN', 'LEFT', 'INNER', 'CROSS', 'ON', 'USING', 'HAVING', 'UNION', 'SET', 'WINDOW', 'AS', 'NATURAL', 'EXCEPT', 'INTERSECT']);
export function scopeSql(sql, dirs) {
  if (/^\s*(DELETE|UPDATE|INSERT\s+(OR\s+\w+\s+)?INTO\s+tracks\b)/i.test(sql)) return sql;
  const lit = `'${JSON.stringify(dirs).replace(/'/g, "''")}'`;
  return sql.replace(/\b(FROM|JOIN)\s+tracks\b(\s+(?:AS\s+)?([A-Za-z_]\w*))?/gi, (m, kw, aliasPart, alias) => {
    let a = 'tracks';
    let rest = '';
    if (alias && !KEYWORDS.has(alias.toUpperCase())) a = alias;
    else if (aliasPart) rest = aliasPart;
    return `${kw} (SELECT * FROM tracks WHERE sonara_in_dirs(path, ${lit})) AS ${a}${rest}`;
  });
}

// Cache prepared statements by SQL text.
const cache = new Map();
export function q(sql) {
  const dirs = libraryScope.getStore()?.dirs;
  if (dirs) sql = scopeSql(sql, dirs);
  let stmt = cache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    cache.set(sql, stmt);
  }
  return stmt;
}

migrate();
