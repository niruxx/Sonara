// File operations on the music library: writing tags, moving files and
// organizing folders from a naming template. Everything here changes the
// user's files, so it is admin-only and must be enabled in Settings first
// ("allowFileChanges").
//
// Moves update the existing database row (same track id), so favorites,
// playlists, ratings and play history follow the file to its new place.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { q } from './db.js';
import { getConfig } from './config.js';
import { log } from './logger.js';
import { run, requireTool } from './tools.js';
import { LIBRARY_EXT, scanFile, withWatchPaused } from './scanner.js';

const SIDECAR_IMAGES = ['.jpg', '.jpeg', '.png', '.webp'];

export function assertFileChangesAllowed() {
  if (!getConfig().allowFileChanges) {
    const err = new Error('File changes are turned off. Enable “Allow Sonara to change files” in Settings → Library first.');
    err.status = 403;
    throw err;
  }
}

export const musicRoots = () => getConfig().musicDirs.map((d) => path.resolve(d));
const isUnder = (p, root) => {
  const rel = path.relative(root, p);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
};
export const inLibrary = (p) => musicRoots().some((r) => isUnder(path.resolve(p), r));
export const rootOf = (p) => musicRoots().find((r) => isUnder(path.resolve(p), r)) || null;

export function assertInLibrary(dir) {
  if (!inLibrary(dir)) {
    const err = new Error('The destination must be inside one of your music folders.');
    err.status = 400;
    throw err;
  }
}

// ───────── Names & templates ─────────

const WIN_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** Make a string safe as one file/folder name on every OS. */
export function safeName(s, fallback = '_') {
  let out = String(s ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, (c) => (c === ':' ? ' -' : c === '"' ? "'" : c === '/' || c === '\\' ? '-' : '_'))
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  if (out.length > 120) out = out.slice(0, 120).trim();
  if (!out || WIN_RESERVED.test(out)) out = out ? `_${out}` : fallback;
  return out;
}

export const TEMPLATES = {
  album: { name: 'Artist / Album / Track', template: '{albumartist}/{album}[ ({year})]/[{disc}-]{track} {title}' },
  genre: { name: 'Genre / Artist / Album / Track', template: '{genre}/{albumartist}/{album}[ ({year})]/[{disc}-]{track} {title}' },
  year: { name: 'Year / Artist - Album / Track', template: '{year}/{albumartist} - {album}/[{disc}-]{track} {title}' },
  flat: { name: 'Artist / Artist - Title', template: '{albumartist}/{artist} - {title}' },
  playlist: { name: 'Playlists / Playlist / Artist - Title', template: 'Playlists/{playlist}/{artist} - {title}' },
};

const TOKENS = ['albumartist', 'artist', 'album', 'title', 'track', 'disc', 'year', 'genre', 'playlist', 'type'];

/**
 * Render a template like "{albumartist}/{album}[ ({year})]/{track} {title}" for a track.
 * [ … ] is optional: dropped when any token inside it is empty. "/" separates folders.
 * Returns the relative path without the extension.
 */
export function renderTemplate(template, t, ctx = {}) {
  const pad = (n) => (n ? String(n).padStart(2, '0') : '');
  const values = {
    albumartist: ctx.albumArtist || t.album_artist || t.artist || 'Unknown Artist',
    artist: t.artist || 'Unknown Artist',
    album: t.album || 'Unknown Album',
    title: t.title || path.parse(t.path).name,
    track: pad(t.track_no),
    disc: ctx.discCount > 1 && t.disc_no ? String(t.disc_no) : '',
    year: ctx.year ? String(ctx.year) : t.year ? String(t.year) : '',
    genre: ctx.genre || t.genre || 'Unknown Genre',
    playlist: ctx.playlist || 'Playlist',
    type: t.release_type || (t.compilation ? 'compilation' : 'album'),
  };
  const fill = (s) => s.replace(/\{(\w+)\}/g, (m, k) => (TOKENS.includes(k) ? values[k].replace(/[\\/]/g, '-') : m));
  let out = template.replace(/\[([^\]]*)\]/g, (_, inner) => {
    const keys = [...inner.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    return keys.every((k) => values[k]) ? inner : '';
  });
  out = fill(out);
  const parts = out.split('/').map((p) => safeName(p)).filter((p) => p && p !== '_');
  return parts.join(path.sep) || safeName(values.title);
}

