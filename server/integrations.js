// Integrations: webhooks (per user) and MQTT with Home Assistant discovery.
//
// Webhooks: Sonara POSTs JSON to your URL when a song starts or playback pauses
// or resumes. Each request carries X-Sonara-Signature: sha256=<HMAC of the body
// with the webhook's secret>, so the receiver can check it came from Sonara.
//
// MQTT (admin setting "mqttUrl", e.g. mqtt://user:pass@homeassistant.local:1883):
// for every user who shares their listening activity (Settings → Account), Sonara publishes
//   <prefix>/<user>/now_playing   JSON (retained)
//   <prefix>/<user>/state         playing | paused (retained)
// plus Home Assistant discovery configs (a sensor and play/pause, next and
// previous buttons), and listens on <prefix>/<user>/command for
// toggle | play | pause | next | prev. A tiny MQTT 3.1.1 client, no dependency.

import crypto from 'node:crypto';
import express from 'express';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import { q } from './db.js';
import { getConfig } from './config.js';
import { log } from './logger.js';
import { onPlaybackChange, commandUser } from './connect.js';
import { cleanUrl, isPrivateAddress } from './net.js';

const EVENTS = ['track.started', 'playback.paused', 'playback.resumed'];
const typeToEvent = { track: 'track.started', pause: 'playback.paused', play: 'playback.resumed' };
const trackOut = (t) => t && { id: t.id, title: t.title, artist: t.artist, album: t.album, duration: t.duration, cover: t.cover ? `/api/cover/${t.cover}` : null };

// ───────────────────────── Webhooks ─────────────────────────

