// Internet radio: each user keeps a list of stations (Icecast / SHOUTcast and
// other plain HTTP audio streams, plus .pls / .m3u playlists that point at them).
//
// Streams are relayed through Sonara: that avoids mixed-content and CORS
// problems in the browser (so the EQ and visualizer work), and lets us read the
// in-band ICY metadata to show the song that's on air.

import express from 'express';
import { Transform } from 'node:stream';
import { q } from './db.js';
import { getConfig } from './config.js';
import { saveCover } from './scanner.js';
import { openUrl, readBody, fetchImage, cleanUrl } from './net.js';
import { getJson } from './online.js';
import { log } from './logger.js';

const httpError = (status, message) => Object.assign(new Error(message), { status });
const h = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (err) {
    if (!err.status) log.error('[radio]', err);
    if (!res.headersSent) res.status(err.status || 500).json({ error: err.message || 'Something went wrong' });
    else res.destroy();
  }
};
const int = (v, def = 0) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? n : def; };
const str = (v, max = 300) => String(v ?? '').trim().slice(0, max);

// ───────────────────────── Playlists and ICY metadata ─────────────────────────

const PLAYLIST_TYPES = /audio\/(x-)?scpls|audio\/(x-)?mpegurl|application\/(x-)?mpegurl|application\/pls|application\/xspf|video\/x-ms-asf|audio\/x-ms-wax/i;
const PLAYLIST_EXT = /\.(pls|m3u8?|xspf|asx|wax)$/i;

