// Routes that work without signing in:
//   /api/public/shares/:id/…   public share links (track, album or playlist), with optional expiry
//   /api/public/stream/:id     signed, short-lived stream URLs for casting (Chromecast, DLNA)

import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { q } from './db.js';
import { COVERS_DIR, getConfig, serverSecret } from './config.js';
import { deliveryPlan, serveTranscoded, transcodeToFile, FORMATS } from './transcode.js';
import { writeZip } from './zip.js';
import { log } from './logger.js';

export const publicApi = express.Router();

const MIME = {
  '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.aac': 'audio/aac',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.webm': 'audio/webm',
};
const STREAM_COLS = 'id, path, mtime, size, bitrate, lossless, codec, sample_rate, needs_transcode, cue_file, cue_start, cue_end, title, artist, album, album_artist, track_no, disc_no, album_id, cover, duration';

async function sendAudio(req, res, row, plan) {
  if (plan) return serveTranscoded(req, res, row, plan, { wait: req.query.wait === '1' });
  const type = MIME[path.extname(row.path).toLowerCase()];
  res.sendFile(row.path, { headers: type ? { 'Content-Type': type } : {}, dotfiles: 'allow', acceptRanges: true }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'File unavailable' });
  });
}

// ───────── Signed stream URLs ─────────

const sign = (s) => crypto.createHmac('sha256', serverSecret()).update(s).digest('base64url').slice(0, 32);

/** A stream path that works without a session for `ttl` seconds. format: mp3 | original */
export function signedStreamPath(id, { format = 'mp3', ttl = 6 * 3600 } = {}) {
  const exp = Math.floor(Date.now() / 1000) + ttl;
  return `/api/public/stream/${id}?exp=${exp}&f=${format}&sig=${sign(`${id}.${exp}.${format}`)}`;
}

/** A cover image URL that works without a session (for cast receivers). */
export function signedCoverPath(file, ttl = 6 * 3600) {
  const exp = Math.floor(Date.now() / 1000) + ttl;
  return `/api/public/cover/${file}?exp=${exp}&sig=${sign(`cover.${file}.${exp}`)}`;
}

publicApi.get('/cover/:file', (req, res) => {
  const file = String(req.params.file);
  const exp = Number(req.query.exp) || 0;
  const sig = String(req.query.sig || '');
  const want = sign(`cover.${file}.${exp}`);
  if (!/^[a-f0-9]{40}\.(jpg|png|webp)$/.test(file) || sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want)) || exp < Date.now() / 1000) {
    return res.status(403).end();
  }
  res.sendFile(path.join(COVERS_DIR, file), { maxAge: '1h' }, (err) => { if (err && !res.headersSent) res.status(404).end(); });
});

/** Base URL another device on the network can reach us at (preferring the interface on the same subnet as `peer`). */
export function lanBaseUrl(peer = '') {
  const pub = getConfig().publicUrl;
  if (pub && !/^https:/.test(pub)) return pub.replace(/\/+$/, '');
  const port = getConfig().port;
  const toNum = (ip) => ip.split('.').reduce((a, b) => (a << 8) + Number(b), 0) >>> 0;
  const candidates = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) candidates.push(i);
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(peer)) {
    const p = toNum(peer);
    const hit = candidates.find((i) => (toNum(i.address) & toNum(i.netmask)) === (p & toNum(i.netmask)));
    if (hit) return `http://${hit.address}:${port}`;
  }
  return `http://${candidates[0]?.address || '127.0.0.1'}:${port}`;
}

publicApi.get('/stream/:id', async (req, res) => {
  const id = Number.parseInt(req.params.id, 10) || 0;
  const exp = Number(req.query.exp) || 0;
  const f = req.query.f === 'original' ? 'original' : 'mp3';
  const sig = String(req.query.sig || '');
  const want = sign(`${id}.${exp}.${f}`);
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want)) || exp < Date.now() / 1000) {
    return res.status(403).json({ error: 'This link has expired' });
  }
  const row = q(`SELECT ${STREAM_COLS} FROM tracks WHERE id = ?`).get(id);
  if (!row) return res.status(404).json({ error: 'Track not found' });
  try {
    // mp3: what every renderer understands. original: as-is unless the format can't be streamed.
    const plan = f === 'mp3' ? deliveryPlan(row, { format: 'mp3', bitrate: 320, prefer: 'mp3' }) : deliveryPlan(row, { prefer: 'mp3' });
    await sendAudio(req, res, row, plan);
  } catch (err) {
    if (!res.headersSent) res.status(err.status || 500).json({ error: err.message });
  }
});

// ───────── Share links ─────────

export const newShareId = () => crypto.randomBytes(12).toString('base64url');

function liveShare(id) {
  const s = q('SELECT s.*, u.username FROM shares s JOIN users u ON u.id = s.user_id WHERE s.id = ?').get(String(id));
  if (!s) return null;
  if (s.expires_at && s.expires_at < Date.now()) return null;
  if (!getConfig().sharing) return null;
  return s;
}

