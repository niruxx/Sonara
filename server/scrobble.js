// Scrobbling to Last.fm and ListenBrainz, per user.
//
// ListenBrainz: the user pastes their user token.
// Last.fm: an admin adds an API key + secret (https://www.last.fm/api/account/create),
// then each user connects their account through Last.fm's sign-in page.
// Scrobbles go through a queue in the database, so nothing is lost when a
// service is down; "now playing" updates are best-effort.

import crypto from 'node:crypto';
import { q } from './db.js';
import { getConfig } from './config.js';
import { request } from './online.js';
import { log } from './logger.js';

const LASTFM = 'https://ws.audioscrobbler.com/2.0/';
const LB = 'https://api.listenbrainz.org/1';
const MAX_ATTEMPTS = 20;

// ───────── Connections ─────────

export function services(userId) {
  const out = {};
  for (const r of q('SELECT service, data FROM user_services WHERE user_id = ?').all(userId)) {
    try { out[r.service] = JSON.parse(r.data); } catch { /* ignore */ }
  }
  return out;
}

function saveService(userId, service, data) {
  q(`INSERT INTO user_services (user_id, service, data) VALUES (?, ?, ?)
    ON CONFLICT(user_id, service) DO UPDATE SET data = excluded.data`).run(userId, service, JSON.stringify(data));
}

export function disconnect(userId, service) {
  q('DELETE FROM user_services WHERE user_id = ? AND service = ?').run(userId, service);
  q('DELETE FROM scrobble_queue WHERE user_id = ? AND service = ?').run(userId, service);
}

export function setEnabled(userId, service, enabled) {
  const s = services(userId)[service];
  if (s) saveService(userId, service, { ...s, enabled: !!enabled });
}

/** Public view of a user's connections (no secrets). */
export function publicServices(userId) {
  const s = services(userId);
  const c = getConfig();
  return {
    lastfm: { available: !!(c.lastfmApiKey && c.lastfmSecret), connected: !!s.lastfm, name: s.lastfm?.name || null, enabled: s.lastfm?.enabled !== false },
    listenbrainz: { available: true, connected: !!s.listenbrainz, name: s.listenbrainz?.name || null, enabled: s.listenbrainz?.enabled !== false },
  };
}

// ── ListenBrainz

