import { icon } from './icons.js';

// ───────── Safe HTML templating ─────────
// html`...` escapes every interpolated value unless it is itself html`` or raw().

class Raw {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
export const raw = (s) => new Raw(String(s));

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

function render(v) {
  if (v == null || v === false) return '';
  if (Array.isArray(v)) return v.map(render).join('');
  if (v instanceof Raw) return v.s;
  return esc(v);
}

export function html(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += render(vals[i]) + strings[i + 1];
  return new Raw(out);
}

export const ic = (name, cls) => raw(icon(name, cls));

/** Parse an html`` result into a single element. */
export function el(markup) {
  const t = document.createElement('template');
  t.innerHTML = String(markup).trim();
  return t.content.firstElementChild;
}

// ───────── Formatting ─────────

export function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function fmtLong(sec) {
  if (!sec) return '0 min';
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h} hr ${m} min` : `${m} min`;
}

export function fmtBytes(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i > 1 ? 1 : 0)} ${u[i]}`;
}

export const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

export function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Late night vibes' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

// ───────── Art ─────────

export const coverUrl = (cover) => (cover ? `/api/cover/${cover}` : null);

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}
export function hues(seed = '') {
  const h = hash(String(seed));
  return { h1: h % 360, h2: (h % 360 + 40 + ((h >> 9) % 80)) % 360 };
}

/** <img> for a cover, or a gradient placeholder derived from the name. */
export function art(cover, name = '', kind = 'disc', size = 300) {
  if (cover) return html`<img src="${coverUrl(cover)}" alt="" loading="lazy" decoding="async" width="${size}" height="${size}" draggable="false">`;
  const { h1, h2 } = hues(name);
  const letter = kind === 'artist' ? (name.trim()[0] || '?').toUpperCase() : null;
  return html`<div class="ph" style="--h1:${h1};--h2:${h2}">${letter ? html`<b>${letter}</b>` : ic(kind === 'playlist' ? 'listMusic' : 'disc')}</div>`;
}

// ───────── Colour extraction from album art ─────────

const paletteCache = new Map();
export async function paletteFrom(url) {
  if (!url) return null;
  if (paletteCache.has(url)) return paletteCache.get(url);
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  try { await img.decode(); } catch { return null; }
  const c = document.createElement('canvas');
  c.width = c.height = 40;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, 40, 40);
  const { data } = ctx.getImageData(0, 0, 40, 40);
  const buckets = new Map();
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 510;
    const s = max === min ? 0 : (max - min) / (255 - Math.abs(max + min - 255));
    if (l < 0.08 || l > 0.95) continue;
    const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
    const e = buckets.get(key) || { r: 0, g: 0, b: 0, n: 0, w: 0 };
    e.r += r; e.g += g; e.b += b; e.n++; e.w += 0.25 + s * s * 2;
    buckets.set(key, e);
  }
  const sorted = [...buckets.values()].sort((a, b) => b.w - a.w).map((e) => [e.r / e.n, e.g / e.n, e.b / e.n]);
  const picks = [];
  for (const col of sorted) {
    if (picks.every((p) => Math.hypot(p[0] - col[0], p[1] - col[1], p[2] - col[2]) > 70)) picks.push(col);
    if (picks.length === 3) break;
  }
  while (picks.length && picks.length < 3) picks.push(picks[picks.length - 1].map((v) => Math.min(255, v * 1.25)));
  // Boost saturation/brightness so the glow looks good on a dark UI.
  const res = picks.length ? picks.map(vivid) : null;
  paletteCache.set(url, res);
  return res;
}

function vivid([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  return `hsl(${Math.round(h)} ${Math.round(Math.max(s, 0.45) * 100)}% ${Math.round(Math.min(Math.max(l, 0.5), 0.66) * 100)}%)`;
}

// ───────── Misc ─────────

export const debounce = (fn, ms = 250) => {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};

export function shuffleArray(a) {
  const arr = a.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Tiny event emitter. */
export class Emitter {
  #h = new Map();
  on(ev, fn) {
    if (!this.#h.has(ev)) this.#h.set(ev, new Set());
    this.#h.get(ev).add(fn);
    return () => this.#h.get(ev)?.delete(fn);
  }
  emit(ev, ...a) { this.#h.get(ev)?.forEach((fn) => fn(...a)); }
}

export const prefs = {
  get(key, def) {
    try { const v = localStorage.getItem('sonara.' + key); return v == null ? def : JSON.parse(v); } catch { return def; }
  },
  set(key, val) { try { localStorage.setItem('sonara.' + key, JSON.stringify(val)); } catch { /* quota */ } },
};
