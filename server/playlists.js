// Playlist files: import and export M3U / M3U8 / XSPF, and turn .m3u files
// found in the music folders into (read-only, auto-updating) playlists.

import fs from 'node:fs';
import path from 'node:path';
import { q, tx } from './db.js';
import { getConfig } from './config.js';
import { log } from './logger.js';

export const PLAYLIST_EXT = new Set(['.m3u', '.m3u8', '.xspf']);

// ───────── CSV / TSV (Spotify via Exportify, Apple Music, TuneMyMusic, Soundiiz…) ─────────

function splitDelimited(text, sep) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === sep) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim())) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim())) rows.push(row);
  return rows;
}

/** Spreadsheet exports: finds the title / artist / album / duration columns by their headings. */
function parseDelimited(text) {
  const first = text.split(/\r?\n/, 1)[0];
  const count = (ch) => first.split(ch).length - 1;
  const sep = count('\t') > count(',') ? '\t' : count(';') > count(',') ? ';' : ',';
  const rows = splitDelimited(text, sep);
  if (rows.length < 2) return null;
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...res) => { for (const re of res) { const i = head.findIndex((h) => re.test(h)); if (i >= 0) return i; } return -1; };
  const title = col(/^track ?name$/, /^(song|track|title|name)$/, /track name|song name|^title/);
  const artist = col(/^artist name\(s\)$/, /^artist ?name$/, /^artists?$/, /artist/);
  if (title < 0 || artist < 0) return null;
  const album = col(/^album ?name$/, /^album$/);
  const dur = col(/^duration \(ms\)$/, /^time$/, /duration/);
  const entries = rows.slice(1).map((r) => {
    let duration = dur >= 0 ? Number(r[dur]) : undefined;
    if (duration > 10000) duration /= 1000; // milliseconds
    // Exportify lists several artists as "A,B": the first one is enough to match.
    return { title: r[title]?.trim(), artist: r[artist]?.split(/[;,]\s*(?=\S)/)[0]?.trim(), album: album >= 0 ? r[album]?.trim() : undefined, duration: duration || undefined };
  }).filter((e) => e.title);
  return { name: null, entries };
}

const xmlEsc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const xmlUnesc = (s) => String(s ?? '').replace(/&(lt|gt|quot|apos|amp|#\d+|#x[\da-f]+);/gi, (m, e) => {
  const map = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };
  if (map[e.toLowerCase()]) return map[e.toLowerCase()];
  return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
});