export async function connectListenBrainz(userId, token) {
  token = String(token || '').trim();
  if (!/^[\w-]{20,}$/.test(token)) throw Object.assign(new Error('That doesn’t look like a ListenBrainz user token'), { status: 400 });
  const res = await request(`${LB}/validate-token`, { headers: { Authorization: `Token ${token}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.valid) throw Object.assign(new Error('ListenBrainz did not accept that token'), { status: 400 });
  saveService(userId, 'listenbrainz', { token, name: body.user_name, enabled: true });
  return body.user_name;
}

// ── Last.fm

function lastfmSign(params) {
  const secret = getConfig().lastfmSecret;
  const str = Object.keys(params).filter((k) => k !== 'format' && k !== 'callback').sort().map((k) => k + params[k]).join('') + secret;
  return crypto.createHash('md5').update(str, 'utf8').digest('hex');
}

async function lastfmCall(params, { post = false } = {}) {
  const c = getConfig();
  const all = { ...params, api_key: c.lastfmApiKey };
  all.api_sig = lastfmSign(all);
  all.format = 'json';
  const body = new URLSearchParams(all);
  const res = post
    ? await request(LASTFM, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
    : await request(`${LASTFM}?${body}`);
  const json = await res.json().catch(() => ({}));
  if (json.error) throw Object.assign(new Error(`Last.fm: ${json.message || json.error}`), { code: json.error, status: 400 });
  if (!res.ok) throw Object.assign(new Error(`Last.fm answered ${res.status}`), { status: 502 });
  return json;
}

export function lastfmAuthUrl(callbackUrl) {
  const c = getConfig();
  if (!c.lastfmApiKey || !c.lastfmSecret) throw Object.assign(new Error('An admin needs to add a Last.fm API key and secret in Settings first'), { status: 400 });
  return `https://www.last.fm/api/auth/?${new URLSearchParams({ api_key: c.lastfmApiKey, cb: callbackUrl })}`;
}

export async function finishLastfm(userId, token) {
  const r = await lastfmCall({ method: 'auth.getSession', token: String(token) });
  saveService(userId, 'lastfm', { sessionKey: r.session.key, name: r.session.name, enabled: true });
  return r.session.name;
}

// ───────── Sending ─────────

const meta = (t) => ({
  artist: t.artist, title: t.title, album: t.album || undefined, albumArtist: t.album_artist || undefined,
  trackNo: t.track_no || undefined, duration: t.duration ? Math.round(t.duration) : undefined, mbid: t.mbz_track_id || undefined,
});

async function send(service, cred, kind, m, listenedAt) {
  if (service === 'listenbrainz') {
    const track_metadata = {
      artist_name: m.artist, track_name: m.title, release_name: m.album,
      additional_info: { duration: m.duration, tracknumber: m.trackNo, recording_mbid: m.mbid, media_player: 'Sonara', submission_client: 'Sonara' },
    };
    const payload = kind === 'now' ? [{ track_metadata }] : [{ listened_at: Math.floor(listenedAt / 1000), track_metadata }];
    const res = await request(`${LB}/submit-listens`, {
      method: 'POST', body: JSON.stringify({ listen_type: kind === 'now' ? 'playing_now' : 'single', payload }),
      headers: { Authorization: `Token ${cred.token}`, 'Content-Type': 'application/json' },
    });
    if (res.status === 401) throw Object.assign(new Error('ListenBrainz token rejected'), { fatal: true });
    if (!res.ok) throw new Error(`ListenBrainz answered ${res.status}`);
    return;
  }
  if (service === 'lastfm') {
    const p = { sk: cred.sessionKey, artist: m.artist, track: m.title };
    if (m.album) p.album = m.album;
    if (m.albumArtist && m.albumArtist !== m.artist) p.albumArtist = m.albumArtist;
    if (m.trackNo) p.trackNumber = String(m.trackNo);
    if (m.duration) p.duration = String(m.duration);
    if (m.mbid) p.mbid = m.mbid;
    try {
      if (kind === 'now') await lastfmCall({ ...p, method: 'track.updateNowPlaying' }, { post: true });
      else await lastfmCall({ ...p, method: 'track.scrobble', timestamp: String(Math.floor(listenedAt / 1000)) }, { post: true });
    } catch (err) {
      // 9 = invalid session (user revoked access), 10/26 = bad or suspended API key.
      if ([9, 10, 26].includes(err.code)) err.fatal = true;
      throw err;
    }
  }
}

const active = (userId) => Object.entries(services(userId)).filter(([, c]) => c.enabled !== false);

/** "Now playing" (not queued; failures are ignored). */
export function nowPlaying(userId, track) {
  for (const [service, cred] of active(userId)) {
    send(service, cred, 'now', meta(track)).catch((err) => log.warn(`[scrobble] ${service} now playing: ${err.message}`));
  }
}

/** Queue a scrobble for every connected service. */
export function scrobble(userId, track, listenedAt = Date.now()) {
  const now = Date.now();
  for (const [service] of active(userId)) {
    q('INSERT INTO scrobble_queue (user_id, service, payload, next_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(userId, service, JSON.stringify({ m: meta(track), listenedAt }), now, now);
  }
  setImmediate(flush);
}

let flushing = false;
export async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    const due = q('SELECT * FROM scrobble_queue WHERE next_at <= ? ORDER BY id LIMIT 50').all(Date.now());
    for (const row of due) {
      const cred = services(row.user_id)[row.service];
      if (!cred) { q('DELETE FROM scrobble_queue WHERE id = ?').run(row.id); continue; }
      const { m, listenedAt } = JSON.parse(row.payload);
      try {
        await send(row.service, cred, 'scrobble', m, listenedAt);
        q('DELETE FROM scrobble_queue WHERE id = ?').run(row.id);
      } catch (err) {
        const attempts = row.attempts + 1;
        if (err.fatal || attempts >= MAX_ATTEMPTS) {
          log.warn(`[scrobble] Dropping ${row.service} scrobble for user ${row.user_id}: ${err.message}`);
          q('DELETE FROM scrobble_queue WHERE id = ?').run(row.id);
          if (err.fatal) setEnabled(row.user_id, row.service, false);
        } else {
          const wait = Math.min(6 * 3600000, 60000 * 2 ** attempts);
          q('UPDATE scrobble_queue SET attempts = ?, next_at = ? WHERE id = ?').run(attempts, Date.now() + wait, row.id);
        }
      }
    }
  } finally {
    flushing = false;
  }
}

export const pendingCount = (userId) => q('SELECT COUNT(*) AS n FROM scrobble_queue WHERE user_id = ?').get(userId).n;

setInterval(() => flush().catch(() => {}), 60000).unref();
