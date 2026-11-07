// Audio analysis: waveforms, loudness (for songs without ReplayGain tags),
// tempo, key, energy and a "sound" fingerprint used for "sounds like" radio and
// mood mixes.
//
// Two ways in:
//  - the server, with ffmpeg: a background queue works through the library one
//    file at a time in a worker thread (and jumps ahead for songs being played);
//  - the browser: without ffmpeg, the web app analyses songs as they're played
//    (with its own decoder) and sends the results here.

import express from 'express';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { q, tx } from './db.js';
import { getConfig } from './config.js';
import { tools } from './tools.js';
import { log } from './logger.js';
import { ANALYSIS_VERSION, PEAK_COUNT } from '../public/js/analysis-core.js';

const int = (v, def = 0) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? n : def; };
const REF_LUFS = -18; // ReplayGain 2.0 reference level

// ───────────────────────── Storage ─────────────────────────

const FEATURE_LEN = 32;

/** Validate a result (from our worker or from a browser) before storing it. */
function clean(r) {
  const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null);
  const peaks = typeof r?.peaks === 'string' && /^[A-Za-z0-9+/=]+$/.test(r.peaks) && r.peaks.length <= Math.ceil(PEAK_COUNT / 3) * 4 + 4 ? r.peaks : null;
  const features = Array.isArray(r?.features) && r.features.length === FEATURE_LEN && r.features.every((x) => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) < 100) ? r.features : null;
  return {
    peaks,
    loudness: num(r?.loudness, -80, 10),
    peak: num(r?.peak, 0, 8),
    bpm: num(r?.bpm, 30, 300),
    key: typeof r?.key === 'string' && /^[A-G][♯♭]? (major|minor)$/.test(r.key) ? r.key : null,
    camelot: typeof r?.camelot === 'string' && /^(1[0-2]|[1-9])[AB]$/.test(r.camelot) ? r.camelot : null,
    energy: num(r?.energy, 0, 1),
    features,
  };
}

function store(trackId, raw, source) {
  const t = q('SELECT id, mtime, album_id FROM tracks WHERE id = ?').get(trackId);
  if (!t) return false;
  const r = clean(raw);
  q(`INSERT INTO track_analysis (track_id, file_mtime, version, source, peaks, loudness, peak, bpm, musical_key, camelot, energy, features, error, analyzed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
    ON CONFLICT(track_id) DO UPDATE SET file_mtime = excluded.file_mtime, version = excluded.version, source = excluded.source, peaks = excluded.peaks,
      loudness = excluded.loudness, peak = excluded.peak, bpm = excluded.bpm, musical_key = excluded.musical_key, camelot = excluded.camelot,
      energy = excluded.energy, features = excluded.features, error = NULL, analyzed_at = excluded.analyzed_at`)
    .run(trackId, t.mtime, ANALYSIS_VERSION, source, r.peaks, r.loudness, r.peak, r.bpm, r.key, r.camelot, r.energy, r.features ? JSON.stringify(r.features) : null, Date.now());
  updateAlbum(t.album_id);
  featureCache = null;
  return true;
}

/** Album gain from every song's loudness (energy mean, weighted by length), once the whole album is analysed. */
function updateAlbum(albumId) {
  const rows = q(`SELECT t.id, t.duration, a.loudness, a.peak FROM tracks t LEFT JOIN track_analysis a ON a.track_id = t.id WHERE t.album_id = ?`).all(albumId);
  if (!rows.length || rows.some((r) => r.loudness == null)) return;
  let e = 0, w = 0, peak = 0;
  for (const r of rows) {
    const d = r.duration || 1;
    e += d * 10 ** (r.loudness / 10);
    w += d;
    peak = Math.max(peak, r.peak || 0);
  }
  const albumLufs = 10 * Math.log10(e / w);
  q('UPDATE track_analysis SET album_gain = ?, album_peak = ? WHERE track_id IN (SELECT id FROM tracks WHERE album_id = ?)')
    .run(Math.round((REF_LUFS - albumLufs) * 100) / 100, peak, albumId);
}

// ───────────────────────── Server-side queue (ffmpeg) ─────────────────────────

let worker = null;
let busy = null;            // { trackId, resolve, reject }
const priority = [];        // track ids asked for by listeners
const state = { running: false, current: null, done: 0, failed: 0, startedAt: null };
let sweepTimer = null;

