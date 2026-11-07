// On-the-fly transcoding with ffmpeg, backed by a size-limited disk cache.
//
// The first request for a (track, format, bitrate) starts ffmpeg writing into
// the cache and streams the file to the browser while it grows, so playback
// starts right away. Seeking needs byte ranges, which are served as soon as
// the cached file is complete (requests for a range further in wait for it).
// Later plays are served straight from the cache like any other file.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, getConfig } from './config.js';
import { log } from './logger.js';
import { run, requireTool } from './tools.js';

export const CACHE_DIR = path.join(DATA_DIR, 'transcode-cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });

export const FORMATS = {
  opus: { ext: '.opus', mime: 'audio/ogg; codecs=opus', args: (br) => ['-c:a', 'libopus', '-b:a', `${br}k`, '-vbr', 'on', '-ac', '2', '-f', 'ogg'] },
  mp3: { ext: '.mp3', mime: 'audio/mpeg', args: (br) => ['-c:a', 'libmp3lame', '-b:a', `${br}k`, '-ac', '2', '-f', 'mp3'] },
  aac: { ext: '.aac', mime: 'audio/aac', args: (br) => ['-c:a', 'aac', '-b:a', `${br}k`, '-ac', '2', '-f', 'adts'] },
  flac: { ext: '.flac', mime: 'audio/flac', args: () => ['-c:a', 'flac', '-compression_level', '5', '-f', 'flac'] },
};
export const BITRATES = [64, 96, 128, 160, 192, 256, 320];
const MAX_BITRATE = { opus: 256, mp3: 320, aac: 320 };

/**
 * Decide how a track should be delivered.
 * opts: { format: 'auto'|'opus'|'mp3'|'aac'|'flac'|'raw', bitrate (kbps, 0 = original), userMax (kbps, 0 = none),
 *         prefer: lossy codec to use when a transcode is needed and no format was forced (default opus) }
 * Returns null to send the file as-is, or { format, bitrate, start, end }.
 */
export function deliveryPlan(track, { format = 'auto', bitrate = 0, userMax = 0, prefer = 'opus' } = {}) {
  if (!['opus', 'mp3', 'aac'].includes(prefer)) prefer = 'opus';
  const caps = [bitrate, userMax].filter((n) => n > 0);
  const limit = caps.length ? Math.min(...caps) : 0;
  const segment = track.cue_file ? { start: track.cue_start || 0, end: track.cue_end ?? null } : { start: 0, end: null };
  const mustTranscode = !!track.needs_transcode || !!track.cue_file;
  const overLimit = limit > 0 && (!track.bitrate || track.bitrate > limit * 1000 * 1.1);
  if (format === 'raw' && !mustTranscode && !userMax) return null;
  if (!mustTranscode && !overLimit && !['opus', 'mp3', 'aac', 'flac'].includes(format)) return null;
  if (!mustTranscode && !overLimit && format !== 'flac') {
    // A specific lossy format was asked for without a bitrate: only re-encode lossless sources.
    if (!track.lossless) return null;
  }
  let fmt = ['opus', 'mp3', 'aac', 'flac'].includes(format) ? format : null;
  // Lossy → FLAC only makes a bigger file; keep the original unless it can't be played.
  if (fmt === 'flac' && !track.lossless && !limit) {
    if (!mustTranscode) return null;
    fmt = prefer;
  }
  if (limit && (overLimit || fmt !== 'flac')) {
    // Lossless can't honor a bitrate cap: fall back to Opus.
    if (!fmt || fmt === 'flac') fmt = prefer;
    return { format: fmt, bitrate: Math.min(limit, MAX_BITRATE[fmt]), ...segment };
  }
  // No limit: lossless sources stay lossless, lossy ones get a high-quality lossy copy.
  if (!fmt) fmt = track.lossless ? 'flac' : prefer;
  return { format: fmt, bitrate: fmt === 'flac' ? 0 : MAX_BITRATE[fmt], ...segment };
}

const sourceOf = (track) => track.cue_file || track.path;

function cacheKey(track, plan) {
  return crypto.createHash('sha1')
    .update([sourceOf(track), track.mtime, track.size, plan.start, plan.end, plan.format, plan.bitrate].join('|'))
    .digest('hex');
}

const jobs = new Map(); // key -> { tmp, out, done, error, promise, listeners:Set }

function ffmpegArgs(track, plan, out) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
  if (plan.start) args.push('-ss', String(plan.start));
  args.push('-i', sourceOf(track));
  if (plan.end != null) args.push('-t', String(Math.max(0.1, plan.end - (plan.start || 0))));
  args.push('-map', '0:a:0', '-vn', '-map_metadata', '-1');
  if (plan.format === 'flac') {
    // DSD and very high sample rates: resample to something every browser decodes.
    if (track.sample_rate > 192000 || /dsd/i.test(track.codec || '')) args.push('-ar', '88200', '-sample_fmt', 's32');
  }
  args.push(...FORMATS[plan.format].args(plan.bitrate), out);
  return args;
}