/** Parse playlist text into entries: { location?, title?, artist?, album?, duration? }. */
export function parsePlaylist(text, name = '') {
  text = String(text).replace(/^﻿/, '');
  if (/\.(csv|tsv|txt)$/i.test(name) || /^[^\n#]*(track ?name|title|name)[^\n]*[,\t;][^\n]*artist/i.test(text.slice(0, 500))) {
    const r = parseDelimited(text);
    if (r) return r;
  }
  if (/<playlist[\s>]/i.test(text) || name.toLowerCase().endsWith('.xspf')) {
    const entries = [];
    for (const m of text.matchAll(/<track>([\s\S]*?)<\/track>/gi)) {
      const get = (t) => { const r = m[1].match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`, 'i')); return r ? xmlUnesc(r[1].trim()) : undefined; };
      const dur = Number(get('duration'));
      entries.push({ location: get('location'), title: get('title'), artist: get('creator'), album: get('album'), duration: dur ? dur / 1000 : undefined });
    }
    const title = text.match(/<playlist[\s\S]*?<title>([\s\S]*?)<\/title>/i);
    return { name: title ? xmlUnesc(title[1].trim()) : null, entries };
  }
  const entries = [];
  let pending = null;
  let plName = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      const inf = line.match(/^#EXTINF:\s*(-?[\d.]+)[^,]*,(.*)$/i);
      if (inf) {
        const label = inf[2].trim();
        const i = label.indexOf(' - ');
        pending = { duration: Number(inf[1]) > 0 ? Number(inf[1]) : undefined, artist: i > 0 ? label.slice(0, i).trim() : undefined, title: i > 0 ? label.slice(i + 3).trim() : label };
      }
      const pl = line.match(/^#PLAYLIST:\s*(.+)$/i);
      if (pl) plName = pl[1].trim();
      continue;
    }
    entries.push({ ...(pending || {}), location: line });
    pending = null;
  }
  return { name: plName, entries };
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/** A song title without what streaming services add: "(feat. X)", "- Remastered 2011", "[Live]"… */
export const normSong = (s) => norm(String(s || '')
  .replace(/\s[-–]\s.*\b(remaster(ed)?|version|edit|mix|live|mono|stereo|radio|single|demo|acoustic|bonus)\b.*$/i, '')
  .replace(/[([](feat|ft|with)\.?\s[^)\]]*[)\]]/gi, '')
  .replace(/\s(feat|ft)\.?\s.*$/i, ''));

/**
 * Finds library songs by artist + title, tolerant of featuring credits, remaster
 * suffixes and accents. Build it once per import: it indexes the whole library.
 * Returns a function (title, artist, album?, duration?) → track id or null.
 */
export function buildMatcher() {
  const byTitle = new Map();
  for (const r of q(`SELECT t.id, t.title, t.album, t.duration, t.artist, (SELECT group_concat(name, '|') FROM track_artists ta WHERE ta.track_id = t.id) AS artists FROM tracks t`).all()) {
    const k = normSong(r.title);
    if (!byTitle.has(k)) byTitle.set(k, []);
    byTitle.get(k).push({ id: r.id, album: norm(r.album), duration: r.duration, artists: [r.artist, ...String(r.artists || '').split('|')].map(norm).filter(Boolean) });
  }
  return (title, artist, album = null, duration = null) => {
    const cands = byTitle.get(normSong(title));
    if (!cands) return null;
    const a = norm(String(artist || '').split(/,|&| feat\.? | x /i)[0]);
    const fits = cands.filter((c) => !a || c.artists.some((x) => x === a || x.includes(a) || a.includes(x)));
    if (!fits.length) return !a && cands.length === 1 ? cands[0].id : null;
    const al = norm(album);
    const best = (al && fits.find((c) => c.album === al)) || (duration && fits.find((c) => Math.abs((c.duration || 0) - duration) < 4)) || fits[0];
    return best.id;
  };
}

function locationToPath(loc, baseDir) {
  if (!loc) return null;
  let p = loc;
  if (/^file:\/\//i.test(p)) {
    try { p = decodeURIComponent(new URL(p).pathname); } catch { return null; }
    if (process.platform === 'win32' && /^\/[a-z]:/i.test(p)) p = p.slice(1);
  } else if (/^[a-z][a-z0-9+.-]+:\/\//i.test(p)) return null; // http:// etc.
  else {
    try { p = decodeURIComponent(p); } catch { /* keep raw */ }
  }
  p = p.replace(/[\\/]/g, path.sep);
  return path.isAbsolute(p) || /^[a-z]:/i.test(p) ? path.normalize(p) : baseDir ? path.resolve(baseDir, p) : p;
}

/**
 * Match entries to library tracks: by exact path, then by the end of the path
 * (playlists made on another computer), then by artist + title.
 * Returns { ids: [...], missing: [label...] }.
 */
export function matchEntries(entries, { baseDir = null } = {}) {
  let matcher = null;
  const ids = [];
  const missing = [];
  const byPath = q('SELECT id FROM tracks WHERE path = ?');
  const bySuffix = q(`SELECT id FROM tracks WHERE path LIKE ? ESCAPE '\\' ORDER BY length(path) LIMIT 1`);
  const byTitle = q('SELECT id, artist, album, duration FROM tracks WHERE title = ? COLLATE NOCASE LIMIT 50');
  for (const e of entries) {
    let id = null;
    const p = locationToPath(e.location, baseDir);
    if (p) {
      id = byPath.get(p)?.id ?? null;
      if (!id) {
        // Try the last three path parts: Artist/Album/01 Song.flac
        const parts = p.split(/[\\/]/).filter(Boolean).slice(-3);
        for (let n = parts.length; n >= 2 && !id; n--) {
          const tail = (path.sep + parts.slice(-n).join(path.sep)).replace(/[\\%_]/g, (m) => '\\' + m);
          id = bySuffix.get(`%${tail}`)?.id ?? null;
        }
      }
    }
    if (!id && e.title) {
      const cands = byTitle.all(e.title);
      const a = norm(e.artist);
      const best = cands.find((c) => a && norm(c.artist) === a) || cands.find((c) => a && norm(c.artist).includes(a))
        || (!a && cands.length === 1 ? cands[0] : null);
      id = best?.id ?? null;
      if (!id) { matcher ||= buildMatcher(); id = matcher(e.title, e.artist, e.album, e.duration); }
    }
    if (id) ids.push(id);
    else missing.push(e.artist && e.title ? `${e.artist} - ${e.title}` : e.title || e.location || '?');
  }
  return { ids, missing };
}

/** rows: tracks with path, title, artist, album, duration. */
export function exportPlaylist(name, rows, format, { pathFor }) {
  if (format === 'xspf') {
    return `<?xml version="1.0" encoding="UTF-8"?>
<playlist version="1" xmlns="http://xspf.org/ns/0/">
  <title>${xmlEsc(name)}</title>
  <creator>Sonara</creator>
  <trackList>
${rows.map((r) => `    <track>
      <location>${xmlEsc(encodeURI(pathFor(r).split(path.sep).join('/')))}</location>
      <title>${xmlEsc(r.title)}</title>
      <creator>${xmlEsc(r.artist)}</creator>
      <album>${xmlEsc(r.album)}</album>
      ${r.duration ? `<duration>${Math.round(r.duration * 1000)}</duration>` : ''}
    </track>`).join('\n')}
  </trackList>
</playlist>
`;
  }
  return ['#EXTM3U', `#PLAYLIST:${name}`, ...rows.flatMap((r) => [`#EXTINF:${Math.round(r.duration || -1)},${r.artist} - ${r.title}`, pathFor(r)]), ''].join('\n');
}

// ───────── .m3u files in the music folders ─────────

function firstAdminId() {
  return q('SELECT id FROM users WHERE is_admin = 1 ORDER BY created_at LIMIT 1').get()?.id ?? null;
}

/**
 * Create or update a playlist for each playlist file found during a scan, and remove
 * playlists whose file is gone (only for folders that were reachable).
 */
export function syncFolderPlaylists(files, reachableRoots) {
  if (!getConfig().importPlaylists) return 0;
  const owner = firstAdminId();
  if (!owner) return 0;
  let changed = 0;
  const seen = new Set(files);
  for (const file of files) {
    try {
      const st = fs.statSync(file);
      const mtime = Math.floor(st.mtimeMs);
      const existing = q('SELECT id, source_mtime FROM playlists WHERE source_path = ?').get(file);
      if (existing && existing.source_mtime === mtime) continue;
      const { name, entries } = parsePlaylist(fs.readFileSync(file, 'utf8'), file);
      const { ids, missing } = matchEntries(entries, { baseDir: path.dirname(file) });
      const title = (name || path.basename(file, path.extname(file))).slice(0, 100);
      tx(() => {
        let id = existing?.id;
        const now = Date.now();
        if (id) {
          q('UPDATE playlists SET name = ?, source_mtime = ?, updated_at = ? WHERE id = ?').run(title, mtime, now, id);
          q('DELETE FROM playlist_tracks WHERE playlist_id = ?').run(id);
        } else {
          id = Number(q(`INSERT INTO playlists (user_id, name, description, created_at, updated_at, visibility, source_path, source_mtime)
            VALUES (?, ?, ?, ?, ?, 'public', ?, ?)`).run(owner, title, `From ${path.basename(file)}`, now, now, file, mtime).lastInsertRowid);
        }
        const ins = q('INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)');
        ids.forEach((tid, i) => ins.run(id, tid, i));
      });
      changed++;
      log.info(`[scan] Playlist ${path.basename(file)}: ${ids.length} songs${missing.length ? `, ${missing.length} not found` : ''}`);
    } catch (err) {
      log.warn(`[scan] Could not read playlist ${file}: ${err.message}`);
    }
  }
  const isUnder = (p, root) => p === root || p.startsWith(root + path.sep);
  for (const row of q('SELECT id, source_path FROM playlists WHERE source_path IS NOT NULL').all()) {
    if (!seen.has(row.source_path) && reachableRoots.some((r) => isUnder(row.source_path, r))) {
      q('DELETE FROM playlists WHERE id = ?').run(row.id);
      changed++;
    }
  }
  return changed;
}
