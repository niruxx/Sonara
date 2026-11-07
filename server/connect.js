// Sonara Connect: control playback on one device from another.
//
// Every open Sonara tab keeps a Server-Sent Events stream open (/api/connect/events)
// and reports its playback state. Commands from other devices are relayed down
// that stream. Server-side players (the jukebox and DLNA speakers) appear as
// devices too. Listening parties reuse the same channel: the host's state is
// fanned out to everyone in the party, whose players follow along.

import crypto from 'node:crypto';
import { q } from './db.js';
import { can } from './auth.js';
import { log } from './logger.js';

/** clientId -> { id, userId, username, name, res, state, user, connectedAt } */
const clients = new Map();
/** id -> server device ({ id, name, kind, state(), command() }) */
const serverDevices = new Map();
/** partyId -> { id, hostUserId, hostName, hostClient, members: Set<clientId>, state, createdAt } */
const parties = new Map();

function send(res, event, data) {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* closed */ }
}

const canUseServerDevices = (user) => can(user, 'jukebox');

/** Devices a user can see: their own open tabs plus the shared server devices. */
export function devicesFor(user, selfId = null) {
  const list = [];
  for (const c of clients.values()) {
    if (c.userId !== user.id) continue;
    list.push({ id: c.id, name: c.name, kind: 'browser', self: c.id === selfId, state: c.state || null });
  }
  if (canUseServerDevices(user)) {
    for (const d of serverDevices.values()) list.push({ id: d.id, name: d.name, kind: d.kind, state: d.state() });
  }
  return list;
}

function broadcastDevices(userId = null) {
  for (const c of clients.values()) {
    if (userId != null && c.userId !== userId && !canUseServerDevices(c.user)) continue;
    send(c.res, 'devices', devicesFor(c.user, c.id));
  }
}

/** Push a server device's state to everyone allowed to see it. */
export function serverDeviceChanged(device) {
  const state = device.state();
  for (const c of clients.values()) if (canUseServerDevices(c.user)) send(c.res, 'state', { device: device.id, state });
}

export function registerServerDevice(device) {
  serverDevices.set(device.id, device);
  broadcastDevices();
}
export function removeServerDevice(id) {
  if (serverDevices.delete(id)) broadcastDevices();
}

// ───────── Express handlers ─────────

export function eventsHandler(req, res) {
  const id = String(req.query.device || '').replace(/[^\w-]/g, '').slice(0, 40) || crypto.randomBytes(6).toString('hex');
  const name = String(req.query.name || 'Browser').slice(0, 60);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  // A reconnecting tab replaces its old stream.
  const old = clients.get(id);
  if (old && old.userId === req.user.id) { try { old.res.end(); } catch { /* ignore */ } }
  const client = { id, userId: req.user.id, username: req.user.username, name, res, state: null, user: req.user, connectedAt: Date.now() };
  clients.set(id, client);
  send(res, 'hello', { id });
  broadcastDevices(req.user.id);
  // Re-join a party after a reconnect.
  for (const p of parties.values()) {
    if (p.members.has(id) || p.hostClient === id) send(res, 'party', partyInfo(p));
  }
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 25000);
  req.on('close', () => {
    clearInterval(ping);
    if (clients.get(id) !== client) return;
    clients.delete(id);
    broadcastDevices(req.user.id);
    for (const p of parties.values()) {
      if (p.members.delete(id)) partyChanged(p);
    }
  });
}

const cleanTrack = (t) => t && {
  id: Number(t.id) || 0, title: String(t.title || '').slice(0, 300), artist: String(t.artist || '').slice(0, 300),
  album: String(t.album || '').slice(0, 300), albumId: String(t.albumId || ''), artistId: String(t.artistId || ''),
  cover: t.cover && /^[a-f0-9]{40}\.(jpg|png|webp)$/.test(t.cover) ? t.cover : null,
  duration: Number(t.duration) || 0,
  artists: Array.isArray(t.artists) ? t.artists.slice(0, 10).map((a) => ({ id: String(a.id || ''), name: String(a.name || '') })) : [],
};

/** POST /connect/state { device, state } — a browser reporting what it is playing. */
export function stateHandler(req, res) {
  const c = clients.get(String(req.body?.device || ''));
  if (!c || c.userId !== req.user.id) return res.status(404).json({ error: 'Device not connected' });
  const s = req.body?.state || {};
  c.state = {
    playing: !!s.playing, time: Math.max(0, Number(s.time) || 0), duration: Math.max(0, Number(s.duration) || 0),
    volume: Math.min(1, Math.max(0, Number(s.volume ?? 1))), track: cleanTrack(s.track),
    index: Number(s.index) || 0, queueLength: Number(s.queueLength) || 0,
    shuffle: !!s.shuffle, repeat: ['off', 'all', 'one'].includes(s.repeat) ? s.repeat : 'off', at: Date.now(),
  };
  for (const o of clients.values()) if (o.userId === c.userId && o.id !== c.id) send(o.res, 'state', { device: c.id, state: c.state });
  for (const p of parties.values()) if (p.hostClient === c.id) { p.state = c.state; partyChanged(p, { stateOnly: true }); }
  res.json({ ok: true });
}