/** The tracks a share gives access to (live: a shared playlist shows its current songs). */
export function shareTracks(s) {
  const cols = STREAM_COLS.split(', ').map((c) => `t.${c}`).join(', ') + ', t.year, t.artist_id';
  if (s.kind === 'track') return q(`SELECT ${cols} FROM tracks t WHERE t.id = ?`).all(Number(s.ref));
  if (s.kind === 'album') return q(`SELECT ${cols} FROM tracks t WHERE t.album_id = ? ORDER BY COALESCE(t.disc_no, 1), COALESCE(t.track_no, 9999), t.title`).all(s.ref);
  if (s.kind === 'playlist') {
    return q(`SELECT ${cols} FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id WHERE pt.playlist_id = ? ORDER BY pt.position`).all(Number(s.ref));
  }
  return [];
}

const publicTrack = (t) => ({
  id: t.id, title: t.title, artist: t.artist, album: t.album, trackNo: t.track_no, discNo: t.disc_no, year: t.year,
  duration: t.cue_end != null ? t.cue_end - (t.cue_start || 0) : t.duration, cover: t.cover,
});

publicApi.get('/shares/:id', (req, res) => {
  const s = liveShare(req.params.id);
  if (!s) return res.status(404).json({ error: 'This link has expired or was removed' });
  const rows = shareTracks(s);
  q('UPDATE shares SET views = views + 1, last_viewed_at = ? WHERE id = ?').run(Date.now(), s.id);
  res.json({
    id: s.id, kind: s.kind, title: s.title, description: s.description, sharedBy: s.username, allowDownload: !!s.allow_download,
    expiresAt: s.expires_at, cover: rows.find((r) => r.cover)?.cover || null, tracks: rows.map(publicTrack),
  });
});

const shareRow = (s, trackId) => shareTracks(s).find((t) => t.id === Number(trackId));

publicApi.get('/shares/:id/stream/:trackId', async (req, res) => {
  const s = liveShare(req.params.id);
  const row = s && shareRow(s, req.params.trackId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  try {
    await sendAudio(req, res, row, deliveryPlan(row, { prefer: ['opus', 'aac', 'mp3'].includes(req.query.codec) ? req.query.codec : 'opus' }));
  } catch (err) {
    if (!res.headersSent) res.status(err.status || 500).json({ error: err.message });
  }
});

publicApi.get('/shares/:id/cover/:file', (req, res) => {
  const s = liveShare(req.params.id);
  if (!s || !/^[a-f0-9]{40}\.(jpg|png|webp)$/.test(req.params.file)) return res.status(404).end();
  if (!shareTracks(s).some((t) => t.cover === req.params.file)) return res.status(404).end();
  res.sendFile(path.join(COVERS_DIR, req.params.file), { maxAge: '7d' }, (err) => { if (err && !res.headersSent) res.status(404).end(); });
});

const cleanName = (x) => String(x || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 150) || 'Untitled';
const disposition = (name) => `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'")}"; filename*=UTF-8''${encodeURIComponent(name)}`;

publicApi.get('/shares/:id/download', async (req, res) => {
  const s = liveShare(req.params.id);
  if (!s || !s.allow_download) return res.status(404).json({ error: 'Downloads are not allowed for this link' });
  const rows = shareTracks(s);
  if (!rows.length) return res.status(404).json({ error: 'Nothing to download' });
  const file = async (r) => {
    const plan = deliveryPlan(r, { format: 'raw' });
    return plan ? { file: await transcodeToFile(r, plan), ext: FORMATS[plan.format].ext } : { file: r.path, ext: path.extname(r.path) };
  };
  try {
    if (rows.length === 1) {
      const { file: f, ext } = await file(rows[0]);
      res.setHeader('Content-Disposition', disposition(cleanName(`${rows[0].artist} - ${rows[0].title}`) + ext));
      return res.sendFile(f, { dotfiles: 'allow' });
    }
    const folder = cleanName(s.title);
    const entries = [];
    const used = new Set();
    for (const [i, r] of rows.entries()) {
      const { file: f, ext } = await file(r);
      const num = s.kind === 'playlist' ? i + 1 : r.track_no;
      let name = `${folder}/${cleanName(`${num ? String(num).padStart(2, '0') + ' ' : ''}${r.artist} - ${r.title}`)}`;
      for (let n = 2; used.has((name + ext).toLowerCase()); n++) name += ` (${n})`;
      used.add((name + ext).toLowerCase());
      entries.push({ name: name + ext, path: f });
    }
    const cover = rows.find((r) => r.cover)?.cover;
    if (cover && fs.existsSync(path.join(COVERS_DIR, cover))) entries.push({ name: `${folder}/cover${path.extname(cover)}`, path: path.join(COVERS_DIR, cover) });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', disposition(`${folder}.zip`));
    const ac = new AbortController();
    res.on('close', () => ac.abort());
    await writeZip(res, entries, { signal: ac.signal });
    res.end();
  } catch (err) {
    log.warn('[share] Download failed:', err.message);
    if (!res.headersSent) res.status(err.status || 500).json({ error: err.message });
    else res.destroy();
  }
});
