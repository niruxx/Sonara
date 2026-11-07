// Shared helper for the optional online services (LRCLIB, MusicBrainz,
// Wikipedia, Cover Art Archive, Last.fm, ListenBrainz, fanart.tv).
// Every feature that uses it is off until an admin enables it in Settings.

import fs from 'node:fs';
import { ROOT, getConfig } from './config.js';

const pkg = JSON.parse(fs.readFileSync(`${ROOT}/package.json`, 'utf8'));
// Services like MusicBrainz ask clients to identify themselves. Admins can add
// a contact (URL or email) with "onlineContact" in data/config.json.
const userAgent = () => {
  const contact = String(getConfig().onlineContact || '').trim();
  return `Sonara/${pkg.version} ( ${contact || 'self-hosted music server'} )`;
};

// Per-host spacing between requests (MusicBrainz allows 1 request per second).
const MIN_GAP = { 'musicbrainz.org': 1100, 'coverartarchive.org': 250 };
const nextSlot = new Map();

async function waitTurn(host) {
  const gap = MIN_GAP[host];
  if (!gap) return;
  const now = Date.now();
  const at = Math.max(now, nextSlot.get(host) || 0);
  nextSlot.set(host, at + gap);
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** fetch with a timeout, rate limiting and our User-Agent. */
export async function request(url, { method = 'GET', headers = {}, body, timeout = 10000 } = {}) {
  const u = new URL(url);
  await waitTurn(u.hostname.replace(/^www\./, ''));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    return await fetch(u, { method, body, signal: ctrl.signal, headers: { 'User-Agent': userAgent(), Accept: 'application/json', ...headers }, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
}

/** request(), retrying "busy" answers (503/429) a couple of times with growing pauses. */
async function requestRetry(url, opts, tries = 3) {
  for (let i = 0; ; i++) {
    const res = await request(url, opts);
    if ((res.status !== 503 && res.status !== 429) || i >= tries - 1) return res;
    const wait = Number(res.headers.get('retry-after')) * 1000 || 1500 * 2 ** i;
    await new Promise((r) => setTimeout(r, Math.min(wait, 10000)));
  }
}

export async function getJson(url, opts) {
  const res = await requestRetry(url, opts);
  if (res.status === 404) return null;
  if (!res.ok) throw new HttpError(res.status, `${new URL(url).hostname} answered ${res.status}`);
  return res.json();
}

export async function getBuffer(url, opts) {
  const res = await requestRetry(url, { ...opts, headers: { Accept: 'image/*', ...(opts?.headers || {}) } });
  if (res.status === 404) return null;
  if (!res.ok) throw new HttpError(res.status, `${new URL(url).hostname} answered ${res.status}`);
  const type = res.headers.get('content-type') || '';
  return { data: Buffer.from(await res.arrayBuffer()), type };
}
