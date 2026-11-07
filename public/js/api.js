// Thin fetch wrapper for the Sonara API.
import { prefs } from './util.js';

export class ApiError extends Error {
  constructor(status, message, data = null) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

async function request(method, url, body) {
  const res = await fetch('/api' + url, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/auth/')) onUnauthorized();
    throw new ApiError(res.status, data?.error || `Request failed (${res.status})`, data);
  }
  return data;
}

// ───────── Streaming quality (per browser) ─────────

const audioProbe = typeof Audio !== 'undefined' ? new Audio() : null;
const canPlay = (type) => !!audioProbe?.canPlayType(type).replace('no', '');
/** Lossy codec this browser handles best, used whenever the server has to transcode. */
export const preferredCodec = () => {
  const chosen = prefs.get('streamCodec', 'auto');
  if (chosen !== 'auto') return chosen;
  return canPlay('audio/ogg; codecs="opus"') ? 'opus' : canPlay('audio/aac') ? 'aac' : 'mp3';
};
const onCellular = () => {
  const c = navigator.connection;
  return !!c && (c.type === 'cellular' || c.saveData === true);
};
/** kbps cap for streaming right now (0 = original quality). */
export const streamBitrate = () => Number(onCellular() ? prefs.get('streamBitrateCellular', prefs.get('streamBitrate', 0)) : prefs.get('streamBitrate', 0)) || 0;
const streamParams = () => {
  const bitrate = streamBitrate();
  const codec = preferredCodec();
  return { bitrate: bitrate || null, codec: codec !== 'opus' ? codec : null };
};

const qs = (o = {}) => {
  const p = new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== ''));
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const api = {
  get: (url, params) => request('GET', url + qs(params)),
  post: (url, body = {}) => request('POST', url, body),
  put: (url, body = {}) => request('PUT', url, body),
  del: (url) => request('DELETE', url),
  streamUrl: (id, extra = {}) => `/api/stream/${id}${qs({ ...streamParams(), ...extra })}`,
  downloadUrl: (kind, id, params = {}) => `/api/download/${kind}/${encodeURIComponent(id)}${qs(params)}`,
};
