// Multi-room playback through Snapcast (https://github.com/badaix/snapcast).
//
// Sonara decodes the queue with ffmpeg in real time (-re) and streams raw PCM
// (48 kHz, 16-bit, stereo: Snapcast's default) into a TCP source on the Snapcast
// server, which plays it in sync on every room's snapclient. Configure the
// source in snapserver.conf:
//
//   [stream]
//   source = tcp://0.0.0.0:4953?name=Sonara&mode=server
//
// and set snapcast / snapcastHost / snapcastPort in Settings → Sharing & speakers.
// Rooms and their volumes are listed through Snapcast's JSON-RPC control port.

import { spawn } from 'node:child_process';
import net from 'node:net';
import { getConfig } from './config.js';
import { tools } from './tools.js';
import { log } from './logger.js';
import { ServerPlayer, registerServerDevice, removeServerDevice } from './connect.js';

const ID = 'snapcast';
let device = null;

const span = (t) => ({ file: t.cue_file || t.path, start: t.cue_start || 0, end: t.cue_end ?? null });

class SnapcastBackend {
  constructor(ffmpeg) {
    this.ffmpeg = ffmpeg;
    this.proc = null;
    this.sock = null;
    this.track = null;
    this.pos = 0;
    this.startedAt = 0;
    this.paused = false;
    this.volume = 0.8;
    this.timer = setInterval(() => { if (this.proc && !this.paused) this.onTime?.(this.time); }, 1000);
    this.timer.unref();
  }

  get time() { return this.pos + (this.paused || !this.proc ? 0 : (Date.now() - this.startedAt) / 1000); }

  async #socket() {
    if (this.sock && !this.sock.destroyed) return this.sock;
    const c = getConfig();
    this.sock = await new Promise((resolve, reject) => {
      const s = net.connect({ host: c.snapcastHost || '127.0.0.1', port: Number(c.snapcastPort) || 4953 }, () => resolve(s));
      s.setTimeout(8000, () => s.destroy(new Error('timed out')));
      s.once('error', (err) => reject(new Error(`Can't reach the Snapcast server (${err.code || err.message}). Check the TCP source in snapserver.conf.`)));
    });
    this.sock.setTimeout(0);
    this.sock.on('error', (err) => { log.warn('[snapcast]', err.message); });
    this.sock.on('close', () => { this.sock = null; });
    return this.sock;
  }

  #kill() {
    const p = this.proc;
    this.proc = null;
    if (p) { p.removeAllListeners('close'); p.stdout.unpipe(); p.kill('SIGKILL'); }
  }

  async #spawn(from) {
    this.#kill();
    const sock = await this.#socket();
    const s = span(this.track);
    const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-re', '-ss', String(s.start + from)];
    if (s.end != null) args.push('-to', String(s.end));
    args.push('-i', s.file, '-vn', '-af', `volume=${this.volume.toFixed(3)}`, '-f', 's16le', '-ar', '48000', '-ac', '2', '-');
    const p = spawn(this.ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = p;
    this.pos = from;
    this.startedAt = Date.now();
    this.paused = false;
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.stdout.pipe(sock, { end: false });
    p.on('error', (e) => this.onError?.(e));
    p.on('close', (code) => {
      if (this.proc !== p) return;
      this.proc = null;
      if (code === 0) this.onEnded?.();
      else this.onError?.(new Error(err.trim().split('\n').pop() || `ffmpeg exited with ${code}`));
    });
  }

  async load(t, startSec, volume) { this.track = t; this.volume = volume; await this.#spawn(startSec); }
  async pause() { if (!this.proc) return; this.pos = this.time; this.#kill(); this.paused = true; }
  async resume() { if (this.track && (this.paused || !this.proc)) await this.#spawn(this.pos); }
  async seek(sec) { if (!this.track) return; const wasPaused = this.paused; if (wasPaused) { this.pos = sec; return; } await this.#spawn(sec); }
  async setVolume(v) { this.volume = v; if (this.proc && !this.paused) await this.#spawn(this.time); }
  async stop() { this.#kill(); this.paused = false; this.pos = 0; }
  shutdown() { this.#kill(); clearInterval(this.timer); this.sock?.destroy(); }
}

/** Rooms known to the Snapcast server (JSON-RPC over TCP, port 1705). */
export function snapcastRooms() {
  const c = getConfig();
  return new Promise((resolve) => {
    const s = net.connect({ host: c.snapcastHost || '127.0.0.1', port: Number(c.snapcastControlPort) || 1705 });
    let buf = '';
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(4000, () => done(null));
    s.on('error', () => done(null));
    s.on('connect', () => s.write(`${JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'Server.GetStatus' })}\r\n`));
    s.on('data', (d) => {
      buf += d;
      const line = buf.split('\n').find((l) => l.includes('"id":1'));
      if (!line) return;
      try {
        const groups = JSON.parse(line).result?.server?.groups || [];
        done(groups.flatMap((g) => g.clients.map((cl) => ({ name: cl.config?.name || cl.host?.name, connected: !!cl.connected, volume: cl.config?.volume?.percent, stream: g.stream_id }))));
      } catch { done(null); }
    });
  });
}

/** Start or stop the Snapcast device to match the config. */
export async function setupSnapcast({ restart = false } = {}) {
  const c = getConfig();
  if ((!c.snapcast || restart) && device) { device.backend.shutdown(); removeServerDevice(ID); device = null; }
  if (!c.snapcast) return null;
  if (device) return device;
  const ff = (await tools()).ffmpeg;
  if (!ff) { log.warn('[snapcast] Turned on, but ffmpeg was not found. Install ffmpeg to stream to Snapcast.'); return null; }
  device = new ServerPlayer({ id: ID, name: 'All rooms (Snapcast)', kind: 'snapcast', backend: new SnapcastBackend(ff.path) });
  registerServerDevice(device);
  log.info(`[snapcast] Ready: streaming to ${c.snapcastHost || '127.0.0.1'}:${c.snapcastPort || 4953}`);
  return device;
}

export const snapcastStatus = () => ({ enabled: !!getConfig().snapcast, ready: !!device });
process.on('exit', () => device?.backend.shutdown());
