// Library scanner: walks the configured music folders, reads tags + cover art,
// and keeps the tracks table in sync. Unchanged files (same mtime + size) are
// skipped, so rescans are fast.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseFile, selectCover } from 'music-metadata';
import { db, q, tx } from './db.js';
import { COVERS_DIR, getConfig } from './config.js';
import { log } from './logger.js';

// Formats browsers can actually play.
export const AUDIO_EXT = new Set(['.mp3', '.flac', '.m4a', '.mp4', '.aac', '.ogg', '.oga', '.opus', '.wav', '.webm']);
const FOLDER_ART = ['cover', 'folder', 'front', 'album', 'albumart'];
const ARTIST_ART = ['artist', 'artist-image', 'artistimage'];
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp'];
const CONCURRENCY = 4;
// Audio files we recognise but can't play yet (they need transcoding, see ROADMAP stage 2).
const UNSUPPORTED_EXT = new Set(['.wma', '.ape', '.wv', '.aiff', '.aif', '.dsf', '.dff', '.mpc', '.tta', '.alac', '.ac3', '.dts', '.mka']);
const MAX_ISSUES = 300;

const state = {
  running: false,
  phase: 'idle',
  found: 0,
  processed: 0,
  added: 0,
  updated: 0,
  removed: 0,
  errors: 0,
  current: '',
  startedAt: null,
  finishedAt: null,
  lastError: null,
  skipped: 0,
  issues: [], // [{ path, reason, kind: 'error' | 'skipped' }] from the last scan
  watching: false,
};

export function scanStatus({ issues = false } = {}) {
  const s = { ...state, issueCount: state.issues.length };
  if (!issues) delete s.issues;
  return s;
}

function addIssue(file, reason, kind) {
  if (state.issues.length < MAX_ISSUES) state.issues.push({ path: file, reason, kind });
}

export const idOf = (...parts) =>
  crypto.createHash('sha1').update(parts.map((p) => String(p).trim().toLowerCase()).join('\u0000')).digest('hex').slice(0, 16);

async function* walk(dir) {
  let handle;
  try {
    handle = await fsp.opendir(dir);
  } catch (err) {
    log.warn(`[scan] Cannot read ${dir}: ${err.message}`);
    return;
  }
  for await (const entry of handle) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (AUDIO_EXT.has(ext)) yield full;
      else if (UNSUPPORTED_EXT.has(ext)) {
        state.skipped++;
        addIssue(full, `${ext.slice(1).toUpperCase()} files can't be played in browsers yet`, 'skipped');
      }
    }
  }
}

function saveCover(data, format) {
  const ext = /png/i.test(format) ? 'png' : /webp/i.test(format) ? 'webp' : 'jpg';
  const name = `${crypto.createHash('sha1').update(data).digest('hex')}.${ext}`;
  const file = path.join(COVERS_DIR, name);
  if (!fs.existsSync(file)) fs.writeFileSync(file, data);
  return name;
}

// Cache folder art lookups per directory during a scan.
// A named file (cover.jpg, folder.png...) wins over embedded art; a lone,
// unnamed image in the folder is only used when there is no embedded art.
const folderArtCache = new Map();
async function folderCover(dir, namedOnly = false) {
  if (!folderArtCache.has(dir)) {
    const found = { named: null, any: null };
    try {
      const files = await fsp.readdir(dir);
      const candidates = files.filter((f) => IMAGE_EXT.includes(path.extname(f).toLowerCase()));
      const named = FOLDER_ART.map((n) => candidates.find((f) => path.parse(f).name.toLowerCase() === n)).find(Boolean);
      const pick = named || (candidates.length === 1 && !ARTIST_ART.includes(path.parse(candidates[0]).name.toLowerCase()) ? candidates[0] : null);
      if (pick) {
        const name = saveCover(await fsp.readFile(path.join(dir, pick)), path.extname(pick));
        found.any = name;
        if (named) found.named = name;
      }
    } catch { /* ignore */ }
    folderArtCache.set(dir, found);
  }
  const f = folderArtCache.get(dir);
  return namedOnly ? f.named : f.any;
}

