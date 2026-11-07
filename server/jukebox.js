// Jukebox mode: play through the speakers attached to the Sonara server.
// Uses mpv (full control over its JSON IPC) when installed, otherwise ffplay
// (from ffmpeg), which is restarted to seek or change volume.

import { spawn, execFile } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { getConfig } from './config.js';
import { log } from './logger.js';
import { ServerPlayer, registerServerDevice, removeServerDevice } from './connect.js';

const ID = 'jukebox';
let device = null;

// mpv takes --version, ffplay only -version.
const exists = (bin, flag = '--version') => new Promise((resolve) => {
  execFile(bin, [flag], { timeout: 5000 }, (err) => resolve(!err));
});

/** Where a track's audio starts and ends inside its file (cue sheets). */
const span = (t) => ({ file: t.cue_file || t.path, start: t.cue_start || 0, end: t.cue_end ?? null });

// ───────── mpv ─────────

class MpvBackend {
  constructor(bin) {
    this.bin = bin;
    this.sock = process.platform === 'win32' ? `\\\\.\\pipe\\sonara-mpv-${process.pid}` : path.join(os.tmpdir(), `sonara-mpv-${process.pid}.sock`);
    this.proc = null;
    this.conn = null;
    this.reqId = 0;
    this.offset = 0;
    this.loading = false;
  }