async function deliver(hook, event, data) {
  const body = JSON.stringify({ event, at: new Date().toISOString(), ...data });
  const sig = crypto.createHmac('sha256', hook.secret).update(body).digest('hex');
  let status = 0;
  try {
    const u = cleanUrl(hook.url);
    // Non-admins can't aim webhooks at the local network (same rule as feeds and streams).
    const owner = q('SELECT is_admin FROM users WHERE id = ?').get(hook.user_id);
    if (!owner?.is_admin) {
      const host = u.hostname.replace(/^\[|\]$/g, '');
      const addrs = net.isIP(host) ? [{ address: host }] : await dns.promises.lookup(host, { all: true });
      if (addrs.some((a) => isPrivateAddress(a.address))) throw new Error('private address');
    }
    const ctrl = AbortSignal.timeout(8000);
    const res = await fetch(u, { method: 'POST', body, signal: ctrl, redirect: 'manual', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Sonara-Webhook', 'X-Sonara-Event': event, 'X-Sonara-Signature': `sha256=${sig}` } });
    status = res.status;
  } catch { status = 0; }
  q('UPDATE webhooks SET last_status = ?, last_at = ? WHERE id = ?').run(status, Date.now(), hook.id);
  return status;
}

export const webhooksApi = express.Router();
const hookOut = (h) => ({ id: h.id, url: h.url, events: JSON.parse(h.events), secret: h.secret, lastStatus: h.last_status, lastAt: h.last_at });

webhooksApi.get('/', (req, res) => res.json(q('SELECT * FROM webhooks WHERE user_id = ? ORDER BY id').all(req.user.id).map(hookOut)));
webhooksApi.post('/', (req, res) => {
  let url;
  try { url = cleanUrl(req.body?.url).href; } catch (err) { return res.status(400).json({ error: err.message }); }
  const events = (Array.isArray(req.body?.events) ? req.body.events : EVENTS).filter((e) => EVENTS.includes(e));
  if (!events.length) return res.status(400).json({ error: 'Pick at least one event' });
  if (q('SELECT COUNT(*) AS n FROM webhooks WHERE user_id = ?').get(req.user.id).n >= 10) return res.status(400).json({ error: 'Up to 10 webhooks per user' });
  const { lastInsertRowid } = q('INSERT INTO webhooks (user_id, url, events, secret, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(req.user.id, url, JSON.stringify(events), crypto.randomBytes(18).toString('base64url'), Date.now());
  res.json(hookOut(q('SELECT * FROM webhooks WHERE id = ?').get(Number(lastInsertRowid))));
});
webhooksApi.delete('/:id', (req, res) => { q('DELETE FROM webhooks WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id); res.json({ ok: true }); });
webhooksApi.post('/:id/test', async (req, res) => {
  const h = q('SELECT * FROM webhooks WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
  if (!h) return res.status(404).json({ error: 'Webhook not found' });
  const status = await deliver(h, 'test', { user: req.user.username, message: 'Hello from Sonara' });
  res.json({ status });
});

// ───────────────────────── MQTT ─────────────────────────

function varint(n) {
  const out = [];
  do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 128; out.push(b); } while (n > 0);
  return Buffer.from(out);
}
const str = (s) => { const b = Buffer.from(String(s), 'utf8'); const l = Buffer.alloc(2); l.writeUInt16BE(b.length); return Buffer.concat([l, b]); };
const packet = (type, body) => Buffer.concat([Buffer.from([type]), varint(body.length), body]);

class Mqtt {
  constructor(url, onMessage) {
    this.url = url;
    this.onMessage = onMessage;
    this.sock = null;
    this.ready = false;
    this.stopped = false;
    this.backoff = 2000;
    this.buf = Buffer.alloc(0);
    this.subs = new Set();
    this.connect();
  }

  connect() {
    if (this.stopped) return;
    const u = this.url;
    const secure = u.protocol === 'mqtts:';
    const opts = { host: u.hostname, port: Number(u.port) || (secure ? 8883 : 1883) };
    this.sock = secure ? tls.connect({ ...opts, servername: u.hostname }) : net.connect(opts);
    this.sock.on(secure ? 'secureConnect' : 'connect', () => {
      let flags = 0x02;
      const parts = [str('MQTT'), Buffer.from([4])];
      const user = decodeURIComponent(u.username || ''), pass = decodeURIComponent(u.password || '');
      if (user) flags |= 0x80;
      if (pass) flags |= 0x40;
      parts.push(Buffer.from([flags, 0, 60]), str(`sonara-${crypto.randomBytes(4).toString('hex')}`));
      if (user) parts.push(str(user));
      if (pass) parts.push(str(pass));
      this.sock.write(packet(0x10, Buffer.concat(parts)));
    });
    this.sock.on('data', (d) => this.#read(d));
    this.sock.on('error', (err) => { if (!this.errLogged) log.warn(`[mqtt] ${err.message}`); this.errLogged = true; });
    this.sock.on('close', () => {
      this.ready = false;
      clearInterval(this.ping);
      if (this.stopped) return;
      setTimeout(() => this.connect(), this.backoff).unref?.();
      this.backoff = Math.min(this.backoff * 2, 60000);
    });
  }

  #read(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      if (this.buf.length < 2) return;
      let len = 0, mul = 1, i = 1;
      for (;; i++) {
        if (i >= this.buf.length) return;
        const b = this.buf[i];
        len += (b & 127) * mul;
        mul *= 128;
        if (!(b & 128)) break;
      }
      const start = i + 1;
      if (this.buf.length < start + len) return;
      const type = this.buf[0] >> 4, flags = this.buf[0] & 15;
      const body = this.buf.subarray(start, start + len);
      this.buf = this.buf.subarray(start + len);
      if (type === 2) { // CONNACK
        if (body[1] !== 0) { log.warn(`[mqtt] Broker refused the connection (code ${body[1]}): check the user name and password`); this.stopped = true; this.sock.end(); return; }
        this.ready = true;
        this.backoff = 2000;
        this.errLogged = false;
        log.info(`[mqtt] Connected to ${this.url.hostname}`);
        this.ping = setInterval(() => this.sock.write(Buffer.from([0xc0, 0])), 30000);
        this.ping.unref?.();
        for (const t of this.subs) this.#subscribe(t);
        this.onConnect?.();
      } else if (type === 3) { // PUBLISH
        const tl = body.readUInt16BE(0);
        const topic = body.subarray(2, 2 + tl).toString('utf8');
        const qos = (flags >> 1) & 3;
        const payload = body.subarray(2 + tl + (qos ? 2 : 0)).toString('utf8');
        try { this.onMessage(topic, payload); } catch { /* ignore */ }
      }
    }
  }

  #subscribe(topic) {
    const id = Buffer.alloc(2);
    id.writeUInt16BE(Math.floor(Math.random() * 65535) + 1);
    this.sock.write(packet(0x82, Buffer.concat([id, str(topic), Buffer.from([0])])));
  }
  subscribe(topic) { this.subs.add(topic); if (this.ready) this.#subscribe(topic); }

  publish(topic, payload, { retain = false } = {}) {
    if (!this.ready) return false;
    this.sock.write(packet(0x30 | (retain ? 1 : 0), Buffer.concat([str(topic), Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8')])));
    return true;
  }
  stop() { this.stopped = true; clearInterval(this.ping); this.sock?.destroy(); }
}

let mqtt = null;
const prefix = () => String(getConfig().mqttPrefix || 'sonara').replace(/[#+\s]/g, '').replace(/\/$/, '') || 'sonara';
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9_-]+/g, '_');
const sharers = () => q('SELECT id, username FROM users WHERE share_activity = 1').all();

function announce(user) {
  if (!mqtt) return;
  const base = `${prefix()}/${slug(user.username)}`;
  const dev = { identifiers: [`sonara_${slug(user.username)}`], name: `Sonara (${user.username})`, manufacturer: 'Sonara' };
  mqtt.publish(`homeassistant/sensor/sonara_${slug(user.username)}/now_playing/config`, {
    name: 'Now playing', unique_id: `sonara_${slug(user.username)}_now_playing`, state_topic: `${base}/now_playing`,
    value_template: '{{ value_json.title ~ " – " ~ value_json.artist if value_json.title else "Nothing" }}', json_attributes_topic: `${base}/now_playing`, icon: 'mdi:music', device: dev,
  }, { retain: true });
  mqtt.publish(`homeassistant/sensor/sonara_${slug(user.username)}/state/config`, {
    name: 'Playback', unique_id: `sonara_${slug(user.username)}_state`, state_topic: `${base}/state`, icon: 'mdi:play-pause', device: dev,
  }, { retain: true });
  for (const [cmd, name, icon] of [['toggle', 'Play/pause', 'mdi:play-pause'], ['next', 'Next', 'mdi:skip-next'], ['prev', 'Previous', 'mdi:skip-previous']]) {
    mqtt.publish(`homeassistant/button/sonara_${slug(user.username)}/${cmd}/config`, {
      name, unique_id: `sonara_${slug(user.username)}_${cmd}`, command_topic: `${base}/command`, payload_press: cmd, icon, device: dev,
    }, { retain: true });
  }
}

export function setupIntegrations() {
  mqtt?.stop();
  mqtt = null;
  const raw = String(getConfig().mqttUrl || '').trim();
  if (raw) {
    let u;
    try { u = new URL(raw); } catch { log.warn('[mqtt] mqttUrl is not a valid address'); }
    if (u && (u.protocol === 'mqtt:' || u.protocol === 'mqtts:')) {
      mqtt = new Mqtt(u, (topic, payload) => {
        const m = topic.match(new RegExp(`^${prefix().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/([^/]+)/command$`));
        if (!m) return;
        const user = sharers().find((x) => slug(x.username) === m[1]);
        const cmd = payload.trim().toLowerCase();
        if (user && ['toggle', 'play', 'pause', 'next', 'prev'].includes(cmd)) commandUser(user.id, cmd);
      });
      mqtt.onConnect = () => { for (const u2 of sharers()) announce(u2); };
      mqtt.subscribe(`${prefix()}/+/command`);
    } else if (u) log.warn('[mqtt] mqttUrl must start with mqtt:// or mqtts://');
  }
}

export const mqttStatus = () => ({ configured: !!String(getConfig().mqttUrl || '').trim(), connected: !!mqtt?.ready });

// Fan playback changes out to webhooks and MQTT.
onPlaybackChange(({ user, type, state }) => {
  const event = typeToEvent[type];
  const data = { user: user.username, playing: !!state.playing, position: state.time, track: trackOut(state.track) };
  for (const h of q('SELECT * FROM webhooks WHERE user_id = ?').all(user.id)) {
    if (JSON.parse(h.events).includes(event)) deliver(h, event, data);
  }
  if (mqtt?.ready && q('SELECT share_activity FROM users WHERE id = ?').get(user.id)?.share_activity) {
    const base = `${prefix()}/${slug(user.username)}`;
    announce(user);
    mqtt.publish(`${base}/now_playing`, { ...trackOut(state.track), playing: !!state.playing }, { retain: true });
    mqtt.publish(`${base}/state`, state.playing ? 'playing' : 'paused', { retain: true });
  }
});
