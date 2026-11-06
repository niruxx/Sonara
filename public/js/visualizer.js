// Visualizers driven by the player's AnalyserNode.
//  • a global "pulse" CSS variable (bass energy) that makes the whole UI breathe
//  • a mirrored, glowing spectrum on a canvas (Now Playing view)
import { player } from './player.js';
import { prefs } from './util.js';

const root = document.documentElement;
let freq = null;
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

  if (canvas?.closest('.np.open')) drawSpectrum(canvas);
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
  ctx.shadowBlur = 24 * dpr;

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