  async #ensure() {
    if (this.conn && !this.conn.destroyed) return;
    if (!this.proc || this.proc.exitCode != null) {
      if (process.platform !== 'win32') fs.rmSync(this.sock, { force: true });
      this.proc = spawn(this.bin, ['--no-video', '--idle=yes', '--no-terminal', '--audio-display=no', `--input-ipc-server=${this.sock}`], { stdio: 'ignore' });
      this.proc.on('error', (err) => this.onError?.(err));
      this.proc.on('exit', () => { this.conn = null; });
    }
    for (let i = 0; i < 50; i++) {
      try {
        this.conn = await new Promise((resolve, reject) => {
          const c = net.connect(this.sock, () => resolve(c));
          c.once('error', reject);
        });
        break;
      } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    if (!this.conn) throw new Error('Could not start mpv');
    let buf = '';
    this.conn.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try { this.#event(JSON.parse(line)); } catch { /* ignore */ }
      }
    });
    this.conn.on('error', () => {});
    this.#cmd(['observe_property', 1, 'time-pos']);
  }

  #event(m) {
    if (m.event === 'property-change' && m.name === 'time-pos' && typeof m.data === 'number') this.onTime?.(Math.max(0, m.data - this.offset));
    if (m.event === 'end-file' && m.reason === 'eof' && !this.loading) this.onEnded?.();
    if (m.event === 'end-file' && m.reason === 'error') this.onError?.(new Error('mpv could not play the file'));
    if (m.event === 'file-loaded') this.loading = false;
  }

  #cmd(command) {
    this.conn?.write(JSON.stringify({ command, request_id: ++this.reqId }) + '\n');
  }

  async load(t, startSec, volume) {
    await this.#ensure();
    const s = span(t);
    this.offset = s.start;
    this.loading = true;
    this.#cmd(['set_property', 'volume', Math.round(volume * 100)]);
    this.#cmd(['set_property', 'start', String(s.start + startSec)]);
    this.#cmd(['set_property', 'end', s.end != null ? String(s.end) : 'none']);
    this.#cmd(['set_property', 'pause', false]);
    this.#cmd(['loadfile', s.file, 'replace']);
  }
  async pause() { this.#cmd(['set_property', 'pause', true]); }
  async resume() { this.#cmd(['set_property', 'pause', false]); }
  async seek(sec) { this.#cmd(['seek', this.offset + sec, 'absolute']); }
  async setVolume(v) { this.#cmd(['set_property', 'volume', Math.round(v * 100)]); }
  async stop() { this.#cmd(['stop']); }
  shutdown() { try { this.proc?.kill(); } catch { /* ignore */ } }
}

// ───────── ffplay ─────────

class FfplayBackend {
  constructor(bin) {
    this.bin = bin;
    this.proc = null;
    this.track = null;
    this.pos = 0;       // position when the current process started
    this.startedAt = 0;
    this.paused = false;
    this.pausedAt = 0;
    this.volume = 0.8;
    this.timer = setInterval(() => {
      if (this.proc && !this.paused) this.onTime?.(this.pos + (Date.now() - this.startedAt) / 1000);
    }, 1000);
    this.timer.unref();
  }

  #kill() {
    const p = this.proc;
    this.proc = null;
    if (p) { try { if (this.paused && process.platform !== 'win32') p.kill('SIGCONT'); p.kill(); } catch { /* ignore */ } }
  }

  #spawn(startSec) {
    this.#kill();
    const s = span(this.track);
    const args = ['-nodisp', '-autoexit', '-loglevel', 'error', '-volume', String(Math.round(this.volume * 100)), '-ss', String(s.start + startSec)];
    if (s.end != null) args.push('-t', String(Math.max(0, s.end - s.start - startSec)));
    args.push(s.file);
    const p = spawn(this.bin, args, { stdio: 'ignore' });
    this.proc = p;
    this.pos = startSec;
    this.startedAt = Date.now();
    this.paused = false;
    p.on('error', (err) => this.onError?.(err));
    p.on('exit', (code) => { if (this.proc === p) { this.proc = null; if (code === 0) this.onEnded?.(); } });
  }

  get time() { return this.paused ? this.pos + (this.pausedAt - this.startedAt) / 1000 : this.pos + (Date.now() - this.startedAt) / 1000; }

  async load(t, startSec, volume) { this.track = t; this.volume = volume; this.#spawn(startSec); }
  async pause() {
    if (!this.proc || this.paused) return;
    if (process.platform === 'win32') { const at = this.time; this.#kill(); this.pos = at; this.paused = true; this.startedAt = this.pausedAt = Date.now(); return; }
    this.proc.kill('SIGSTOP');
    this.paused = true;
    this.pausedAt = Date.now();
  }
  async resume() {
    if (!this.track) return;
    if (!this.proc) return this.#spawn(this.pos);
    if (!this.paused) return;
    this.proc.kill('SIGCONT');
    this.startedAt += Date.now() - this.pausedAt;
    this.paused = false;
  }
  async seek(sec) { if (this.track) { const wasPaused = this.paused; this.#spawn(sec); if (wasPaused) await this.pause(); } }
  async setVolume(v) {
    this.volume = v;
    if (this.proc && !this.paused) this.#spawn(this.time);
  }
  async stop() { this.#kill(); this.paused = false; }
  shutdown() { this.#kill(); clearInterval(this.timer); }
}

/** Start or stop the jukebox device to match the config. */
export async function setupJukebox() {
  const c = getConfig();
  if (!c.jukebox) {
    if (device) { device.backend.shutdown(); removeServerDevice(ID); device = null; log.info('[jukebox] Off'); }
    return null;
  }
  if (device) return device;
  const mpv = c.mpvPath || 'mpv';
  let backend = null;
  if (await exists(mpv)) backend = new MpvBackend(mpv);
  else {
    const ffplay = c.ffmpegPath ? path.join(path.dirname(c.ffmpegPath), process.platform === 'win32' ? 'ffplay.exe' : 'ffplay') : 'ffplay';
    if (await exists(ffplay, '-version')) backend = new FfplayBackend(ffplay);
  }
  if (!backend) {
    log.warn('[jukebox] Turned on, but neither mpv nor ffplay was found. Install mpv to play through the server speakers.');
    return null;
  }
  device = new ServerPlayer({ id: ID, name: `Server speakers (${os.hostname()})`, kind: 'jukebox', backend });
  registerServerDevice(device);
  log.info(`[jukebox] Ready, using ${backend instanceof MpvBackend ? 'mpv' : 'ffplay'}`);
  return device;
}

export const jukeboxStatus = () => ({ enabled: !!getConfig().jukebox, ready: !!device, player: device ? (device.backend instanceof MpvBackend ? 'mpv' : 'ffplay') : null });

process.on('exit', () => device?.backend.shutdown());
