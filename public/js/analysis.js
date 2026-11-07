// Client side of audio analysis: fetch a song's analysis (waveform, tempo, key,
// loudness), and when the server can't analyse (no ffmpeg), do it here with the
// browser's own decoder and send the result back.
import { api } from './api.js';
import { prefs } from './util.js';
import { ANALYSIS_RATE, decodePeaks } from './analysis-core.js';

const cache = new Map();      // track id -> analysis (or a pending promise)
const MAX_BROWSER_SECONDS = 20 * 60; // longer files need too much memory to decode at once
let worker = null;
let busy = false;
let msg = 0;

export const browserAnalysisOn = () => prefs.get('analyzeInBrowser', true);

function runWorker(left, right, sampleRate) {
  worker ||= new Worker('/js/analysis-worker.js', { type: 'module' });
  return new Promise((resolve, reject) => {
    const id = ++msg;
    const onMsg = ({ data }) => {
      if (data.id !== id) return;
      worker.removeEventListener('message', onMsg);
      data.error ? reject(new Error(data.error)) : resolve(data.result);
    };
    worker.addEventListener('message', onMsg);
    worker.postMessage({ id, sampleRate, left, right }, [left.buffer, right.buffer]);
  });
}

/** Decode a library song in the browser and analyse it. Resolves with the stored analysis. */
export async function analyseInBrowser(track) {
  if (busy) return null;
  if (!track || typeof track.id !== 'number' || (track.duration || 0) > MAX_BROWSER_SECONDS) return null;
  busy = true;
  try {
    const res = await fetch(api.streamUrl(track.id, { bitrate: null }), { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`Stream answered ${res.status}`);
    const data = await res.arrayBuffer();
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ctx = new Ctx(2, 1, ANALYSIS_RATE);
    const audio = await ctx.decodeAudioData(data);
    const left = new Float32Array(audio.getChannelData(0));
    const right = new Float32Array(audio.numberOfChannels > 1 ? audio.getChannelData(1) : audio.getChannelData(0));
    const result = await runWorker(left, right, audio.sampleRate);
    await api.put(`/tracks/${track.id}/analysis`, result);
    const stored = await api.get(`/tracks/${track.id}/analysis`);
    cache.set(track.id, stored);
    return stored;
  } catch (err) {
    console.warn(`Analysis of “${track.title}” failed`, err);
    return null;
  } finally { busy = false; }
}

/**
 * Analysis for a library song: { peaks: Float32Array|null, bpm, key, camelot, loudness, energy, ... }.
 * `analyse`: if nothing is stored and the server can't do it, analyse here.
 */
export async function getAnalysis(track, { analyse = false } = {}) {
  if (!track || typeof track.id !== 'number') return null;
  const hit = cache.get(track.id);
  if (hit && !(hit instanceof Promise) && hit.analyzed) return hit;
  if (hit instanceof Promise) return hit;
  const p = (async () => {
    let a = await api.get(`/tracks/${track.id}/analysis`).catch(() => null);
    if (a && !a.analyzed && a.browser && analyse && browserAnalysisOn()) a = (await analyseInBrowser(track)) || a;
    if (a?.peaks && typeof a.peaks === 'string') a.peaks = decodePeaks(a.peaks);
    cache.set(track.id, a);
    return a;
  })();
  cache.set(track.id, p);
  return p;
}

/** Drop a cached "not analysed yet" answer so the next look asks again. */
export const forgetAnalysis = (id) => { const a = cache.get(id); if (a && !(a instanceof Promise) && !a.analyzed) cache.delete(id); };

/** Draw a waveform into a canvas: played part in `played`, the rest in `rest`. */
export function drawWave(canvas, peaks, progress, { played = '#fff', rest = 'rgba(255,255,255,.25)' } = {}) {
  const dpr = devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!peaks?.length) return;
  const bar = 3, gap = 1;
  const n = Math.max(1, Math.floor(w / (bar + gap)));
  const cut = progress * w;
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i * peaks.length) / n), b = Math.max(a + 1, Math.floor(((i + 1) * peaks.length) / n));
    let m = 0;
    for (let j = a; j < b; j++) if (peaks[j] > m) m = peaks[j];
    const bh = Math.max(2, Math.sqrt(m) * h);
    const x = i * (bar + gap);
    ctx.fillStyle = x + bar / 2 <= cut ? played : rest;
    ctx.fillRect(x, (h - bh) / 2, bar, bh);
  }
}
