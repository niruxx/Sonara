// Lyrics: sidecar .lrc/.txt files, then embedded tags, then (optionally) LRCLIB.
// Results — including "nothing found" — are cached in the lyrics table and
// re-checked when the audio file changes.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { parseFile } from 'music-metadata';
import { q } from './db.js';
import { getConfig } from './config.js';
import { getJson } from './online.js';
import { log } from './logger.js';

const NOT_FOUND_RETRY_MS = 14 * 24 * 3600 * 1000; // ask LRCLIB again after two weeks
const LRC_LINE = /^\s*\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/m;
export const looksSynced = (text) => LRC_LINE.test(text || '');

/** Convert ID3 SYLT-style synced lyrics (ms timestamps) to LRC text. */
function toLrc(sync) {
  const ts = (ms) => {
    const s = ms / 1000;
    return `[${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(2).padStart(5, '0')}]`;
  };
  return sync.filter((l) => l.timestamp != null).map((l) => `${ts(l.timestamp)}${l.text.trim()}`).join('\n');
}

async function fromSidecar(file) {
  const base = file.slice(0, -path.extname(file).length);
  for (const ext of ['.lrc', '.LRC', '.txt']) {
    try {
      const text = (await fsp.readFile(base + ext, 'utf8')).replace(/^﻿/, '').trim();
      if (text) return { text, synced: looksSynced(text), source: ext.toLowerCase() === '.txt' ? 'file' : 'lrc' };
    } catch { /* not there */ }
  }
  return null;
}

async function fromTags(file) {
  try {
    const m = await parseFile(file, { duration: false, skipCovers: true });
    const tags = m.common.lyrics || [];
    const synced = tags.find((l) => l.syncText?.length);
    if (synced) return { text: toLrc(synced.syncText), synced: true, source: 'embedded' };
    const plain = tags.map((l) => l.text).find((t) => t && t.trim());
    if (plain) return { text: plain.trim(), synced: looksSynced(plain), source: 'embedded' };
  } catch { /* unreadable */ }
  return null;
}

async function fromLrclib(t) {
  const params = new URLSearchParams({ artist_name: t.artist, track_name: t.title.replace(/\s*[([](feat|ft)\.?[^)\]]*[)\]]/i, '') });
  if (t.album) params.set('album_name', t.album);
  if (t.duration) params.set('duration', String(Math.round(t.duration)));
  let r = await getJson(`https://lrclib.net/api/get?${params}`).catch((err) => { log.warn(`[lyrics] LRCLIB: ${err.message}`); return undefined; });
  if (r === undefined) return undefined; // service problem: don't cache a miss
  if (!r) {
    // No exact match: search, and accept a result whose length is close.
    const list = await getJson(`https://lrclib.net/api/search?${new URLSearchParams({ artist_name: params.get('artist_name'), track_name: params.get('track_name') })}`).catch(() => undefined);
    if (list === undefined) return undefined;
    r = (list || []).find((x) => !t.duration || !x.duration || Math.abs(x.duration - t.duration) < 4) || null;
  }
  if (!r || r.instrumental) return r?.instrumental ? { text: '♪ Instrumental ♪', synced: false, source: 'lrclib' } : null;
  if (r.syncedLyrics) return { text: r.syncedLyrics, synced: true, source: 'lrclib' };
  if (r.plainLyrics) return { text: r.plainLyrics, synced: false, source: 'lrclib' };
  return null;
}

/**
 * Lyrics for a track row ({ id, path, cue_file, mtime, title, artist, album, duration }).
 * Returns { text, synced, source } or null.
 */
export async function getLyrics(t, { refresh = false } = {}) {
  const file = t.cue_file || t.path;
  const cached = q('SELECT text, synced, source, file_mtime, fetched_at FROM lyrics WHERE track_id = ?').get(t.id);
  const store = (r, source = r?.source) => {
    q(`INSERT INTO lyrics (track_id, text, synced, source, file_mtime, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(track_id) DO UPDATE SET text = excluded.text, synced = excluded.synced, source = excluded.source,
      file_mtime = excluded.file_mtime, fetched_at = excluded.fetched_at`)
      .run(t.id, r?.text ?? null, r?.synced ? 1 : 0, source || 'none', t.mtime, Date.now());
    return r;
  };

  // Sidecar files always win (they're the easiest for people to fix), and are cheap to check.
  if (!t.cue_file) {
    const side = await fromSidecar(file);
    if (side) return side;
  }
  // Lyrics someone typed in stay until they change them.
  if (cached?.source === 'manual' && cached.text && !refresh) return { text: cached.text, synced: !!cached.synced, source: 'manual' };
  const fresh = cached && cached.file_mtime === t.mtime;
  if (!refresh && fresh && cached.text) return { text: cached.text, synced: !!cached.synced, source: cached.source };
  const recentMiss = fresh && !cached.text && Date.now() - cached.fetched_at < NOT_FOUND_RETRY_MS;
  if (!refresh && recentMiss && (cached.source !== 'none' || !getConfig().onlineLyrics)) return null;

  const embedded = t.cue_file ? null : await fromTags(file);
  if (embedded) return store(embedded);
  if (getConfig().onlineLyrics) {
    const online = await fromLrclib(t);
    if (online === undefined) return null;
    return store(online, 'lrclib');
  }
  return store(null, 'none');
}

/** Save lyrics a user typed or pasted (stored in the database, files untouched). */
export function setLyrics(t, text) {
  const clean = String(text || '').replace(/\r\n/g, '\n').trim();
  q(`INSERT INTO lyrics (track_id, text, synced, source, file_mtime, fetched_at) VALUES (?, ?, ?, 'manual', ?, ?)
    ON CONFLICT(track_id) DO UPDATE SET text = excluded.text, synced = excluded.synced, source = 'manual',
    file_mtime = excluded.file_mtime, fetched_at = excluded.fetched_at`).run(t.id, clean || null, looksSynced(clean) ? 1 : 0, t.mtime, Date.now());
}
