// The Inbox: a staging folder (default data/downloads) for yt-dlp downloads,
// video→audio conversions and uploads. Nothing here is in the library until
// an admin files it into a music folder, either into a chosen folder or by the
// organize template.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseFile } from 'music-metadata';
import { downloadsDir } from './config.js';
import { log } from './logger.js';
import { run, requireTool } from './tools.js';
import { AUDIO_EXT, scanFile, withWatchPaused } from './scanner.js';
import { safeName, renderTemplate, assertInLibrary, musicRoots } from './files.js';

export const VIDEO_EXT = new Set(['.mp4', '.mkv', '.webm', '.mov', '.avi', '.flv', '.wmv', '.m4v', '.ts', '.mts', '.3gp', '.mpg', '.mpeg', '.ogv']);
const OTHER_AUDIO_EXT = new Set(['.wma', '.aiff', '.aif', '.ape', '.wv', '.alac', '.ac3', '.mka', '.amr']);
const MAX_JOBS_KEPT = 100;
const CONCURRENCY = 2;

export const inboxDir = () => {
  const d = downloadsDir();
  fs.mkdirSync(d, { recursive: true });
  return d;
};

/** Resolve an Inbox file name safely (no folders, no traversal). */
export function inboxPath(name) {
  const base = path.basename(String(name || ''));
  if (!base || base !== String(name) || base.startsWith('.')) {
    const err = new Error('Invalid file name');
    err.status = 400;
    throw err;
  }
  return path.join(inboxDir(), base);
}

async function uniqueIn(dir, name) {
  const { name: stem, ext } = path.parse(name);
  let candidate = path.join(dir, name), n = 1;
  while (fs.existsSync(candidate)) candidate = path.join(dir, `${stem} (${++n})${ext}`);
  return candidate;
}

const kindOf = (ext) => {
  ext = ext.toLowerCase();
  // .mp4/.webm can be either: callers check for a video stream when it matters.
  if (AUDIO_EXT.has(ext) && !['.mp4', '.webm'].includes(ext)) return 'audio';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (OTHER_AUDIO_EXT.has(ext)) return 'audio-unsupported';
  return 'other';
};

/** List the Inbox with basic tags. */
export async function listInbox() {
  const dir = inboxDir();
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const items = [];
  for (const e of entries) {
    if (!e.isFile() || e.name.startsWith('.') || /\.(part|ytdl|temp)$/i.test(e.name)) continue;
    const full = path.join(dir, e.name);
    const st = await fsp.stat(full);
    const ext = path.extname(e.name);
    const item = { name: e.name, size: st.size, mtime: st.mtimeMs, kind: kindOf(ext), playable: AUDIO_EXT.has(ext.toLowerCase()) };
    if (item.kind !== 'other') {
      try {
        const m = await parseFile(full, { duration: false, skipCovers: true });
        const c = m.common;
        item.tags = { title: c.title || '', artist: c.artist || '', album: c.album || '', albumArtist: c.albumartist || '', year: c.year || '', genre: c.genre?.[0] || '', trackNo: c.track?.no || '' };
        item.duration = m.format.duration || null;
        item.hasVideo = !!m.format.hasVideo || (m.format.trackInfo || []).some((t) => t.type === 'video' || t.video);
        if (item.hasVideo) item.kind = 'video';
        else if (item.kind === 'video') item.kind = 'audio';
      } catch { /* unreadable: list it anyway */ }
    }
    items.push(item);
  }
  return items.sort((a, b) => b.mtime - a.mtime);
}

// ───────── Jobs ─────────

const jobs = new Map(); // id -> job
let running = 0;
const pending = [];

const publicJob = (j) => ({
  id: j.id, kind: j.kind, status: j.status, title: j.title, source: j.source, progress: j.progress,
  speed: j.speed, eta: j.eta, files: j.files, error: j.error, createdAt: j.createdAt, finishedAt: j.finishedAt,
  log: j.log.slice(-40),
});

export const listJobs = () => [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).map(publicJob);