export function validateTemplate(template) {
  const t = String(template || '').trim();
  if (!t) return 'Template is empty';
  if (t.length > 300) return 'Template is too long';
  if (!/\{title\}|\{track\}/.test(t)) return 'Template must include {title} or {track} so files get unique names';
  if (/(^|\/)\.\.?(\/|$)/.test(t)) return 'Template may not contain . or .. folders';
  const unknown = [...t.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).find((k) => !TOKENS.includes(k));
  return unknown ? `Unknown field {${unknown}}` : null;
}

// ───────── Moving ─────────

async function moveFile(from, to) {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  try {
    await fsp.rename(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    // Different drive: copy, then delete the original.
    await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL);
    await fsp.unlink(from);
  }
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

/** Pick a free path by appending " (2)", " (3)"… */
async function freePath(p, taken) {
  const { dir, name, ext } = path.parse(p);
  let candidate = p, n = 1;
  while (taken.has(candidate.toLowerCase()) || await exists(candidate)) candidate = path.join(dir, `${name} (${++n})${ext}`);
  taken.add(candidate.toLowerCase());
  return candidate;
}

/** Remove empty folders from `dir` up to (not including) its music root. */
async function pruneEmpty(dir) {
  const root = rootOf(dir);
  while (root && dir !== root && isUnder(dir, root)) {
    let entries;
    try { entries = await fsp.readdir(dir); } catch { return; }
    // Ignore OS junk when deciding if a folder is empty.
    const real = entries.filter((e) => !['.DS_Store', 'Thumbs.db', 'desktop.ini'].includes(e));
    if (real.length) return;
    for (const e of entries) await fsp.unlink(path.join(dir, e)).catch(() => {});
    try { await fsp.rmdir(dir); } catch { return; }
    dir = path.dirname(dir);
  }
}

const hasAudio = async (dir) => {
  try { return (await fsp.readdir(dir)).some((f) => LIBRARY_EXT.has(path.extname(f).toLowerCase())); } catch { return false; }
};

/**
 * Plan moves for tracks. Each item: { id, from, to }. Unchanged files are left out.
 * opts: { template, root, playlist } or { dir } (keep file names, move into one folder).
 */
export async function planMoves(rows, opts) {
  const taken = new Set();
  const plan = [];
  // Album-wide values, so one album never gets split across folders by per-track tags.
  const albums = new Map(q(`SELECT album_id, COUNT(DISTINCT COALESCE(disc_no, 1)) AS discs, MAX(year) AS year, MAX(album_artist) AS albumArtist,
    (SELECT genre FROM tracks g WHERE g.album_id = t.album_id AND genre IS NOT NULL GROUP BY genre ORDER BY COUNT(*) DESC LIMIT 1) AS genre
    FROM tracks t GROUP BY album_id`).all().map((r) => [r.album_id, r]));
  for (const t of rows) {
    const ext = path.extname(t.path);
    let to;
    if (opts.dir) to = path.join(path.resolve(opts.dir), path.basename(t.path));
    else {
      const root = path.resolve(opts.root || rootOf(t.path) || musicRoots()[0]);
      to = path.join(root, renderTemplate(opts.template, t, { ...(() => {
        const a = albums.get(t.album_id) || {};
        return { discCount: a.discs, year: a.year, genre: a.genre, albumArtist: a.albumArtist };
      })(), playlist: opts.playlist }) + ext.toLowerCase());
    }
    if (path.resolve(to) === path.resolve(t.path)) continue;
    // Same path but different case on a case-insensitive disk: allowed, no suffix.
    const sameIgnoringCase = to.toLowerCase() === t.path.toLowerCase();
    to = sameIgnoringCase ? to : await freePath(to, taken);
    plan.push({ id: t.id, from: t.path, to, title: t.title });
  }
  return plan;
}

/**
 * Execute a plan. mode 'move' updates the library rows in place; 'copy'
 * leaves originals alone (copies inside the library are added as new tracks).
 */
export async function applyMoves(plan, { mode = 'move' } = {}) {
  const done = [], failed = [];
  const sourceDirs = new Set();
  const imageMoves = new Map(); // source dir -> destination dir (only when every track went to one place)
  await withWatchPaused(async () => {
    for (const m of plan) {
      try {
        if (mode === 'copy') {
          await fsp.mkdir(path.dirname(m.to), { recursive: true });
          await fsp.copyFile(m.from, m.to, fs.constants.COPYFILE_EXCL);
          if (inLibrary(m.to)) await scanFile(m.to).catch(() => {});
        } else {
          await moveFile(m.from, m.to);
          const st = await fsp.stat(m.to);
          q('UPDATE tracks SET path = ?, mtime = ?, size = ?, updated_at = ? WHERE id = ?').run(m.to, Math.floor(st.mtimeMs), st.size, Date.now(), m.id);
          // Lyrics with the same name travel along.
          const lrc = m.from.slice(0, -path.extname(m.from).length) + '.lrc';
          if (await exists(lrc)) await moveFile(lrc, m.to.slice(0, -path.extname(m.to).length) + '.lrc').catch(() => {});
          const src = path.dirname(m.from), dst = path.dirname(m.to);
          sourceDirs.add(src);
          imageMoves.set(src, imageMoves.has(src) && imageMoves.get(src) !== dst ? null : dst);
        }
        done.push(m);
      } catch (err) {
        failed.push({ ...m, error: err.message });
        log.warn(`[files] ${mode} failed ${m.from} → ${m.to}: ${err.message}`);
      }
    }
    if (mode !== 'move') return;
    // Folder art (cover.jpg…) follows its album when the old folder has no music left.
    for (const [src, dst] of imageMoves) {
      if (!dst || await hasAudio(src)) continue;
      for (const f of await fsp.readdir(src).catch(() => [])) {
        if (!SIDECAR_IMAGES.includes(path.extname(f).toLowerCase())) continue;
        const target = path.join(dst, f);
        if (!(await exists(target))) await moveFile(path.join(src, f), target).catch(() => {});
      }
    }
    // An artist.jpg one level up follows the artist when its old folder is left with nothing else.
    for (const [src, dst] of imageMoves) {
      const parent = path.dirname(src);
      if (!dst || !rootOf(parent) || parent === rootOf(parent)) continue;
      const entries = await fsp.readdir(parent, { withFileTypes: true }).catch(() => []);
      const subdirs = entries.filter((e) => e.isDirectory() && fs.existsSync(path.join(parent, e.name)) && fs.readdirSync(path.join(parent, e.name)).length);
      if (subdirs.length) continue;
      for (const e of entries) {
        if (!e.isFile() || !/^artist(-?image)?\.(jpe?g|png|webp)$/i.test(e.name)) continue;
        const target = path.join(path.dirname(dst), e.name);
        if (path.dirname(dst) !== parent && !(await exists(target))) await moveFile(path.join(parent, e.name), target).catch(() => {});
      }
      sourceDirs.add(parent);
    }
    for (const d of [...sourceDirs].sort((a, b) => b.length - a.length)) await pruneEmpty(d);
    // Moved files may now pick up different folder art: re-read them.
    for (const m of done) await scanFile(m.to).catch(() => {});
  });
  log.info(`[files] ${mode}: ${done.length} done, ${failed.length} failed`);
  return { done: done.length, failed };
}

// ───────── Tag writing ─────────

// Sonara field → ffmpeg metadata key.
const TAG_KEYS = {
  title: 'title', artist: 'artist', album: 'album', albumArtist: 'album_artist', trackNo: 'track', discNo: 'disc',
  year: 'date', genre: 'genre', composer: 'composer', comment: 'comment',
};
export const EDITABLE_TAGS = Object.keys(TAG_KEYS);

/** Rewrite tags without re-encoding (ffmpeg stream copy into a temp file, then swap). */
export async function writeTags(file, tags) {
  const ffmpeg = await requireTool('ffmpeg');
  const ext = path.extname(file);
  const tmp = path.join(path.dirname(file), `.${path.basename(file, ext)}.sonara-tmp${ext}`);
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-map', '0:a', '-map', '0:v?', '-c', 'copy', '-map_metadata', '0'];
  for (const [k, v] of Object.entries(tags)) {
    if (!TAG_KEYS[k] || v === undefined) continue;
    args.push('-metadata', `${TAG_KEYS[k]}=${v === null ? '' : String(v).replace(/[\r\n]+/g, ' ').slice(0, 1000)}`);
  }
  const lower = ext.toLowerCase();
  if (lower === '.mp3') args.push('-id3v2_version', '3', '-write_id3v1', '0');
  if (['.mp3', '.m4a', '.mp4', '.flac'].includes(lower)) args.push('-disposition:v', 'attached_pic');
  if (lower === '.m4a' || lower === '.mp4') args.push('-movflags', '+faststart');
  args.push(tmp);
  const r = await run(ffmpeg, args);
  if (r.code !== 0) {
    await fsp.unlink(tmp).catch(() => {});
    throw new Error(`ffmpeg could not write tags: ${r.stderr.trim().split('\n').pop() || `exit ${r.code}`}`);
  }
  await fsp.rename(tmp, file);
}

/**
 * Apply the same tag changes to several library tracks and refresh them.
 * Only keys present in `tags` change; null clears a tag.
 */
export async function editTracks(ids, tags) {
  const all = ids.map((id) => q('SELECT id, path, cue_file FROM tracks WHERE id = ?').get(id)).filter(Boolean);
  // Songs cut from one file by a cue sheet share that file: their info lives in the .cue.
  const failed = all.filter((r) => r.cue_file).map((r) => ({ id: r.id, path: r.cue_file, error: 'Part of a cue sheet; edit the .cue file instead' }));
  const rows = all.filter((r) => !r.cue_file);
  await withWatchPaused(async () => {
    for (const r of rows) {
      try {
        await writeTags(r.path, tags);
        await scanFile(r.path);
      } catch (err) {
        failed.push({ id: r.id, path: r.path, error: err.message });
      }
    }
  });
  return { done: rows.length - failed.length, failed };
}

/** Resolve an organize scope to track rows. */
export function scopeTracks(scope) {
  // Songs split from one file by a cue sheet can't be moved one by one; they are left out.
  return scopeTracksAll(scope).filter((t) => !t.cue_file);
}

function scopeTracksAll(scope) {
  const cols = 'id, path, title, artist, album, album_id, album_artist, track_no, disc_no, year, genre, release_type, compilation, cue_file';
  const id = scope?.id;
  switch (scope?.type) {
    case 'tracks': {
      const ids = (scope.ids || []).map(Number).filter(Number.isFinite).slice(0, 20000);
      return q(`SELECT ${cols} FROM tracks WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids));
    }
    case 'album': return q(`SELECT ${cols} FROM tracks WHERE album_id = ?`).all(String(id));
    case 'artist': return q(`SELECT ${cols} FROM tracks WHERE id IN (SELECT track_id FROM track_artists WHERE artist_id = ?) OR album_artist_id = ?`).all(String(id), String(id));
    case 'genre': return q(`SELECT ${cols} FROM tracks WHERE id IN (SELECT track_id FROM track_genres WHERE genre = ?)`).all(String(id));
    case 'playlist': return q(`SELECT ${cols.split(', ').map((c) => 't.' + c).join(', ')} FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
      WHERE pt.playlist_id = ? GROUP BY t.id ORDER BY MIN(pt.position)`).all(Number(id));
    case 'library': return q(`SELECT ${cols} FROM tracks`).all();
    default: return [];
  }
}