/** Start (or join) the transcode for this plan. Returns the job. */
async function startJob(track, plan) {
  const key = cacheKey(track, plan);
  const out = path.join(CACHE_DIR, key + FORMATS[plan.format].ext);
  if (fs.existsSync(out)) {
    fsp.utimes(out, new Date(), new Date()).catch(() => {}); // mark as recently used
    return { out, done: true, promise: Promise.resolve(out), listeners: new Set() };
  }
  if (jobs.has(key)) return jobs.get(key);
  const ffmpeg = await requireTool('ffmpeg');
  const tmp = path.join(CACHE_DIR, `${key}.part${FORMATS[plan.format].ext}`);
  const job = { tmp, out, done: false, error: null, listeners: new Set() };
  const notify = () => { for (const fn of job.listeners) fn(); };
  // Wake up readers while ffmpeg writes.
  const ticker = setInterval(notify, 200);
  job.promise = run(ffmpeg, ffmpegArgs(track, plan, tmp)).then(async (r) => {
    if (r.code !== 0) throw new Error(r.stderr.trim().split('\n').pop() || `ffmpeg exited with ${r.code}`);
    await fsp.rename(tmp, out);
    return out;
  }).catch(async (err) => {
    job.error = err;
    await fsp.unlink(tmp).catch(() => {});
    log.warn(`[transcode] ${path.basename(sourceOf(track))}: ${err.message}`);
    throw err;
  }).finally(() => {
    clearInterval(ticker);
    job.done = true;
    jobs.delete(key);
    notify();
    enforceCacheLimit().catch(() => {});
  });
  job.promise.catch(() => {}); // handled by callers
  jobs.set(key, job);
  // Wait until ffmpeg has created the file (or failed).
  await new Promise((resolve) => {
    const check = () => (fs.existsSync(tmp) || job.done ? resolve() : setTimeout(check, 30));
    check();
  });
  return job;
}

/** Transcode fully and return the cached file path (for downloads). */
export async function transcodeToFile(track, plan) {
  const job = await startJob(track, plan);
  return job.promise;
}

