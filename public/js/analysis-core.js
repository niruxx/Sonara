// Audio analysis, shared by the server (fed by ffmpeg) and the browser (fed by
// Web Audio). Plain JavaScript, no DOM and no dependencies.
//
// Feed it interleaved float samples with push(); finish() returns:
//   peaks     waveform, PEAK_COUNT values 0–255 (base64)
//   loudness  integrated loudness, LUFS (ITU-R BS.1770 / EBU R128, K-weighted, gated)
//   peak      sample peak, linear
//   bpm       tempo (null when there's no clear beat)
//   key       e.g. 'A minor', with camelot e.g. '8A'
//   energy    0–1
//   features  number vector used for "sounds like" comparisons

export const ANALYSIS_VERSION = 1;
export const ANALYSIS_RATE = 22050;
export const PEAK_COUNT = 800;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ───────── FFT (in place, radix 2) ─────────

const fftCache = new Map();
function fftTables(n) {
  let t = fftCache.get(n);
  if (t) return t;
  const rev = new Uint32Array(n);
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = -Math.sin((2 * Math.PI * i) / n); }
  const win = new Float64Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  t = { rev, cos, sin, win };
  fftCache.set(n, t);
  return t;
}

/** Magnitude spectrum (n/2 bins) of a Hann-windowed real frame. */
function magnitudes(frame, n, out) {
  const { rev, cos, sin, win } = fftTables(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[rev[i]] = frame[i] * win[i];
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = 0; j < half; j++) {
        const k = j * step;
        const a = i + j, b = a + half;
        const tr = re[b] * cos[k] - im[b] * sin[k];
        const ti = re[b] * sin[k] + im[b] * cos[k];
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
  for (let i = 0; i < n / 2; i++) out[i] = Math.hypot(re[i], im[i]);
  return out;
}

/** Collects mono samples into overlapping frames. */
class Framer {
  constructor(size, hop, onFrame) {
    Object.assign(this, { size, hop, onFrame });
    this.buf = new Float32Array(size);
    this.fill = 0;
  }
  push(x) {
    let i = 0;
    while (i < x.length) {
      const n = Math.min(this.size - this.fill, x.length - i);
      this.buf.set(x.subarray(i, i + n), this.fill);
      this.fill += n;
      i += n;
      if (this.fill === this.size) {
        this.onFrame(this.buf);
        this.buf.copyWithin(0, this.hop);
        this.fill = this.size - this.hop;
      }
    }
  }
}

// ───────── Loudness (BS.1770 K-weighting) ─────────

function biquad(b0, b1, b2, a0, a1, a2) {
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}
function kWeighting(fs) {
  // Coefficients for any sample rate (the same derivation as pyloudnorm).
  let G = 3.999843853973347, f0 = 1681.974450955533, Q = 0.7071752369554196;
  let A = 10 ** (G / 40), w0 = (2 * Math.PI * f0) / fs, alpha = Math.sin(w0) / (2 * Q), c = Math.cos(w0), sA = Math.sqrt(A);
  const shelf = biquad(A * ((A + 1) + (A - 1) * c + 2 * sA * alpha), -2 * A * ((A - 1) + (A + 1) * c), A * ((A + 1) + (A - 1) * c - 2 * sA * alpha),
    (A + 1) - (A - 1) * c + 2 * sA * alpha, 2 * ((A - 1) - (A + 1) * c), (A + 1) - (A - 1) * c - 2 * sA * alpha);
  f0 = 38.13547087602444; Q = 0.5003270373238773;
  w0 = (2 * Math.PI * f0) / fs; alpha = Math.sin(w0) / (2 * Q); c = Math.cos(w0);
  const hp = biquad((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + alpha, -2 * c, 1 - alpha);
  return [shelf, hp];
}

// ───────── Key profiles (Krumhansl–Kessler) ─────────

const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
export const PITCHES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const camelotMajor = (pc) => ((pc * 7) % 12 + 7) % 12 + 1;
export const camelot = (pc, minor) => `${camelotMajor(minor ? (pc + 3) % 12 : pc)}${minor ? 'A' : 'B'}`;

function correlate(x, profile, shift) {
  let mx = 0, my = 0;
  for (let i = 0; i < 12; i++) { mx += x[i]; my += profile[i]; }
  mx /= 12; my /= 12;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < 12; i++) {
    const a = x[(i + shift) % 12] - mx, b = profile[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : 0;
}

const BANDS = [60, 150, 300, 600, 1200, 2400, 4800, 8000, 11025];

export class Analyzer {
  constructor({ sampleRate = ANALYSIS_RATE, channels = 2 } = {}) {
    this.fs = sampleRate;
    this.ch = channels;
    this.samples = 0;
    this.peak = 0;
    // Waveform: one max per 1/20 s, squeezed to PEAK_COUNT at the end.
    this.blockLen = Math.round(sampleRate / 20);
    this.blockMax = 0;
    this.blockFill = 0;
    this.blocks = [];
    // Loudness: mean square per 100 ms per channel, after K-weighting.
    this.k = kWeighting(sampleRate);
    this.kState = Array.from({ length: channels }, () => [[0, 0, 0, 0], [0, 0, 0, 0]]);
    this.subLen = Math.round(sampleRate / 10);
    this.subFill = 0;
    this.subSum = new Float64Array(channels);
    this.subs = [];
    // Onsets (tempo): 512-point frames every 256 samples.
    this.onsetFps = sampleRate / 256;
    this.onsets = [];
    this.prevSpec = null;
    this.specSmall = new Float64Array(256);
    this.small = new Framer(512, 256, (f) => this.#onsetFrame(f));
    // Spectral features and chroma: 4096-point frames every 2048 samples.
    this.specBig = new Float64Array(2048);
    this.big = new Framer(4096, 2048, (f) => this.#bigFrame(f));
    this.chroma = new Float64Array(12);
    this.bands = new Float64Array(BANDS.length - 1);
    this.frames = 0;
    this.centroid = [0, 0];
    this.rolloff = 0;
    this.flatness = 0;
    this.zcr = 0;
    this.frameRms = [];
    this.binHz = sampleRate / 4096;
    this.pitchOfBin = new Int8Array(2048).fill(-1);
    for (let b = 1; b < 2048; b++) {
      const f = b * this.binHz;
      if (f < 80 || f > 2000) continue; // below ~80 Hz it's mostly drums, not notes
      this.pitchOfBin[b] = ((Math.round(12 * Math.log2(f / 440)) % 12) + 12 + 9) % 12;
    }
  }

  /** Interleaved samples (Float32Array, `channels` per frame). */
  push(data) {
    const ch = this.ch;
    const n = Math.floor(data.length / ch);
    const mono = new Float32Array(n);
    const [s1, s2] = this.k;
    for (let i = 0; i < n; i++) {
      let m = 0;
      for (let c = 0; c < ch; c++) {
        const x = data[i * ch + c];
        m += x;
        const ax = x < 0 ? -x : x;
        if (ax > this.peak) this.peak = ax;
        // Two cascaded biquads (direct form I) per channel.
        const st = this.kState[c];
        let y = s1.b0 * x + s1.b1 * st[0][0] + s1.b2 * st[0][1] - s1.a1 * st[0][2] - s1.a2 * st[0][3];
        st[0][1] = st[0][0]; st[0][0] = x; st[0][3] = st[0][2]; st[0][2] = y;
        const z = s2.b0 * y + s2.b1 * st[1][0] + s2.b2 * st[1][1] - s2.a1 * st[1][2] - s2.a2 * st[1][3];
        st[1][1] = st[1][0]; st[1][0] = y; st[1][3] = st[1][2]; st[1][2] = z;
        this.subSum[c] += z * z;
      }
      m /= ch;
      mono[i] = m;
      const am = m < 0 ? -m : m;
      if (am > this.blockMax) this.blockMax = am;
      if (++this.blockFill === this.blockLen) { this.blocks.push(this.blockMax); this.blockMax = 0; this.blockFill = 0; }
      if (++this.subFill === this.subLen) {
        let e = 0;
        for (let c = 0; c < ch; c++) { e += this.subSum[c] / this.subLen; this.subSum[c] = 0; }
        this.subs.push(e);
        this.subFill = 0;
      }
    }
    this.samples += n;
    this.small.push(mono);
    this.big.push(mono);
  }

  #onsetFrame(frame) {
    const mag = magnitudes(frame, 512, this.specSmall);
    // Log-compressed spectral flux, up to ~5.5 kHz.
    const top = Math.min(256, Math.round(5500 / (this.fs / 512)));
    let flux = 0;
    const cur = new Float64Array(top);
    for (let i = 1; i < top; i++) {
      cur[i] = Math.log1p(100 * mag[i]);
      if (this.prevSpec) { const d = cur[i] - this.prevSpec[i]; if (d > 0) flux += d; }
    }
    this.prevSpec = cur;
    this.onsets.push(flux);
  }

  #bigFrame(frame) {
    let zc = 0, sq = 0;
    for (let i = 0; i < frame.length; i++) {
      sq += frame[i] * frame[i];
      if (i && (frame[i] >= 0) !== (frame[i - 1] >= 0)) zc++;
    }
    const rms = Math.sqrt(sq / frame.length);
    this.frameRms.push(rms);
    if (rms < 1e-4) return; // silence says nothing about the sound
    const mag = magnitudes(frame, 4096, this.specBig);
    let total = 0, weighted = 0, logSum = 0, count = 0;
    const bandE = new Float64Array(BANDS.length - 1);
    for (let b = 1; b < 2048; b++) {
      const m = mag[b], f = b * this.binHz, p = m * m;
      total += m;
      weighted += m * f;
      logSum += Math.log(m + 1e-12);
      count++;
      const pc = this.pitchOfBin[b];
      if (pc >= 0) this.chroma[pc] += Math.log1p(m);
      for (let k = 0; k < bandE.length; k++) if (f >= BANDS[k] && f < BANDS[k + 1]) { bandE[k] += p; break; }
    }
    if (!total) return;
    let acc = 0, roll = 0;
    for (let b = 1; b < 2048; b++) { acc += mag[b]; if (acc >= 0.85 * total) { roll = b * this.binHz; break; } }
    const centroid = weighted / total;
    this.centroid[0] += centroid;
    this.centroid[1] += centroid * centroid;
    this.rolloff += roll;
    this.flatness += Math.exp(logSum / count) / (total / count);
    this.zcr += zc / frame.length;
    let bandTotal = 0;
    for (const e of bandE) bandTotal += e;
    for (let k = 0; k < bandE.length; k++) this.bands[k] += bandTotal ? bandE[k] / bandTotal : 0;
    this.frames++;
  }

  #loudness() {
    // 400 ms blocks (four 100 ms parts), 75 % overlap, absolute gate −70 LUFS, relative gate −10 LU.
    const blocks = [];
    for (let i = 3; i < this.subs.length; i++) blocks.push((this.subs[i] + this.subs[i - 1] + this.subs[i - 2] + this.subs[i - 3]) / 4);
    const lufs = (z) => -0.691 + 10 * Math.log10(z);
    const abs = blocks.filter((z) => z > 0 && lufs(z) > -70);
    if (!abs.length) return null;
    const rel = lufs(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
    const gated = abs.filter((z) => lufs(z) > rel);
    return gated.length ? lufs(gated.reduce((a, b) => a + b, 0) / gated.length) : null;
  }

  #tempo() {
    const fps = this.onsetFps;
    // Up to 5 minutes from the middle is plenty.
    let env = this.onsets;
    const max = Math.round(fps * 300);
    if (env.length > max) { const s = Math.floor((env.length - max) / 2); env = env.slice(s, s + max); }
    if (env.length < fps * 8) return { bpm: null, confidence: 0 };
    // Remove the slow trend, keep the bumps.
    const w = Math.round(fps);
    const e = new Float64Array(env.length);
    let run = 0;
    for (let i = 0; i < env.length; i++) {
      run += env[i];
      if (i >= w) run -= env[i - w];
      const mean = run / Math.min(i + 1, w);
      e[i] = Math.max(0, env[i] - mean);
    }
    const ac = (lag) => { let s = 0; for (let i = lag; i < e.length; i++) s += e[i] * e[i - lag]; return s / (e.length - lag); };
    const lo = Math.floor((60 * fps) / 210), hi = Math.ceil((60 * fps) / 55);
    const acs = new Float64Array(hi + 2);
    let mean = 0;
    for (let lag = lo; lag <= hi + 1; lag++) { acs[lag] = ac(lag); mean += acs[lag]; }
    mean /= hi - lo + 2;
    let best = -1, bestScore = -Infinity;
    for (let lag = lo + 1; lag <= hi; lag++) {
      const bpm = (60 * fps) / lag;
      // People hear tempos near 120 most easily; a beat that repeats at double the period counts too.
      const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.8) ** 2);
      const support = 2 * lag <= hi + 1 ? 0.5 * acs[2 * lag] : 0.5 * ac(2 * lag);
      const score = (acs[lag] + support) * prior;
      if (score > bestScore && acs[lag] >= acs[lag - 1] && acs[lag] >= acs[lag + 1]) { bestScore = score; best = lag; }
    }
    if (best < 0 || !mean) return { bpm: null, confidence: 0 };
    const [a, b, c] = [acs[best - 1], acs[best], acs[best + 1]];
    const denom = a - 2 * b + c;
    const frac = denom ? clamp(0.5 * (a - c) / denom, -0.5, 0.5) : 0;
    const confidence = b / mean;
    const bpm = (60 * fps) / (best + frac);
    return { bpm: confidence > 1.15 ? Math.round(bpm * 10) / 10 : null, confidence };
  }

  #key() {
    const sum = this.chroma.reduce((a, b) => a + b, 0);
    if (!sum) return null;
    let best = { r: -2 };
    for (let pc = 0; pc < 12; pc++) {
      for (const [minor, prof] of [[false, MAJOR], [true, MINOR]]) {
        const r = correlate(this.chroma, prof, pc);
        if (r > best.r) best = { r, pc, minor };
      }
    }
    if (best.r < 0.3) return null; // no clear tonal centre (percussion, noise, speech)
    return { name: `${PITCHES[best.pc]} ${best.minor ? 'minor' : 'major'}`, camelot: camelot(best.pc, best.minor), pc: best.pc, minor: best.minor, strength: best.r };
  }

  finish() {
    if (this.blockFill) this.blocks.push(this.blockMax);
    const duration = this.samples / this.fs;
    // Waveform
    const peaks = new Uint8Array(PEAK_COUNT);
    const B = this.blocks;
    if (B.length) {
      for (let i = 0; i < PEAK_COUNT; i++) {
        const a = Math.floor((i * B.length) / PEAK_COUNT), b = Math.max(a + 1, Math.floor(((i + 1) * B.length) / PEAK_COUNT));
        let m = 0;
        for (let j = a; j < b && j < B.length; j++) if (B[j] > m) m = B[j];
        peaks[i] = Math.round(clamp(m, 0, 1) * 255);
      }
    }
    const loudness = this.#loudness();
    const { bpm, confidence } = this.#tempo();
    const key = this.#key();
    const n = this.frames || 1;
    const centroid = this.centroid[0] / n;
    const centroidSd = Math.sqrt(Math.max(0, this.centroid[1] / n - centroid * centroid));
    const onsetMean = this.onsets.length ? this.onsets.reduce((a, b) => a + b, 0) / this.onsets.length : 0;
    const rmsMean = this.frameRms.length ? this.frameRms.reduce((a, b) => a + b, 0) / this.frameRms.length : 0;
    const lowEnergy = this.frameRms.length ? this.frameRms.filter((r) => r < rmsMean).length / this.frameRms.length : 0;
    const loud01 = loudness == null ? 0 : clamp((loudness + 30) / 24, 0, 1);
    const energy = clamp(0.5 * loud01 + 0.3 * clamp(onsetMean / 60, 0, 1) + 0.2 * clamp(centroid / 3500, 0, 1), 0, 1);
    const chromaSum = this.chroma.reduce((a, b) => a + b, 0) || 1;
    const bpmFolded = bpm ? (bpm < 80 ? bpm * 2 : bpm > 160 ? bpm / 2 : bpm) : 0;
    const features = [
      bpmFolded / 160, Math.min(1, confidence / 4), energy, loud01,
      centroid / 4000, centroidSd / 2000, this.rolloff / n / 8000, this.flatness / n, this.zcr / n * 10, lowEnergy,
      onsetMean / 60,
      ...[...this.bands].map((v) => v / n),
      ...[...this.chroma].map((v) => v / chromaSum),
      key ? (key.minor ? 0 : 1) : 0.5,
    ].map((v) => (Number.isFinite(v) ? Math.round(v * 10000) / 10000 : 0));
    return {
      version: ANALYSIS_VERSION,
      duration,
      peaks: toBase64(peaks),
      loudness: loudness == null ? null : Math.round(loudness * 100) / 100,
      peak: Math.round(this.peak * 10000) / 10000,
      bpm,
      key: key?.name || null,
      camelot: key?.camelot || null,
      energy: Math.round(energy * 1000) / 1000,
      features,
    };
  }
}

function toBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** Decode stored peaks back to numbers 0–1. */
export function decodePeaks(b64) {
  if (!b64) return null;
  const bin = typeof atob !== 'undefined' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const out = new Float32Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) / 255;
  return out;
}