function getWorker() {
  if (worker) return worker;
  worker = new Worker(path.join(path.dirname(fileURLToPath(import.meta.url)), 'analysis-worker.js'));
  worker.unref();
  worker.on('message', (m) => { const b = busy; busy = null; if (b?.id === m.id) (m.error ? b.reject(new Error(m.error)) : b.resolve(m.result)); });
  worker.on('error', (err) => { log.warn('[analysis] Worker failed:', err.message); worker = null; const b = busy; busy = null; b?.reject(err); });
  worker.on('exit', () => { worker = null; });
  return worker;
}

let msgId = 0;
function analyseFile(ffmpeg, t) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    busy = { id, resolve, reject };
    getWorker().postMessage({ id, ffmpeg, file: t.cue_file || t.path, start: t.cue_start || 0, end: t.cue_end ?? null });
  });
}

const NEXT_SQL = `SELECT t.id, t.path, t.cue_file, t.cue_start, t.cue_end FROM tracks t LEFT JOIN track_analysis a ON a.track_id = t.id
  WHERE a.track_id IS NULL OR a.version < ${ANALYSIS_VERSION} OR a.file_mtime != t.mtime ORDER BY t.added_at DESC LIMIT 1`;

let pumping = false;
async function pump() {
  if (pumping) return;
  const ff = (await tools()).ffmpeg;
  if (!ff) return;
  pumping = true;
  try {
    for (;;) {
      let t = null;
      while (priority.length && !t) {
        const id = priority.shift();
        t = q(`SELECT t.id, t.path, t.cue_file, t.cue_start, t.cue_end FROM tracks t LEFT JOIN track_analysis a ON a.track_id = t.id
          WHERE t.id = ? AND (a.track_id IS NULL OR a.version < ${ANALYSIS_VERSION} OR a.file_mtime != t.mtime)`).get(id);
      }
      if (!t && getConfig().analysis !== false && state.running) t = q(NEXT_SQL).get();
      if (!t) break;
      state.current = t.id;
      try {
        store(t.id, await analyseFile(ff.path, t), 'server');
        state.done++;
      } catch (err) {
        state.failed++;
        // Remember the failure so the sweep doesn't retry the same file forever.
        const mt = q('SELECT mtime FROM tracks WHERE id = ?').get(t.id)?.mtime || 0;
        q(`INSERT INTO track_analysis (track_id, file_mtime, version, source, error, analyzed_at) VALUES (?, ?, ?, 'server', ?, ?)
          ON CONFLICT(track_id) DO UPDATE SET file_mtime = excluded.file_mtime, version = excluded.version, error = excluded.error, analyzed_at = excluded.analyzed_at`)
          .run(t.id, mt, ANALYSIS_VERSION, String(err.message).slice(0, 300), Date.now());
      }
      state.current = null;
      await new Promise((r) => setTimeout(r, 50));
    }
  } finally {
    pumping = false;
    state.current = null;
  }
}

/** Start the background sweep (if it's on and ffmpeg is installed). */
export function scheduleAnalysis() {
  clearInterval(sweepTimer);
  state.running = getConfig().analysis !== false;
  if (state.running) { state.startedAt = Date.now(); setTimeout(() => pump(), 20000).unref?.(); }
  // New files arrive with scans: look again every 10 minutes.
  sweepTimer = setInterval(() => { if (state.running) pump(); }, 10 * 60000);
  sweepTimer.unref?.();
}

export async function analysisStatus() {
  const c = q(`SELECT (SELECT COUNT(*) FROM tracks) AS total,
    (SELECT COUNT(*) FROM track_analysis a JOIN tracks t ON t.id = a.track_id WHERE a.version = ${ANALYSIS_VERSION} AND a.file_mtime = t.mtime AND a.error IS NULL) AS analyzed,
    (SELECT COUNT(*) FROM track_analysis WHERE error IS NOT NULL) AS failed`).get();
  return { ...c, ffmpeg: !!(await tools()).ffmpeg, enabled: getConfig().analysis !== false, running: state.running && pumping, current: state.current };
}

// ───────────────────────── "Sounds like" ─────────────────────────

let featureCache = null; // { ids: Int32Array, vecs: Float32Array[], mean, sd }
// How much each part of the fingerprint counts.
const WEIGHTS = [2, 0.5, 2.5, 1, 1.5, 0.8, 1, 1, 0.8, 0.6, 1.2, ...Array(8).fill(0.9), ...Array(12).fill(0.35), 0.6];