// ───────── Tag helpers ─────────

const VARIOUS = 'Various Artists';
const FEAT_RE = /\s+(?:feat\.?|ft\.?|featuring|with)\s+/i;
const TITLE_FEAT_RE = /\s*[([](?:feat\.?|ft\.?|featuring)\s+([^)\]]+)[)\]]/i;
const LIST_SEP_RE = /\s*(?:;|\s\/\s|\u0000)\s*/;
const GENRE_SEP_RE = /\s*(?:;|\/|\||,|\u0000)\s*/;
const RELEASE_TYPES = ['album', 'ep', 'single', 'compilation', 'live', 'soundtrack', 'remix', 'demo', 'mixtape', 'dj-mix', 'spokenword', 'audiobook', 'interview', 'broadcast', 'other'];

const uniqBy = (arr, key) => {
  const seen = new Set();
  return arr.filter((x) => {
    const k = key(x);
    if (!x || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

/** Split a credit like "A feat. B & C; D" into ["A", "B & C", "D"]. */
function splitArtists(value) {
  if (!value) return [];
  return value.split(LIST_SEP_RE).flatMap((part) => part.split(FEAT_RE)).map((s) => s.trim()).filter(Boolean);
}

/** Main artist display string, multi-artist list, and featured artists found in the title. */
function parseArtists(c, fallback) {
  const display = c.artist?.trim() || c.artists?.join(', ') || fallback;
  let list = (c.artists?.length > 1 ? c.artists : splitArtists(display)).map((s) => s.trim()).filter(Boolean);
  const feat = c.title?.match(TITLE_FEAT_RE);
  if (feat) list.push(...splitArtists(feat[1].replace(/\s*(?:,|&|and)\s*/gi, ';')));
  list = uniqBy(list.length ? list : [display], (s) => s.toLowerCase());
  return { display, list };
}

function parseGenres(c) {
  return uniqBy((c.genre || []).flatMap((g) => String(g).split(GENRE_SEP_RE)).map((g) => g.trim()).filter(Boolean), (g) => g.toLowerCase());
}

function releaseType(c, compilation) {
  const types = (c.releasetype || []).flatMap((t) => String(t).toLowerCase().split(/[\s;,/]+/)).filter((t) => RELEASE_TYPES.includes(t));
  // MusicBrainz puts the primary type first and secondary types (live, compilation...) after it.
  const secondary = types.find((t) => t !== 'album' && t !== 'ep' && t !== 'single' && t !== 'other');
  if (secondary) return secondary;
  if (compilation) return 'compilation';
  return types[0] || null;
}

const num = (v) => (Number.isFinite(v) ? v : null);
const gain = (g) => num(g?.dB);
const peak = (p) => num(p?.ratio ?? (Number.isFinite(p?.dB) ? 10 ** (p.dB / 20) : null));

// Artist images: artist.jpg next to the album folder (Artist/artist.jpg) or inside it.
const artistArtCache = new Map();
async function artistImage(albumDir) {
  for (const dir of [path.dirname(albumDir), albumDir]) {
    if (artistArtCache.has(dir)) {
      if (artistArtCache.get(dir)) return artistArtCache.get(dir);
      continue;
    }
    let found = null;
    try {
      const pick = (await fsp.readdir(dir)).find((f) => IMAGE_EXT.includes(path.extname(f).toLowerCase())
        && ARTIST_ART.includes(path.parse(f).name.toLowerCase()));
      if (pick) found = saveCover(await fsp.readFile(path.join(dir, pick)), path.extname(pick));
    } catch { /* ignore */ }
    artistArtCache.set(dir, found);
    if (found) return found;
  }
  return null;
}

async function readTrack(file, stat) {
  const meta = await parseFile(file, { duration: false, skipCovers: false });
  const c = meta.common;
  const f = meta.format;
  // Fallbacks for untagged files, assuming a .../Artist/Album/01 Title.ext layout.
  const base = path.parse(file).name;
  const numbered = base.match(/^(\d{1,3})[\s.\-_]+(.+)$/);
  const dir = path.dirname(file);
  const parentDir = path.basename(dir);
  const grandDir = path.basename(path.dirname(dir));
  const roots = getConfig().musicDirs.map((d) => path.resolve(d));
  const inRoot = roots.includes(dir);
  const albumInRoot = inRoot || roots.includes(path.dirname(dir));

  const title = c.title?.trim() || (numbered ? numbered[2] : base);
  const artists = parseArtists(c, (!albumInRoot && grandDir) || 'Unknown Artist');
  const compilation = !!c.compilation;
  const albumArtistRaw = c.albumartist?.trim() || (c.albumartists?.length ? c.albumartists.join(', ') : '');
  const albumArtist = albumArtistRaw || (compilation ? VARIOUS : artists.list[0]);
  const albumArtists = albumArtist === VARIOUS ? [VARIOUS] : uniqBy(splitArtists(albumArtist), (s) => s.toLowerCase());
  const album = c.album?.trim() || (!inRoot && parentDir) || 'Unknown Album';
  const mbzAlbum = c.musicbrainz_albumid || null;
  const pic = selectCover(c.picture);
  const cover = (await folderCover(dir, true)) || (pic ? saveCover(pic.data, pic.format) : await folderCover(dir));
  const genres = parseGenres(c);
  const albumArtistId = idOf(albumArtists[0] || albumArtist);
  return {
    path: file,
    mtime: Math.floor(stat.mtimeMs),
    size: stat.size,
    title,
    artist: artists.display,
    artist_id: idOf(artists.list[0]),
    album,
    album_id: mbzAlbum ? idOf('mbz', mbzAlbum) : idOf(albumArtist, album),
    album_artist: albumArtist,
    album_artist_id: albumArtistId,
    track_no: c.track?.no ?? (numbered ? Number(numbered[1]) : null),
    disc_no: c.disk?.no ?? null,
    year: c.year ?? null,
    genre: genres[0] ?? null,
    duration: f.duration ?? null,
    bitrate: f.bitrate ? Math.round(f.bitrate) : null,
    sample_rate: f.sampleRate ?? null,
    codec: f.codec ?? f.container ?? null,
    lossless: f.lossless ? 1 : 0,
    cover,
    original_year: c.originalyear ?? (c.originaldate ? Number.parseInt(c.originaldate, 10) || null : null),
    release_type: releaseType(c, compilation),
    compilation: compilation ? 1 : 0,
    mbz_track_id: c.musicbrainz_recordingid || c.musicbrainz_trackid || null,
    mbz_album_id: mbzAlbum,
    mbz_artist_id: c.musicbrainz_artistid?.[0] || null,
    rg_track_gain: gain(c.replaygain_track_gain),
    rg_track_peak: peak(c.replaygain_track_peak),
    rg_album_gain: gain(c.replaygain_album_gain),
    rg_album_peak: peak(c.replaygain_album_peak),
    // Not columns: written to the link tables.
    _artists: artists.list,
    _albumArtists: albumArtists,
    _genres: genres,
    _artistImage: albumArtist === VARIOUS ? null : await artistImage(dir),
    _albumArtistId: albumArtistId,
  };
}

const COLS = ['path', 'mtime', 'size', 'title', 'artist', 'artist_id', 'album', 'album_id', 'album_artist',
  'album_artist_id', 'track_no', 'disc_no', 'year', 'genre', 'duration', 'bitrate', 'sample_rate', 'codec', 'lossless', 'cover',
  'original_year', 'release_type', 'compilation', 'mbz_track_id', 'mbz_album_id', 'mbz_artist_id',
  'rg_track_gain', 'rg_track_peak', 'rg_album_gain', 'rg_album_peak'];

function upsert(rows) {
  const insert = q(`INSERT INTO tracks (${COLS.join(', ')}, added_at) VALUES (${COLS.map((c) => '$' + c).join(', ')}, $added_at)
    ON CONFLICT(path) DO UPDATE SET ${COLS.filter((c) => c !== 'path').map((c) => `${c} = excluded.${c}`).join(', ')}
    RETURNING id`);
  const clearArtists = q('DELETE FROM track_artists WHERE track_id = ?');
  const addArtist = q('INSERT OR IGNORE INTO track_artists (track_id, artist_id, name, role, position) VALUES (?, ?, ?, ?, ?)');
  const clearGenres = q('DELETE FROM track_genres WHERE track_id = ?');
  const addGenre = q('INSERT OR IGNORE INTO track_genres (track_id, genre) VALUES (?, ?)');
  const setImage = q('INSERT INTO artist_images (artist_id, image) VALUES (?, ?) ON CONFLICT(artist_id) DO UPDATE SET image = excluded.image');
  tx(() => {
    for (const r of rows) {
      const params = { added_at: Date.now() };
      for (const c of COLS) params[c] = r[c];
      const { id } = insert.get(params);
      clearArtists.run(id);
      r._artists.forEach((name, i) => addArtist.run(id, idOf(name), name, 'artist', i));
      r._albumArtists.forEach((name, i) => addArtist.run(id, idOf(name), name, 'album', i));
      clearGenres.run(id);
      for (const g of r._genres) addGenre.run(id, g);
      if (r._artistImage) setImage.run(r._albumArtistId, r._artistImage);
    }
  });
}

/**
 * Scan all configured folders.
 * @param {{ full?: boolean }} opts full=true re-reads every file even if unchanged.
 */
export async function scanLibrary({ full = false } = {}) {
  if (state.running) return false;
  const roots = getConfig().musicDirs.map((d) => path.resolve(d));
  Object.assign(state, {
    running: true, phase: 'discovering', found: 0, processed: 0, added: 0, updated: 0,
    removed: 0, errors: 0, current: '', startedAt: Date.now(), finishedAt: null, lastError: null, skipped: 0, issues: [],
  });
  folderArtCache.clear();
  artistArtCache.clear();
  log.info(`[scan] Starting ${full ? 'full ' : ''}scan of ${roots.length} folder(s)`);

  try {
    const known = new Map(q('SELECT id, path, mtime, size FROM tracks').all().map((r) => [r.path, r]));
    const seen = new Set();
    const reachable = [];
    const todo = [];

    for (const root of roots) {
      if (!fs.existsSync(root)) {
        log.warn(`[scan] Folder not found (skipping, existing tracks kept): ${root}`);
        continue;
      }
      reachable.push(root);
      for await (const file of walk(root)) {
        state.found++;
        seen.add(file);
        todo.push(file);
      }
    }

    state.phase = 'reading';
    let batch = [];
    const queue = todo.slice();
    const worker = async () => {
      while (queue.length) {
        const file = queue.shift();
        state.current = file;
        try {
          const stat = await fsp.stat(file);
          const prev = known.get(file);
          if (!full && prev && prev.mtime === Math.floor(stat.mtimeMs) && prev.size === stat.size) {
            state.processed++;
            continue;
          }
          batch.push(await readTrack(file, stat));
          prev ? state.updated++ : state.added++;
        } catch (err) {
          state.errors++;
          state.lastError = `${path.basename(file)}: ${err.message}`;
          addIssue(file, err.message, 'error');
          log.warn(`[scan] Failed to read ${file}: ${err.message}`);
        }
        state.processed++;
        if (batch.length >= 200) {
          const b = batch;
          batch = [];
          upsert(b);
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    if (batch.length) upsert(batch);

    // Remove tracks whose files disappeared. Tracks under a folder that is
    // currently unreachable (e.g. unmounted drive) are kept.
    state.phase = 'cleaning';
    const isUnder = (p, root) => p === root || p.startsWith(root + path.sep);
    const del = q('DELETE FROM tracks WHERE id = ?');
    tx(() => {
      for (const [p, row] of known) {
        if (seen.has(p)) continue;
        const inReachable = reachable.some((r) => isUnder(p, r));
        const inAnyRoot = roots.some((r) => isUnder(p, r));
        if (inReachable || !inAnyRoot) {
          del.run(row.id);
          state.removed++;
        }
      }
    });
    q(`DELETE FROM artist_images WHERE artist_id NOT IN (SELECT album_artist_id FROM tracks)`).run();
    db.exec('PRAGMA optimize');
    log.info(`[scan] Done: ${state.found} files, +${state.added} new, ${state.updated} updated, -${state.removed} removed, ${state.errors} errors, ${state.skipped} unsupported`);
  } catch (err) {
    state.lastError = err.message;
    log.error('[scan] Scan failed', err);
  } finally {
    Object.assign(state, { running: false, phase: 'idle', current: '', finishedAt: Date.now() });
  }
  if (rescanPending) {
    rescanPending = false;
    setTimeout(() => scanLibrary(), 1000).unref?.();
  }
  return true;
}

// ───────── Filesystem watching ─────────
// Changes trigger a (fast, incremental) scan a few seconds after things go quiet.

const WATCH_DEBOUNCE_MS = 5000;
let watchers = [];
let watchTimer = null;
let rescanPending = false;

let watchPaused = 0;
let watchResumeAt = 0;

/** Run fn with the watcher ignoring events (Sonara's own file moves/edits), resuming shortly after. */
export async function withWatchPaused(fn) {
  watchPaused++;
  try { return await fn(); } finally {
    watchPaused--;
    watchResumeAt = Date.now() + 3000; // fs events arrive a little late
  }
}

/** Read (or re-read) a single file into the library. Returns the track id. */
export async function scanFile(file) {
  const stat = await fsp.stat(file);
  const dir = path.dirname(file);
  folderArtCache.delete(dir);
  artistArtCache.delete(dir);
  artistArtCache.delete(path.dirname(dir));
  const row = await readTrack(file, stat);
  upsert([row]);
  return q('SELECT id FROM tracks WHERE path = ?').get(file)?.id;
}

function onFsChange(filename) {
  if (watchPaused || Date.now() < watchResumeAt) return;
  if (filename) {
    const name = path.basename(String(filename));
    if (name.startsWith('.')) return;
    const ext = path.extname(name).toLowerCase();
    // Ignore files we don't care about, but react to folders (no extension) being moved or deleted.
    if (ext && !AUDIO_EXT.has(ext) && !IMAGE_EXT.includes(ext) && !UNSUPPORTED_EXT.has(ext)) return;
  }
  clearTimeout(watchTimer);
  watchTimer = setTimeout(() => {
    if (state.running) rescanPending = true;
    else scanLibrary();
  }, WATCH_DEBOUNCE_MS);
  watchTimer.unref?.();
}

export function watchLibrary() {
  for (const w of watchers) w.close();
  watchers = [];
  state.watching = false;
  if (getConfig().watch === false) return;
  for (const root of getConfig().musicDirs.map((d) => path.resolve(d))) {
    if (!fs.existsSync(root)) continue;
    try {
      const w = fs.watch(root, { recursive: true, persistent: false }, (_event, filename) => onFsChange(filename));
      w.on('error', (err) => log.warn(`[watch] Stopped watching ${root}: ${err.message}`));
      watchers.push(w);
    } catch (err) {
      log.warn(`[watch] Cannot watch ${root} (${err.code || err.message}); relying on scheduled scans`);
    }
  }
  state.watching = watchers.length > 0;
  if (watchers.length) log.info(`[watch] Watching ${watchers.length} folder(s) for changes`);
}

let timer = null;
export function scheduleScans() {
  clearInterval(timer);
  const minutes = Number(getConfig().scanIntervalMinutes);
  if (minutes > 0) timer = setInterval(() => scanLibrary(), minutes * 60 * 1000);
  timer?.unref?.();
}