function newJob(kind, source, title, work) {
  const job = {
    id: crypto.randomBytes(6).toString('hex'), kind, source, title, status: 'queued', progress: 0, speed: '', eta: '',
    files: [], error: null, createdAt: Date.now(), finishedAt: null, log: [], abort: new AbortController(), work,
  };
  jobs.set(job.id, job);
  // Keep the list short.
  const old = [...jobs.values()].filter((j) => j.finishedAt).sort((a, b) => a.createdAt - b.createdAt);
  while (jobs.size > MAX_JOBS_KEPT && old.length) jobs.delete(old.shift().id);
  pending.push(job);
  pump();
  return publicJob(job);
}

function pump() {
  while (running < CONCURRENCY && pending.length) {
    const job = pending.shift();
    if (job.status !== 'queued') continue;
    running++;
    job.status = 'running';
    job.work(job)
      .then(() => { if (job.status === 'running') job.status = 'done'; job.progress = 100; })
      .catch((err) => {
        if (job.abort.signal.aborted) job.status = 'cancelled';
        else { job.status = 'error'; job.error = err.message; log.warn(`[inbox] ${job.kind} failed: ${err.message}`); }
      })
      .finally(() => { job.finishedAt = Date.now(); running--; pump(); });
  }
}

export function cancelJob(id) {
  const j = jobs.get(id);
  if (!j) return false;
  if (j.status === 'queued') { j.status = 'cancelled'; j.finishedAt = Date.now(); }
  else if (j.status === 'running') j.abort.abort();
  return true;
}

export function clearFinishedJobs() {
  for (const [id, j] of jobs) if (j.finishedAt) jobs.delete(id);
}

// ───────── yt-dlp ─────────

export const AUDIO_FORMATS = ['best', 'mp3', 'm4a', 'opus', 'flac', 'wav'];

/**
 * Queue a yt-dlp download (audio only) into the Inbox.
 * opts: { format, playlist, embedThumbnail }
 */
export async function queueDownload(url, opts = {}) {
  let u;
  try { u = new URL(String(url).trim()); } catch { u = null; }
  if (!u || !['http:', 'https:'].includes(u.protocol)) {
    const err = new Error('Enter a valid http(s) link');
    err.status = 400;
    throw err;
  }
  const ytdlp = await requireTool('ytdlp');
  const ffmpeg = await requireTool('ffmpeg');
  const format = AUDIO_FORMATS.includes(opts.format) ? opts.format : 'best';
  return newJob('download', u.href, u.href, async (job) => {
    const dir = inboxDir();
    const args = [
      u.href,
      '--extract-audio', '--audio-format', format, '--audio-quality', '0',
      '--ffmpeg-location', path.dirname(ffmpeg),
      opts.playlist ? '--yes-playlist' : '--no-playlist',
      '--embed-metadata',
      // Fill in artist/album from the uploader/playlist when the site has no music metadata.
      '--parse-metadata', '%(artist,creator,uploader|)s:%(meta_artist)s',
      '--parse-metadata', '%(track,title|)s:%(meta_title)s',
      '--parse-metadata', '%(album,playlist_title|)s:%(meta_album)s',
      '--windows-filenames', '--no-overwrites', '--no-mtime', '--newline', '--no-colors',
      '--progress-template', 'download:SONARA-PROGRESS %(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
      '--print', 'before_dl:SONARA-TITLE %(title)s',
      '--print', 'after_move:SONARA-FILE %(filepath)s',
      '-o', path.join(dir, '%(artist,creator,uploader|Unknown)s - %(track,title)s.%(ext)s'),
    ];
    if (opts.embedThumbnail !== false && format !== 'wav') args.push('--embed-thumbnail', '--convert-thumbnails', 'jpg');
    const r = await run(ytdlp, args, {
      signal: job.abort.signal,
      cwd: dir,
      onLine: (line) => {
        let m;
        if ((m = line.match(/^SONARA-PROGRESS\s+([\d.]+)%\|([^|]*)\|(.*)$/))) {
          job.progress = Math.min(99, Number(m[1]) || 0);
          job.speed = m[2].trim();
          job.eta = m[3].trim();
        } else if ((m = line.match(/^SONARA-TITLE (.+)$/))) {
          job.title = m[1];
        } else if ((m = line.match(/^SONARA-FILE (.+)$/))) {
          job.files.push(path.basename(m[1]));
        } else {
          job.log.push(line);
          if (job.log.length > 200) job.log.splice(0, 100);
        }
      },
    });
    if (r.code !== 0) {
      const errLine = job.log.filter((l) => /ERROR/.test(l)).pop() || r.stderr.trim().split('\n').pop();
      throw new Error(errLine?.replace(/^ERROR:\s*/, '') || `yt-dlp exited with code ${r.code}`);
    }
    if (!job.files.length) job.log.push('Nothing new was downloaded (the file may already be in the Inbox).');
  });
}