function features() {
  if (featureCache) return featureCache;
  const rows = q('SELECT track_id, features FROM track_analysis WHERE features IS NOT NULL').all();
  const ids = new Int32Array(rows.length);
  const vecs = rows.map((r, i) => { ids[i] = r.track_id; return Float32Array.from(JSON.parse(r.features)); });
  const mean = new Float64Array(FEATURE_LEN), sd = new Float64Array(FEATURE_LEN);
  for (const v of vecs) for (let k = 0; k < FEATURE_LEN; k++) mean[k] += v[k] / (vecs.length || 1);
  for (const v of vecs) for (let k = 0; k < FEATURE_LEN; k++) sd[k] += (v[k] - mean[k]) ** 2 / (vecs.length || 1);
  for (let k = 0; k < FEATURE_LEN; k++) sd[k] = Math.sqrt(sd[k]) || 1;
  featureCache = { ids, vecs, mean, sd, index: new Map([...ids].map((id, i) => [id, i])) };
  return featureCache;
}

/** Track ids that sound most like `trackId`, nearest first (null if it isn't analysed yet). */
export function similarIds(trackId, { limit = 50, exclude = [] } = {}) {
  const f = features();
  const i = f.index.get(Number(trackId));
  if (i == null) return null;
  const me = f.vecs[i];
  const skip = new Set(exclude.map(Number));
  skip.add(Number(trackId));
  const scored = [];
  for (let j = 0; j < f.vecs.length; j++) {
    if (skip.has(f.ids[j])) continue;
    const v = f.vecs[j];
    let d = 0;
    for (let k = 0; k < FEATURE_LEN; k++) { const x = (v[k] - me[k]) / f.sd[k]; d += WEIGHTS[k] * x * x; }
    scored.push([d, f.ids[j]]);
  }
  scored.sort((a, b) => a[0] - b[0]);
  const top = scored.slice(0, limit * 4).map((s) => s[1]);
  // Respect the listener's folder access (q() scopes reads of the tracks table).
  const allowed = new Set(q('SELECT id FROM tracks WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(top)).map((r) => r.id));
  return top.filter((id) => allowed.has(id)).slice(0, limit);
}

// ───────────────────────── Mixes ─────────────────────────

const GENRES = {
  chill: ['ambient', 'chill', 'downtempo', 'lo-fi', 'lofi', 'trip hop', 'trip-hop', 'jazz', 'bossa', 'acoustic', 'folk', 'soul', 'new age'],
  focus: ['ambient', 'classical', 'instrumental', 'soundtrack', 'post-rock', 'piano', 'minimal', 'lo-fi', 'lofi', 'score'],
  workout: ['rock', 'metal', 'punk', 'edm', 'electronic', 'drum and bass', 'dnb', 'hip hop', 'hip-hop', 'rap', 'house', 'techno', 'trap'],
  party: ['dance', 'pop', 'house', 'disco', 'funk', 'edm', 'reggaeton', 'hip hop', 'hip-hop', 'electro'],
};
const genreSql = (list) => `EXISTS (SELECT 1 FROM track_genres g WHERE g.track_id = t.id AND (${list.map((_, i) => `lower(g.genre) LIKE $g${i}`).join(' OR ')}))`;
const genreParams = (list) => Object.fromEntries(list.map((g, i) => [`g${i}`, `%${g}%`]));

export const MIXES = {
  chill: { name: 'Chill', description: 'Slow and easy: low energy, relaxed tempos.', where: '(a.energy <= 0.42 AND (a.bpm IS NULL OR a.bpm < 112))', genres: GENRES.chill },
  focus: { name: 'Focus', description: 'Steady, unobtrusive music to work to.', where: '(a.energy BETWEEN 0.18 AND 0.5)', genres: GENRES.focus },
  workout: { name: 'Workout', description: 'High energy, 120–160 BPM.', where: '(a.energy >= 0.6 AND a.bpm BETWEEN 118 AND 165)', genres: GENRES.workout },
  party: { name: 'Party', description: 'Upbeat songs with a danceable tempo.', where: '(a.energy >= 0.55 AND a.bpm BETWEEN 98 AND 132)', genres: GENRES.party },
};

const daySeed = () => Math.floor(Date.now() / 86400000);

/** Track ids for a mix (stable for the day). */
export function mixIds(uid, id, limit = 60) {
  if (id === 'hour') {
    // What you play most around this time of day.
    const h = new Date().getHours();
    const hours = [(h + 23) % 24, h, (h + 1) % 24].map((x) => String(x).padStart(2, '0'));
    return q(`SELECT p.track_id AS id FROM plays p JOIN tracks t ON t.id = p.track_id
      WHERE p.user_id = $uid AND strftime('%H', p.played_at / 1000, 'unixepoch', 'localtime') IN ($h0, $h1, $h2)
      GROUP BY p.track_id ORDER BY COUNT(*) DESC, (p.track_id * 2654435761 + $seed) % 1000003 LIMIT $limit`)
      .all({ uid, h0: hours[0], h1: hours[1], h2: hours[2], seed: daySeed(), limit }).map((r) => r.id);
  }
  const m = MIXES[id];
  if (!m) return [];
  return q(`SELECT t.id FROM tracks t LEFT JOIN track_analysis a ON a.track_id = t.id
    WHERE (${m.where} OR (a.energy IS NULL AND ${genreSql(m.genres)}))
    ORDER BY (t.id * 2654435761 + $seed) % 1000003 LIMIT $limit`).all({ ...genreParams(m.genres), seed: daySeed() + id.length, limit }).map((r) => r.id);
}

export function mixList(uid) {
  const h = new Date().getHours();
  const part = h < 5 ? 'Late-night' : h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : 'Evening';
  const list = [{ id: 'hour', name: `${part} mix`, description: 'What you usually play around this time of day.' },
    ...Object.entries(MIXES).map(([id, m]) => ({ id, name: m.name, description: m.description }))];
  return list.map((m) => {
    const ids = mixIds(uid, m.id, 60);
    const covers = ids.length ? q(`SELECT cover FROM tracks WHERE id IN (SELECT value FROM json_each(?)) AND cover IS NOT NULL GROUP BY album_id LIMIT 4`).all(JSON.stringify(ids.slice(0, 40))).map((r) => r.cover) : [];
    return { ...m, count: ids.length, covers };
  }).filter((m) => m.count >= 8);
}

// ───────────────────────── Routes ─────────────────────────

export const analysisApi = express.Router();

const rowOut = (a) => a && {
  analyzed: !a.error, error: a.error || null, source: a.source, peaks: a.peaks, loudness: a.loudness, peak: a.peak, bpm: a.bpm,
  key: a.musical_key, camelot: a.camelot, energy: a.energy, albumGain: a.album_gain,
  trackGain: a.loudness != null ? Math.round((REF_LUFS - a.loudness) * 100) / 100 : null,
};

// Analysis of one song. If it's missing, the server queues it (with ffmpeg) or
// tells the browser it may analyse the song itself.
analysisApi.get('/tracks/:id/analysis', async (req, res) => {
  const id = int(req.params.id);
  const t = q('SELECT id, mtime, duration FROM tracks WHERE id = ?').get(id);
  if (!t) return res.status(404).json({ error: 'Track not found' });
  const a = q('SELECT * FROM track_analysis WHERE track_id = ?').get(id);
  const fresh = a && a.version === ANALYSIS_VERSION && a.file_mtime === t.mtime;
  if (fresh) return res.json(rowOut(a));
  const ff = (await tools()).ffmpeg;
  if (ff) {
    if (!priority.includes(id)) priority.unshift(id);
    pump();
  }
  res.json({ analyzed: false, pending: !!ff, browser: !ff });
});

// A browser sends the result of analysing a song it played.
analysisApi.put('/tracks/:id/analysis', express.json({ limit: '64kb' }), (req, res) => {
  const id = int(req.params.id);
  const t = q('SELECT id, mtime FROM tracks WHERE id = ?').get(id);
  if (!t) return res.status(404).json({ error: 'Track not found' });
  const a = q('SELECT version, file_mtime, source, error FROM track_analysis WHERE track_id = ?').get(id);
  // Don't replace a current server analysis with a browser one.
  if (a && !a.error && a.source === 'server' && a.version === ANALYSIS_VERSION && a.file_mtime === t.mtime) return res.json({ ok: true, kept: true });
  if (Number(req.body?.version) !== ANALYSIS_VERSION) return res.status(400).json({ error: 'Analysis from an older version of Sonara; reload the page' });
  store(id, req.body, 'browser');
  res.json({ ok: true });
});

// Songs the browser could analyse (for "Analyse in this browser" in Settings).
analysisApi.get('/analysis/pending', (req, res) => {
  const limit = Math.min(200, Math.max(1, int(req.query.limit, 50)));
  res.json(q(`SELECT t.id, t.duration FROM tracks t LEFT JOIN track_analysis a ON a.track_id = t.id
    WHERE (a.track_id IS NULL OR a.version < ${ANALYSIS_VERSION} OR a.file_mtime != t.mtime) AND t.cue_file IS NULL
    ORDER BY t.added_at DESC LIMIT ?`).all(limit));
});

analysisApi.get('/analysis/status', async (_req, res) => res.json(await analysisStatus()));

export function setAnalysisRunning(on) {
  state.running = !!on;
  if (on) { state.startedAt = Date.now(); pump(); }
}