const COMMANDS = new Set(['play', 'pause', 'toggle', 'next', 'prev', 'seek', 'volume', 'playTracks', 'jump', 'shuffle', 'repeat', 'handoff', 'stop']);

/** POST /connect/command { target, cmd, args } */
export async function commandHandler(req, res) {
  const { target, cmd } = req.body || {};
  const args = req.body?.args && typeof req.body.args === 'object' ? req.body.args : {};
  if (!COMMANDS.has(cmd)) return res.status(400).json({ error: 'Unknown command' });
  const dev = serverDevices.get(String(target));
  if (dev) {
    if (!canUseServerDevices(req.user)) return res.status(403).json({ error: "You don't have permission to use this speaker" });
    try {
      await dev.command(cmd, args, req.user);
      return res.json({ ok: true, state: dev.state() });
    } catch (err) {
      log.warn(`[connect] ${dev.name}: ${cmd} failed: ${err.message}`);
      return res.status(err.status || 502).json({ error: err.message });
    }
  }
  const c = clients.get(String(target));
  if (!c || c.userId !== req.user.id) return res.status(404).json({ error: 'That device is no longer connected' });
  send(c.res, 'command', { cmd, args, from: String(req.body?.from || '') });
  res.json({ ok: true });
}

// ───────── Listening parties ─────────

function partyInfo(p) {
  const members = [...p.members].map((id) => clients.get(id)).filter(Boolean).map((c) => ({ id: c.id, username: c.username, device: c.name }));
  return { id: p.id, host: p.hostName, hostUserId: p.hostUserId, hostClient: p.hostClient, members, state: p.state, createdAt: p.createdAt, ended: !!p.ended };
}

function partyChanged(p, { stateOnly = false } = {}) {
  const info = stateOnly ? { id: p.id, state: p.state } : partyInfo(p);
  const ev = stateOnly ? 'party-state' : 'party';
  for (const id of [p.hostClient, ...p.members]) {
    const c = clients.get(id);
    if (c) send(c.res, ev, info);
  }
}

export function createParty(req, res) {
  const c = clients.get(String(req.body?.device || ''));
  if (!c || c.userId !== req.user.id) return res.status(400).json({ error: 'This device is not connected yet. Try again in a moment.' });
  for (const p of parties.values()) if (p.hostClient === c.id) return res.json(partyInfo(p));
  const id = crypto.randomBytes(5).toString('base64url');
  const p = { id, hostUserId: req.user.id, hostName: req.user.username, hostClient: c.id, members: new Set(), state: c.state, createdAt: Date.now() };
  parties.set(id, p);
  log.info(`[party] ${req.user.username} started a listening party`);
  partyChanged(p);
  res.json(partyInfo(p));
}

export function getParty(req, res) {
  const p = parties.get(String(req.params.id));
  if (!p) return res.status(404).json({ error: 'This listening party has ended' });
  res.json(partyInfo(p));
}

export function joinParty(req, res) {
  const p = parties.get(String(req.params.id));
  if (!p) return res.status(404).json({ error: 'This listening party has ended' });
  const c = clients.get(String(req.body?.device || ''));
  if (!c || c.userId !== req.user.id) return res.status(400).json({ error: 'This device is not connected yet. Try again in a moment.' });
  if (c.id === p.hostClient) return res.status(400).json({ error: "You're the host of this party" });
  for (const o of parties.values()) if (o.members.delete(c.id)) partyChanged(o);
  p.members.add(c.id);
  partyChanged(p);
  res.json(partyInfo(p));
}

export function leaveParty(req, res) {
  const p = parties.get(String(req.params.id));
  if (!p) return res.json({ ok: true });
  const id = String(req.body?.device || '');
  const c = clients.get(id);
  if (c && c.userId !== req.user.id) return res.status(403).json({ error: 'Not your device' });
  if (p.hostClient === id || (p.hostUserId === req.user.id && req.body?.end)) {
    p.ended = true;
    partyChanged(p);
    parties.delete(p.id);
    log.info(`[party] ${p.hostName}'s listening party ended`);
  } else if (p.members.delete(id)) partyChanged(p);
  res.json({ ok: true });
}

export const connectStats = () => ({ clients: clients.size, serverDevices: serverDevices.size, parties: parties.size });

// End parties whose host has been gone for a while.
setInterval(() => {
  for (const p of parties.values()) {
    if (clients.has(p.hostClient)) { p.goneSince = 0; continue; }
    p.goneSince ||= Date.now();
    if (Date.now() - p.goneSince > 5 * 60000) {
      p.ended = true;
      partyChanged(p);
      parties.delete(p.id);
    }
  }
}, 30000).unref();

// ───────── Server-side players (jukebox, DLNA) ─────────