// ───────── Video → audio ─────────

export const CONVERT_FORMATS = {
  mp3: { ext: '.mp3', args: (q) => ['-c:a', 'libmp3lame', '-b:a', `${q || 320}k`] },
  m4a: { ext: '.m4a', args: (q) => ['-c:a', 'aac', '-b:a', `${q || 256}k`, '-movflags', '+faststart'] },
  opus: { ext: '.opus', args: (q) => ['-c:a', 'libopus', '-b:a', `${q || 160}k`] },
  ogg: { ext: '.ogg', args: (q) => ['-c:a', 'libvorbis', '-b:a', `${q || 256}k`] },
  flac: { ext: '.flac', args: () => ['-c:a', 'flac'] },
  wav: { ext: '.wav', args: () => ['-c:a', 'pcm_s16le'] },
  copy: { ext: null, args: () => ['-c:a', 'copy'] }, // keep the original audio stream, no quality loss
};
const COPY_EXT = { aac: '.m4a', mp3: '.mp3', opus: '.opus', vorbis: '.ogg', flac: '.flac' };

async function probeAudioCodec(file) {
  try {
    const m = await parseFile(file, { duration: false, skipCovers: true });
    const codec = String(m.format.codec || '').toLowerCase();
    return { codec, duration: m.format.duration || 0 };
  } catch { return { codec: '', duration: 0 }; }
}

/**
 * Queue a conversion. `source` is an absolute path (validated by the caller).
 * opts: { format, bitrate, deleteSource, cover }
 */
export async function queueConvert(source, opts = {}) {
  const ffmpeg = await requireTool('ffmpeg');
  const fmt = CONVERT_FORMATS[opts.format] ? opts.format : 'mp3';
  const bitrate = [96, 128, 160, 192, 256, 320].includes(Number(opts.bitrate)) ? Number(opts.bitrate) : null;
  return newJob('convert', source, path.basename(source), async (job) => {
    const { codec, duration } = await probeAudioCodec(source);
    let ext = CONVERT_FORMATS[fmt].ext;
    if (fmt === 'copy') {
      const key = Object.keys(COPY_EXT).find((k) => codec.includes(k));
      if (!key) throw new Error(`Can't keep the original audio (${codec || 'unknown codec'}) as-is. Pick a format to convert to.`);
      ext = COPY_EXT[key];
    }
    const out = await uniqueIn(inboxDir(), safeName(path.parse(source).name) + ext);
    const tmp = path.join(path.dirname(out), `.${path.basename(out)}.part${ext}`);
    // A frame of the video becomes the cover art for formats that support it.
    const withCover = opts.cover !== false && ['.mp3', '.m4a', '.flac'].includes(ext);
    const args = ['-hide_banner', '-nostats', '-y', '-i', source, '-map', '0:a:0', '-map_metadata', '0'];
    if (withCover) args.push('-map', '0:v:0?', '-c:v', 'mjpeg', '-vf', 'scale=600:600:force_original_aspect_ratio=decrease', '-frames:v', '1', '-disposition:v', 'attached_pic');
    else args.push('-vn');
    args.push(...CONVERT_FORMATS[fmt].args(bitrate));
    if (ext === '.mp3') args.push('-id3v2_version', '3');
    args.push('-progress', 'pipe:1', tmp);
    let total = duration;
    const r = await run(ffmpeg, args, {
      signal: job.abort.signal,
      onLine: (line, which) => {
        let m;
        if (!total && (m = line.match(/Duration: (\d+):(\d+):([\d.]+)/))) total = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
        if (which === 'out' && (m = line.match(/^out_time_us=(\d+)/)) && total) job.progress = Math.min(99, (Number(m[1]) / 1e6 / total) * 100);
        if (which === 'err') { job.log.push(line); if (job.log.length > 200) job.log.splice(0, 100); }
      },
    });
    if (r.code !== 0) {
      await fsp.unlink(tmp).catch(() => {});
      if (withCover && /attached_pic|mjpeg|Stream map/i.test(r.stderr)) {
        // Some sources have odd video streams: retry without cover art.
        return queueConvert(source, { ...opts, cover: false }).then(() => { job.status = 'done'; job.log.push('Retried without cover art.'); });
      }
      throw new Error(r.stderr.trim().split('\n').filter((l) => !/^\s/.test(l)).pop() || `ffmpeg exited with code ${r.code}`);
    }
    await fsp.rename(tmp, out);
    job.files.push(path.basename(out));
    if (opts.deleteSource && path.dirname(source) === inboxDir()) await fsp.unlink(source).catch(() => {});
  });
}

