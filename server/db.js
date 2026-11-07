// SQLite database using Node's built-in `node:sqlite` (no native build step,
// so installs work the same on Linux, macOS and Windows).
//
// Schema changes go in MIGRATIONS (append only!). They run automatically at
// startup, which is what lets the update script pull new code safely onto an
// existing database.

import { DatabaseSync } from 'node:sqlite';
import { DB_FILE } from './config.js';
import { log } from './logger.js';

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

// Cache prepared statements by SQL text.
const cache = new Map();
export function q(sql) {
  let stmt = cache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    cache.set(sql, stmt);
  }
  return stmt;
}

migrate();