const TRACK_INFO = `SELECT id, title, artist, artist_id AS artistId, album, album_id AS albumId, cover, duration,
  path, cue_file, cue_start, cue_end, needs_transcode, codec, mtime, size, bitrate, lossless, sample_rate, album_artist, track_no, disc_no
  FROM tracks WHERE id = ?`;

export const trackRow = (id) => q(TRACK_INFO).get(Number(id) || 0);
const publicTrack = (t) => t && {
  id: t.id, title: t.title, artist: t.artist, artistId: t.artistId, album: t.album, albumId: t.albumId,
  cover: t.cover, duration: t.cue_end != null ? t.cue_end - (t.cue_start || 0) : t.duration, artists: [{ id: t.artistId, name: t.artist }],
};

/**
 * A queue that plays on a backend living on the server.
 * backend: { load(track, startSec), pause(), resume(), seek(sec), setVolume(0..1), stop(), onEnded/onTime set by us }
 */
export class ServerPlayer {
  constructor({ id, name, kind, backend }) {
    Object.assign(this, { id, name, kind, backend });
    this.queue = [];
    this.index = 0;
    this.playing = false;
    this.time = 0;
    this.timeAt = Date.now();
    this.volume = 0.8;
    this.track = null;
    this.repeat = 'off';
    backend.onEnded = () => this.#ended();
    backend.onTime = (t) => { this.time = t; this.timeAt = Date.now(); };
    backend.onError = (err) => { log.warn(`[${kind}] ${name}: ${err.message || err}`); this.playing = false; this.changed(); };
  }

  get currentTime() {
    return this.playing ? this.time + (Date.now() - this.timeAt) / 1000 : this.time;
  }

  state() {
    const t = publicTrack(this.track);
    return {
      playing: this.playing, time: Math.min(this.currentTime, t?.duration || Infinity), duration: t?.duration || 0, volume: this.volume,
      track: t, index: this.index, queueLength: this.queue.length, repeat: this.repeat, shuffle: false, at: Date.now(),
    };
  }

  changed() { serverDeviceChanged(this); }

  async #load(startSec = 0) {
    const id = this.queue[this.index];
    this.track = id ? trackRow(id) : null;
    if (!this.track) { this.playing = false; this.changed(); return; }
    this.time = startSec;
    this.timeAt = Date.now();
    await this.backend.load(this.track, startSec, this.volume);
    this.playing = true;
    this.changed();
  }

  async #ended() {
    if (this.repeat === 'one') return this.#load(0);
    if (this.index < this.queue.length - 1) { this.index++; return this.#load(0); }
    if (this.repeat === 'all' && this.queue.length) { this.index = 0; return this.#load(0); }
    this.playing = false;
    this.time = 0;
    this.changed();
  }

  async command(cmd, args) {
    switch (cmd) {
      case 'playTracks': {
        const ids = Array.isArray(args.ids) ? args.ids.map(Number).filter(Boolean).slice(0, 5000) : [];
        if (!ids.length) throw Object.assign(new Error('Nothing to play'), { status: 400 });
        this.queue = ids;
        this.index = Math.min(Math.max(0, Number(args.index) || 0), ids.length - 1);
        if (['off', 'all', 'one'].includes(args.repeat)) this.repeat = args.repeat;
        return this.#load(Math.max(0, Number(args.time) || 0));
      }
      case 'play':
      case 'toggle':
        if (cmd === 'toggle' && this.playing) return this.command('pause');
        if (!this.track) return this.queue.length ? this.#load(0) : undefined;
        await this.backend.resume();
        this.playing = true;
        this.timeAt = Date.now();
        return this.changed();
      case 'pause':
        if (!this.playing) return;
        this.time = this.currentTime;
        this.playing = false;
        await this.backend.pause();
        return this.changed();
      case 'stop':
        this.playing = false;
        this.time = 0;
        await this.backend.stop();
        return this.changed();
      case 'next':
        if (!this.queue.length) return;
        this.index = (this.index + 1) % this.queue.length;
        return this.#load(0);
      case 'prev':
        if (this.currentTime > 3 || this.index === 0) return this.command('seek', { time: 0 });
        this.index--;
        return this.#load(0);
      case 'jump':
        if (args.index >= 0 && args.index < this.queue.length) { this.index = Number(args.index); return this.#load(0); }
        return;
      case 'seek': {
        const t = Math.max(0, Number(args.time) || 0);
        this.time = t;
        this.timeAt = Date.now();
        await this.backend.seek(t);
        return this.changed();
      }
      case 'volume':
        this.volume = Math.min(1, Math.max(0, Number(args.value) || 0));
        await this.backend.setVolume(this.volume);
        return this.changed();
      case 'repeat':
        if (['off', 'all', 'one'].includes(args.value)) this.repeat = args.value;
        return this.changed();
      default:
        throw Object.assign(new Error(`${this.name} can't do that`), { status: 400 });
    }
  }
}