/** Stream a file that ffmpeg is still writing. */
async function streamGrowing(job, res, mime) {
  res.status(200);
  res.setHeader('Content-Type', mime);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-store');
  let fd;
  try { fd = await fsp.open(job.tmp, 'r'); } catch {
    // Finished (and renamed) between the check and now.
    if (job.out && fs.existsSync(job.out)) fd = await fsp.open(job.out, 'r');
    else throw job.error || new Error('Transcode failed');
  }
  let closed = false;
  res.on('close', () => { closed = true; });
  const buf = Buffer.alloc(256 * 1024);
  let pos = 0;
  try {
    while (!closed) {
      const { bytesRead } = await fd.read(buf, 0, buf.length, pos);
      if (bytesRead > 0) {
        pos += bytesRead;
        if (!res.write(buf.subarray(0, bytesRead))) await new Promise((r) => res.once('drain', r).once('close', r));
        continue;
      }
      if (job.done) {
        if (job.error) break;
        // Final read after completion, in case the last chunk landed after our read.
        const tail = await fd.read(buf, 0, buf.length, pos);
        if (tail.bytesRead) { pos += tail.bytesRead; res.write(buf.subarray(0, tail.bytesRead)); continue; }
        break;
      }
      await new Promise((r) => { const fn = () => { job.listeners.delete(fn); r(); }; job.listeners.add(fn); });
    }
  } finally {
    await fd.close().catch(() => {});
    res.end();
  }
}

/**
 * Serve a transcoded stream. `wait` forces waiting for the complete file
 * (the player uses it to seek on a stream that is still being transcoded).
 */
export async function serveTranscoded(req, res, track, plan, { wait = false } = {}) {
  const mime = FORMATS[plan.format].mime;
  // The same source, segment, format and bitrate always give the same bytes, so the cache key
  // makes a strong ETag, identical whether the file is still being written or finished.
  // Apps that keep offline copies can revalidate them cheaply.
  const etag = `"${cacheKey(track, plan)}"`;
  res.setHeader('ETag', etag);
  const inm = String(req.headers['if-none-match'] || '');
  if (inm && inm.split(/\s*,\s*/).some((t) => t === etag || t === `W/${etag}` || t === '*')) return res.status(304).end();
  const job = await startJob(track, plan);
  const range = req.headers.range;
  const fromStart = !range || /^bytes=0-$/.test(range.trim());
  if (!job.done && fromStart && !wait) return streamGrowing(job, res, mime);
  const file = await Promise.race([
    job.promise,
    new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('Transcoding is taking too long'), { status: 504 })), 180000)),
  ]);
  res.sendFile(file, { headers: { 'Content-Type': mime }, acceptRanges: true, dotfiles: 'allow', etag: false }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'Transcoded file unavailable' });
  });
}

// ───────── Cache management ─────────

export async function cacheStats() {
  let size = 0, files = 0;
  for (const f of await fsp.readdir(CACHE_DIR).catch(() => [])) {
    if (f.includes('.part')) continue;
    try { size += (await fsp.stat(path.join(CACHE_DIR, f))).size; files++; } catch { /* gone */ }
  }
  return { size, files, limitMB: cacheLimitMB(), dir: CACHE_DIR };
}

export const cacheLimitMB = () => Math.max(0, Number(getConfig().transcodeCacheMB ?? 2048));

/** Delete least-recently-used cache files until under the limit. */
export async function enforceCacheLimit() {
  const limit = cacheLimitMB() * 1024 * 1024;
  const entries = [];
  for (const f of await fsp.readdir(CACHE_DIR).catch(() => [])) {
    if (f.includes('.part')) continue;
    try {
      const st = await fsp.stat(path.join(CACHE_DIR, f));
      entries.push({ f, size: st.size, used: st.mtimeMs });
    } catch { /* gone */ }
  }
  let total = entries.reduce((a, e) => a + e.size, 0);
  entries.sort((a, b) => a.used - b.used);
  for (const e of entries) {
    if (total <= limit) break;
    await fsp.unlink(path.join(CACHE_DIR, e.f)).catch(() => {});
    total -= e.size;
  }
}

export async function clearCache() {
  for (const f of await fsp.readdir(CACHE_DIR).catch(() => [])) {
    if (f.includes('.part')) continue; // in use
    await fsp.unlink(path.join(CACHE_DIR, f)).catch(() => {});
  }
}

// Leftovers from a crash or restart.
for (const f of fs.readdirSync(CACHE_DIR)) if (f.includes('.part')) fs.rmSync(path.join(CACHE_DIR, f), { force: true });
