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
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp'];
const CONCURRENCY = 4;

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
};

export function scanStatus() {
  return { ...state };
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
    else if (entry.isFile() && AUDIO_EXT.has(path.extname(entry.name).toLowerCase())) yield full;
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
const folderArtCache = new Map();
async function folderCover(dir) {
  if (folderArtCache.has(dir)) return folderArtCache.get(dir);
  let found = null;
  try {
    const files = await fsp.readdir(dir);
    const candidates = files.filter((f) => IMAGE_EXT.includes(path.extname(f).toLowerCase()));
    const pick =
      candidates.find((f) => FOLDER_ART.includes(path.parse(f).name.toLowerCase())) ||
      (candidates.length === 1 ? candidates[0] : null);
    if (pick) {
      const data = await fsp.readFile(path.join(dir, pick));
      found = saveCover(data, path.extname(pick));
    }
  } catch { /* ignore */ }
  folderArtCache.set(dir, found);
  return found;
}

async function readTrack(file, stat) {
  const meta = await parseFile(file, { duration: false, skipCovers: false });
  const c = meta.common;
  const f = meta.format;
  // Fallbacks for untagged files, assuming a .../Artist/Album/01 Title.ext layout.
  const base = path.parse(file).name;
  const numbered = base.match(/^(\d{1,3})[\s.\-_]+(.+)$/);
  const parentDir = path.basename(path.dirname(file));
  const grandDir = path.basename(path.dirname(path.dirname(file)));
  const roots = getConfig().musicDirs.map((d) => path.resolve(d));
  const inRoot = roots.includes(path.dirname(file));
  const albumInRoot = inRoot || roots.includes(path.dirname(path.dirname(file)));

  const title = c.title?.trim() || (numbered ? numbered[2] : base);
  const artist = c.artist?.trim() || c.artists?.join(', ') || (!albumInRoot && grandDir) || 'Unknown Artist';
  const albumArtist = c.albumartist?.trim() || artist;
  const album = c.album?.trim() || (!inRoot && parentDir) || 'Unknown Album';
  const pic = selectCover(c.picture);
  const cover = pic ? saveCover(pic.data, pic.format) : await folderCover(path.dirname(file));
  return {
    path: file,
    mtime: Math.floor(stat.mtimeMs),
    size: stat.size,
    title,
    artist,
    artist_id: idOf(artist),
    album,
    album_id: idOf(albumArtist, album),
    album_artist: albumArtist,
    album_artist_id: idOf(albumArtist),
    track_no: c.track?.no ?? (numbered ? Number(numbered[1]) : null),
    disc_no: c.disk?.no ?? null,
    year: c.year ?? null,
    genre: c.genre?.[0] ?? null,
    duration: f.duration ?? null,
    bitrate: f.bitrate ? Math.round(f.bitrate) : null,
    sample_rate: f.sampleRate ?? null,
    codec: f.codec ?? f.container ?? null,
    lossless: f.lossless ? 1 : 0,
    cover,
  };
}

const COLS = ['path', 'mtime', 'size', 'title', 'artist', 'artist_id', 'album', 'album_id', 'album_artist',
  'album_artist_id', 'track_no', 'disc_no', 'year', 'genre', 'duration', 'bitrate', 'sample_rate', 'codec', 'lossless', 'cover'];

function upsert(rows) {
  const insert = q(`INSERT INTO tracks (${COLS.join(', ')}, added_at) VALUES (${COLS.map((c) => '$' + c).join(', ')}, $added_at)
    ON CONFLICT(path) DO UPDATE SET ${COLS.filter((c) => c !== 'path').map((c) => `${c} = excluded.${c}`).join(', ')}`);
  tx(() => {
    for (const r of rows) insert.run({ ...r, added_at: Date.now() });
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
    removed: 0, errors: 0, current: '', startedAt: Date.now(), finishedAt: null, lastError: null,
  });
  folderArtCache.clear();
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
    db.exec('PRAGMA optimize');
    log.info(`[scan] Done: ${state.found} files, +${state.added} new, ${state.updated} updated, -${state.removed} removed, ${state.errors} errors`);
  } catch (err) {
    state.lastError = err.message;
    log.error('[scan] Scan failed', err);
  } finally {
    Object.assign(state, { running: false, phase: 'idle', current: '', finishedAt: Date.now() });
  }
  return true;
}

let timer = null;
export function scheduleScans() {
  clearInterval(timer);
  const minutes = Number(getConfig().scanIntervalMinutes);
  if (minutes > 0) timer = setInterval(() => scanLibrary(), minutes * 60 * 1000);
  timer?.unref?.();
}