/** Save an uploaded stream into the Inbox. */
export async function saveUpload(name, stream, maxBytes) {
  const out = await uniqueIn(inboxDir(), safeName(path.basename(String(name || 'upload')), 'upload'));
  const tmp = path.join(path.dirname(out), `.${path.basename(out)}.upload`);
  let size = 0;
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(tmp, { flags: 'wx' });
    stream.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) { stream.destroy(); ws.destroy(); reject(Object.assign(new Error('File is too large'), { status: 413 })); }
    });
    stream.on('error', reject);
    ws.on('error', reject);
    ws.on('finish', resolve);
    stream.pipe(ws);
  }).catch(async (err) => { await fsp.unlink(tmp).catch(() => {}); throw err; });
  await fsp.rename(tmp, out);
  return path.basename(out);
}

// ───────── Filing into the library ─────────

/**
 * Move Inbox files into the library.
 * dest: { dir } (a folder inside a music folder) or { template, root } (organize by tags).
 * Returns { imported: [{ name, path, trackId }], failed }.
 */
export async function importToLibrary(names, dest) {
  const roots = musicRoots();
  if (!roots.length) throw Object.assign(new Error('Add a music folder in Settings first.'), { status: 400 });
  if (dest.dir) assertInLibrary(dest.dir);
  if (dest.root) assertInLibrary(dest.root);
  const imported = [], failed = [];
  await withWatchPaused(async () => {
    for (const name of names) {
      try {
        const from = inboxPath(name);
        const ext = path.extname(from).toLowerCase();
        if (!AUDIO_EXT.has(ext)) throw new Error('Only playable audio files can be added. Convert it first.');
        let to;
        if (dest.dir) to = path.join(path.resolve(dest.dir), path.basename(from));
        else {
          const m = await parseFile(from, { duration: false, skipCovers: true });
          const c = m.common;
          const row = {
            path: from, title: c.title || path.parse(from).name, artist: c.artist || '', album: c.album || '',
            album_artist: c.albumartist || '', track_no: c.track?.no, disc_no: c.disk?.no, year: c.year, genre: c.genre?.[0],
          };
          to = path.join(path.resolve(dest.root || roots[0]), renderTemplate(dest.template, row, { discCount: c.disk?.of || 1 }) + ext);
        }
        to = await uniqueIn(path.dirname(to), path.basename(to));
        await fsp.mkdir(path.dirname(to), { recursive: true });
        try { await fsp.rename(from, to); } catch (err) {
          if (err.code !== 'EXDEV') throw err;
          await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL);
          await fsp.unlink(from);
        }
        const trackId = await scanFile(to);
        imported.push({ name, path: to, trackId });
      } catch (err) {
        failed.push({ name, error: err.message });
      }
    }
  });
  return { imported, failed };
}