/** First stream URL in a .pls / .m3u / .xspf / .asx playlist. */
export function playlistTarget(text, base) {
  const s = String(text);
  if (/#EXT-X-(TARGETDURATION|MEDIA-SEQUENCE|STREAM-INF)/i.test(s)) throw httpError(415, 'This is an HLS stream, which Sonara can’t relay yet. Look for an MP3, AAC or Ogg stream of the same station.');
  const candidates = [
    ...[...s.matchAll(/^File\d+\s*=\s*(\S+)/gim)].map((m) => m[1]),
    ...[...s.matchAll(/<location>\s*([^<\s]+)\s*<\/location>/gi)].map((m) => m[1]),
    ...[...s.matchAll(/<ref\s+href\s*=\s*"([^"]+)"/gi)].map((m) => m[1]),
    ...s.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && /^[a-z]+:\/\//i.test(l)),
  ];
  for (const c of candidates) {
    try {
      const u = new URL(c.replace(/&amp;/g, '&'), base);
      if (u.protocol === 'http:' || u.protocol === 'https:') return u;
    } catch { /* next */ }
  }
  throw httpError(422, 'That playlist doesn’t contain a stream address');
}

/** Open a station: follows playlists (two levels deep) to the actual audio stream. */
async function openStream(url, { allowPrivate, icy = true, depth = 0 } = {}) {
  const { res, url: final } = await openUrl(url, { allowPrivate, timeout: 12000, headers: icy ? { 'Icy-MetaData': '1' } : {}, accept: 'audio/*, */*;q=0.5' });
  const type = String(res.headers['content-type'] || '');
  if (PLAYLIST_TYPES.test(type) || (PLAYLIST_EXT.test(final.pathname) && !/^audio\/(mpeg|aac|aacp|ogg|opus|flac)/i.test(type))) {
    if (depth >= 2) { res.destroy(); throw httpError(422, 'Too many nested playlists'); }
    const body = await readBody(res, 256 * 1024);
    return openStream(playlistTarget(body.toString('utf8'), final), { allowPrivate, icy, depth: 1 + depth });
  }
  if (/^text\/html/i.test(type)) { res.destroy(); throw httpError(415, 'That address is a web page, not an audio stream'); }
  return { res, url: final, type };
}

function decodeMeta(buf) {
  const utf8 = buf.toString('utf8');
  return (utf8.includes('�') ? buf.toString('latin1') : utf8).replace(/\0+$/, '');
}

/** Removes ICY metadata blocks from a stream, reporting StreamTitle changes. */
export function icyStripper(metaint, onTitle) {
  let state = 'audio';
  let left = metaint;
  let meta = [];
  return new Transform({
    transform(chunk, _enc, cb) {
      const out = [];
      let i = 0;
      while (i < chunk.length) {
        if (state === 'audio') {
          const n = Math.min(left, chunk.length - i);
          out.push(chunk.subarray(i, i + n));
          i += n;
          left -= n;
          if (left === 0) state = 'len';
        } else if (state === 'len') {
          left = chunk[i++] * 16;
          meta = [];
          if (left === 0) { state = 'audio'; left = metaint; } else state = 'meta';
        } else {
          const n = Math.min(left, chunk.length - i);
          meta.push(chunk.subarray(i, i + n));
          i += n;
          left -= n;
          if (left === 0) {
            const text = decodeMeta(Buffer.concat(meta));
            const m = text.match(/StreamTitle='([\s\S]*?)';(?=Stream\w+=|\s*$)/) || text.match(/StreamTitle='([^;]*)'/);
            if (m) onTitle(m[1].trim());
            state = 'audio';
            left = metaint;
          }
        }
      }
      cb(null, out.length === 1 ? out[0] : Buffer.concat(out));
    },
  });
}

// What's on air, per station, from the most recent listener's stream.
const onAir = new Map(); // station id -> { title, at }

// ───────────────────────── Stations ─────────────────────────

const STATION_COLS = `id, name, stream_url AS url, homepage, image AS cover, tags, country, codec, bitrate, plays,
  last_played_at AS lastPlayedAt, created_at AS createdAt`;
const own = (req) => {
  const s = q(`SELECT ${STATION_COLS} FROM radio_stations WHERE id = ? AND user_id = ?`).get(int(req.params.id), req.user.id);
  if (!s) throw httpError(404, 'Station not found');
  return s;
};
const out = (s) => s && { ...s, nowPlaying: onAir.get(s.id)?.title || null };

async function stationImage(url, allowPrivate) {
  if (!url) return null;
  try { cleanUrl(url); } catch { return null; }
  const img = await fetchImage(url, { allowPrivate });
  return img ? saveCover(img.data, img.type) : null;
}

/** Check that a stream answers and looks like audio (or a playlist to audio). */
async function probe(url, allowPrivate) {
  const { res, type } = await openStream(url, { allowPrivate, icy: false });
  res.destroy();
  return type;
}

export const stationsApi = express.Router();

stationsApi.get('/', (req, res) => {
  const rows = q(`SELECT ${STATION_COLS} FROM radio_stations WHERE user_id = ? ORDER BY COALESCE(last_played_at, 0) DESC, name COLLATE NOCASE`).all(req.user.id);
  res.json({ stations: rows.map(out), directory: !!getConfig().onlineRadioDirectory });
});

// radio-browser.info, a free community directory (opt-in).
stationsApi.get('/search', h(async (req, res) => {
  if (!getConfig().onlineRadioDirectory) throw httpError(403, 'Station search is turned off. An admin can enable it in Settings → Online services.');
  const params = { limit: '40', hidebroken: 'true', order: 'clickcount', reverse: 'true' };
  const name = str(req.query.q, 200);
  const tag = str(req.query.tag, 100);
  const country = str(req.query.country, 2).toUpperCase();
  if (name) params.name = name;
  if (tag) params.tag = tag;
  if (country) params.countrycode = country;
  if (!name && !tag && !country) params.limit = '30';
  const rows = await getJson(`https://all.api.radio-browser.info/json/stations/search?${new URLSearchParams(params)}`, { timeout: 10000 }).catch(() => null)
    ?? await getJson(`https://de1.api.radio-browser.info/json/stations/search?${new URLSearchParams(params)}`, { timeout: 10000 });
  const mine = new Set(q('SELECT stream_url AS u FROM radio_stations WHERE user_id = ?').all(req.user.id).map((r) => r.u));
  res.json((rows || []).filter((r) => r.url_resolved || r.url).map((r) => {
    const url = r.url_resolved || r.url;
    return {
      name: str(r.name, 200) || 'Unnamed station', url, homepage: r.homepage || null, image: r.favicon || null,
      tags: str(r.tags, 300), country: r.countrycode || null, codec: r.codec || null, bitrate: r.bitrate || null,
      hls: !!r.hls, added: mine.has(url),
    };
  }));
}));

stationsApi.post('/', h(async (req, res) => {
  const b = req.body || {};
  const url = cleanUrl(b.url).href;
  const name = str(b.name, 200);
  if (!name) throw httpError(400, 'Give the station a name');
  const allowPrivate = !!req.user.is_admin;
  if (!b.skipCheck) await probe(url, allowPrivate);
  const dup = q('SELECT id FROM radio_stations WHERE user_id = ? AND stream_url = ?').get(req.user.id, url);
  if (dup) return res.json(out(q(`SELECT ${STATION_COLS} FROM radio_stations WHERE id = ?`).get(dup.id)));
  const cover = await stationImage(b.image, allowPrivate);
  const { lastInsertRowid } = q(`INSERT INTO radio_stations (user_id, name, stream_url, homepage, image, tags, country, codec, bitrate, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(req.user.id, name, url, str(b.homepage, 500) || null, cover, str(b.tags), str(b.country, 2) || null,
    str(b.codec, 20) || null, int(b.bitrate, 0) || null, Date.now());
  res.json(out(q(`SELECT ${STATION_COLS} FROM radio_stations WHERE id = ?`).get(Number(lastInsertRowid))));
}));

stationsApi.put('/:id', h(async (req, res) => {
  const s = own(req);
  const b = req.body || {};
  const url = b.url != null ? cleanUrl(b.url).href : s.url;
  if (url !== s.url) await probe(url, !!req.user.is_admin);
  const name = b.name != null ? str(b.name, 200) : s.name;
  if (!name) throw httpError(400, 'Give the station a name');
  const cover = b.image ? (await stationImage(b.image, !!req.user.is_admin)) || s.cover : s.cover;
  q('UPDATE radio_stations SET name = ?, stream_url = ?, homepage = ?, tags = ?, image = ? WHERE id = ?')
    .run(name, url, b.homepage != null ? str(b.homepage, 500) || null : s.homepage, b.tags != null ? str(b.tags) : s.tags, cover, s.id);
  res.json(out(q(`SELECT ${STATION_COLS} FROM radio_stations WHERE id = ?`).get(s.id)));
}));

stationsApi.delete('/:id', h(async (req, res) => {
  const s = own(req);
  q('DELETE FROM radio_stations WHERE id = ?').run(s.id);
  onAir.delete(s.id);
  res.json({ ok: true });
}));

stationsApi.get('/:id/now', h(async (req, res) => {
  const s = own(req);
  res.json({ title: onAir.get(s.id)?.title || null });
}));

// The live stream itself.
stationsApi.get('/:id/stream', h(async (req, res) => {
  const s = own(req);
  const { res: up, type } = await openStream(s.url, { allowPrivate: !!req.user.is_admin });
  q('UPDATE radio_stations SET plays = plays + 1, last_played_at = ? WHERE id = ?').run(Date.now(), s.id);
  res.status(200).set({
    'Content-Type': /^(audio|application\/ogg|video)/i.test(type) ? type.split(';')[0] : 'audio/mpeg',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  const metaint = int(up.headers['icy-metaint'], 0);
  let body = up;
  if (metaint > 0) {
    body = up.pipe(icyStripper(metaint, (title) => onAir.set(s.id, { title: title || null, at: Date.now() })));
  }
  const stop = () => { up.destroy(); };
  res.on('close', stop);
  up.on('error', () => res.destroy());
  body.on('error', () => res.destroy());
  body.pipe(res);
}));
