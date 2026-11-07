// Visualizers driven by the player's AnalyserNode.
//  • a global "pulse" CSS variable (bass energy) that makes the whole UI breathe
//  • on the Now Playing view: mirrored spectrum bars, an oscilloscope wave, a
//    radial spectrum, or Milkdrop presets (butterchurn, loaded on request)
import { player } from './player.js';
import { prefs } from './util.js';

const root = document.documentElement;
let freq = null;
let wave = null;
export const VIS_STYLES = ['bars', 'wave', 'radial', 'milkdrop'];
export const visStyle = () => (VIS_STYLES.includes(prefs.get('visStyle', 'bars')) ? prefs.get('visStyle', 'bars') : 'bars');
let pulse = 0;
let canvas = null;
let raf = 0;

// Only elements that use --pulse get it (setting it on :root would restyle the whole page each frame).
let targets = [];
let targetsAt = 0;
function setPulse(v) {
  if (performance.now() - targetsAt > 1000) {
    targets = [...document.querySelectorAll('.ambient, .playerbar, .np')];
    targetsAt = performance.now();
  }
  const s = v.toFixed(3);
  for (const t of targets) t.style.setProperty('--pulse', s);
}

function readColors() {
  const cs = getComputedStyle(root);
  return [cs.getPropertyValue('--c1').trim(), cs.getPropertyValue('--c2').trim(), cs.getPropertyValue('--c3').trim()];
}

function tick() {
  raf = requestAnimationFrame(tick);
  const an = player.analyser;
  if (!an || prefs.get('visualizer', true) === false) {
    if (pulse > 0.001) { pulse *= 0.9; setPulse(pulse); }
    return;
  }
  if (!freq || freq.length !== an.frequencyBinCount) freq = new Uint8Array(an.frequencyBinCount);
  an.getByteFrequencyData(freq);

  // Bass energy (~20–150 Hz) → smoothed pulse value 0..1
  const binHz = (player.ctx.sampleRate / 2) / freq.length;
  const lo = Math.max(1, Math.floor(20 / binHz)), hi = Math.ceil(150 / binHz);
  let sum = 0;
  for (let i = lo; i <= hi; i++) sum += freq[i];
  const bass = player.playing ? Math.pow(sum / ((hi - lo + 1) * 255), 2.2) : 0;
  pulse += (bass - pulse) * (bass > pulse ? 0.5 : 0.08);
  setPulse(pulse);

  if (!canvas?.closest('.np.open')) return;
  const style = visStyle();
  if (style === 'milkdrop' && milk) { milk.render(); return; }
  if (style === 'wave') drawWave(canvas);
  else if (style === 'radial') drawRadial(canvas);
  else drawSpectrum(canvas);
}

const flat = () => document.body.classList.contains('flat');

function sizeCanvas(cv) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = cv.clientWidth * dpr, h = cv.clientHeight * dpr;
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  return { ctx: cv.getContext('2d'), w, h, dpr };
}

/** Oscilloscope: the waveform itself, as a glowing line. */
function drawWave(cv) {
  const { ctx, w, h, dpr } = sizeCanvas(cv);
  const an = player.analyser;
  if (!wave || wave.length !== an.fftSize) wave = new Float32Array(an.fftSize);
  an.getFloatTimeDomainData(wave);
  ctx.clearRect(0, 0, w, h);
  if (performance.now() - colorCache.t > 500) colorCache = { t: performance.now(), c: readColors() };
  ctx.strokeStyle = colorCache.c[0];
  ctx.lineWidth = 3 * dpr;
  ctx.shadowColor = colorCache.c[0];
  ctx.shadowBlur = flat() ? 0 : 18 * dpr;
  ctx.beginPath();
  const step = Math.max(1, Math.floor(wave.length / (w / (2 * dpr))));
  for (let i = 0, x = 0; i < wave.length; i += step, x += (w / wave.length) * step) {
    const y = h * 0.55 + wave[i] * h * 0.4;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.stroke();
}

/** Radial: spectrum bars around a circle behind the cover. */
function drawRadial(cv) {
  const { ctx, w, h, dpr } = sizeCanvas(cv);
  ctx.clearRect(0, 0, w, h);
  if (performance.now() - colorCache.t > 500) colorCache = { t: performance.now(), c: readColors() };
  const [c1, c2] = colorCache.c;
  const cx = w / 2, cy = h * 0.55, r0 = Math.min(w, h) * 0.22;
  const n = 120, usable = Math.floor(freq.length * 0.6);
  ctx.lineWidth = Math.max(2 * dpr, (2 * Math.PI * r0) / n * 0.55);
  ctx.lineCap = 'round';
  ctx.shadowColor = c1;
  ctx.shadowBlur = flat() ? 0 : 14 * dpr;
  for (let i = 0; i < n; i++) {
    const k = Math.floor(Math.pow(Math.abs((i / n) * 2 - 1), 2) * usable); // mirrored left/right
    const v = freq[k] / 255;
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    const len = r0 * 0.15 + Math.pow(v, 1.5) * r0 * 0.9;
    ctx.strokeStyle = i % 2 ? c1 : c2;
    ctx.globalAlpha = 0.4 + v * 0.6;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
    ctx.lineTo(cx + Math.cos(a) * (r0 + len), cy + Math.sin(a) * (r0 + len));
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

// ───────── Milkdrop (butterchurn), loaded from jsDelivr when first chosen ─────────

const CDN = 'https://cdn.jsdelivr.net/npm/';
let milk = null;          // butterchurn visualizer
let milkCanvas = null;
let presetNames = [];
let presets = null;
let presetTimer = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.crossOrigin = 'anonymous';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load the Milkdrop visualizer'));
    document.head.append(s);
  });
}

