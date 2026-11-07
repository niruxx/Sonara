// Runs in a worker thread: decodes one file with ffmpeg and analyses it, so the
// number crunching never blocks the web server.
import { parentPort } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { Analyzer, ANALYSIS_RATE } from '../public/js/analysis-core.js';

parentPort.on('message', ({ id, ffmpeg, file, start, end }) => {
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error'];
  if (start) args.push('-ss', String(start));
  if (end != null) args.push('-to', String(end));
  args.push('-i', file, '-vn', '-ac', '2', '-ar', String(ANALYSIS_RATE), '-f', 'f32le', '-');
  const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  // Analysis is background work: let playback and transcoding go first.
  try { os.setPriority(child.pid, 15); } catch { /* not allowed here */ }
  const an = new Analyzer({ sampleRate: ANALYSIS_RATE, channels: 2 });
  let rest = Buffer.alloc(0);
  let err = '';
  child.stdout.on('data', (chunk) => {
    const buf = rest.length ? Buffer.concat([rest, chunk]) : chunk;
    const usable = buf.length - (buf.length % 8);
    // Copy into an aligned Float32Array (chunk offsets aren't always multiples of 4).
    const f = new Float32Array(usable / 4);
    new Uint8Array(f.buffer).set(buf.subarray(0, usable));
    an.push(f);
    rest = buf.subarray(usable);
  });
  child.stderr.on('data', (d) => { err += d; if (err.length > 4000) err = err.slice(-4000); });
  child.on('error', (e) => parentPort.postMessage({ id, error: e.message }));
  child.on('close', (code) => {
    if (code !== 0 && !an.samples) return parentPort.postMessage({ id, error: err.trim().split('\n').pop() || `ffmpeg exited with ${code}` });
    try { parentPort.postMessage({ id, result: an.finish() }); } catch (e) { parentPort.postMessage({ id, error: e.message }); }
  });
});