/** Start Milkdrop on a WebGL canvas laid over the spectrum canvas. */
export async function startMilkdrop(host) {
  if (!player.analyser) throw new Error('Play something first');
  if (!window.butterchurn) {
    await loadScript(`${CDN}butterchurn@2.6.7/lib/butterchurn.min.js`);
    await loadScript(`${CDN}butterchurn-presets@2.4.7/lib/butterchurnPresets.min.js`);
  }
  if (!milk) {
    milkCanvas = document.createElement('canvas');
    milkCanvas.className = 'np-milk';
    milkCanvas.setAttribute('aria-hidden', 'true');
    host.prepend(milkCanvas);
    const size = () => { milkCanvas.width = host.clientWidth; milkCanvas.height = host.clientHeight; milk?.setRendererSize(host.clientWidth, host.clientHeight); };
    const bc = window.butterchurn.default || window.butterchurn;
    milk = bc.createVisualizer(player.ctx, milkCanvas, { width: host.clientWidth, height: host.clientHeight, pixelRatio: Math.min(devicePixelRatio || 1, 1.5) });
    size();
    addEventListener('resize', size);
    milk.connectAudio(player.analyser);
    presets = (window.butterchurnPresets.default || window.butterchurnPresets).getPresets();
    presetNames = Object.keys(presets);
  }
  milkCanvas.hidden = false;
  nextPreset(0);
  clearInterval(presetTimer);
  presetTimer = setInterval(() => { if (visStyle() === 'milkdrop' && player.playing) nextPreset(2.7); }, 25000);
}

export function nextPreset(blend = 2) {
  if (!milk || !presetNames.length) return null;
  const name = presetNames[Math.floor(Math.random() * presetNames.length)];
  milk.loadPreset(presets[name], blend);
  return name;
}

export function stopMilkdrop() {
  clearInterval(presetTimer);
  if (milkCanvas) milkCanvas.hidden = true;
}

let colorCache = { t: 0, c: [] };
function drawSpectrum(cv) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = cv.clientWidth * dpr, h = cv.clientHeight * dpr;
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  if (performance.now() - colorCache.t > 500) colorCache = { t: performance.now(), c: readColors() };
  const [c1, c2, c3] = colorCache.c;

  const bars = Math.min(96, Math.floor(w / (10 * dpr)));
  const half = bars / 2;
  const gap = 4 * dpr;
  const bw = (w - gap * (bars - 1)) / bars;
  const usable = Math.floor(freq.length * 0.7);
  const grad = ctx.createLinearGradient(0, h, 0, 0);
  grad.addColorStop(0, c1); grad.addColorStop(0.5, c2); grad.addColorStop(1, c3);
  ctx.fillStyle = grad;
  ctx.shadowColor = c1;
  ctx.shadowBlur = flat() ? 0 : 24 * dpr;

  for (let i = 0; i < half; i++) {
    // Log-spaced bins so bass and treble both get room.
    const a = Math.floor(Math.pow(i / half, 2) * usable);
    const b = Math.max(a + 1, Math.floor(Math.pow((i + 1) / half, 2) * usable));
    let v = 0;
    for (let k = a; k < b; k++) v = Math.max(v, freq[k]);
    const bh = Math.max(3 * dpr, Math.pow(v / 255, 1.6) * h * 0.92);
    const r = Math.min(bw / 2, 6 * dpr);
    for (const idx of [half - 1 - i, half + i]) {
      const x = idx * (bw + gap);
      ctx.globalAlpha = 0.35 + (v / 255) * 0.65;
      ctx.beginPath();
      ctx.roundRect(x, h - bh, bw, bh + r, r);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

export function attachSpectrum(cv) { canvas = cv; }

export function startVisualizer() {
  if (!raf) tick();
}
