// External tools (all optional): ffmpeg / ffprobe for tag writing and
// conversion, yt-dlp for downloads. They are looked up at runtime; features that
// need a missing tool are disabled in the UI with a hint on how to install it.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from './config.js';

const EXE = process.platform === 'win32' ? '.exe' : '';

/** Find an executable: explicit config path first, then every PATH entry. */
function which(name, configured) {
  if (configured) return fs.existsSync(configured) ? configured : null;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of EXE ? [EXE, '.cmd', ''] : ['']) {
      const p = path.join(dir, name + ext);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch { /* not here */ }
    }
  }
  return null;
}

/**
 * Run a command (no shell, so arguments are never interpreted).
 * onLine receives stdout/stderr lines as they arrive. Resolves { code, stdout, stderr }.
 */
export function run(cmd, args, { onLine, signal, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const feed = (which) => {
      let buf = '';
      return (chunk) => {
        const s = chunk.toString();
        if (which === 'out') stdout += s; else stderr += s;
        if (stdout.length > 2e6) stdout = stdout.slice(-1e6);
        if (stderr.length > 2e6) stderr = stderr.slice(-1e6);
        if (!onLine) return;
        buf += s;
        const lines = buf.split(/\r?\n|\r/);
        buf = lines.pop();
        for (const l of lines) if (l.trim()) onLine(l, which);
      };
    };
    child.stdout.on('data', feed('out'));
    child.stderr.on('data', feed('err'));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    signal?.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
  });
}

const cache = { at: 0, value: null };

/** Locate the tools and their versions (cached for a minute). */
export async function tools(force = false) {
  if (!force && cache.value && Date.now() - cache.at < 60000) return cache.value;
  const c = getConfig();
  const found = {
    ffmpeg: which('ffmpeg', c.ffmpegPath),
    ffprobe: which('ffprobe', c.ffprobePath),
    ytdlp: which('yt-dlp', c.ytdlpPath) || which('yt_dlp', null),
  };
  const version = async (bin, args, re) => {
    if (!bin) return null;
    try {
      const r = await run(bin, args);
      return (r.stdout + r.stderr).match(re)?.[1] || 'unknown';
    } catch { return null; }
  };
  const [ffmpegV, ytdlpV] = await Promise.all([
    version(found.ffmpeg, ['-hide_banner', '-version'], /ffmpeg version (\S+)/),
    version(found.ytdlp, ['--version'], /^(\S+)/),
  ]);
  cache.value = {
    ffmpeg: ffmpegV ? { path: found.ffmpeg, version: ffmpegV } : null,
    ffprobe: found.ffprobe ? { path: found.ffprobe } : null,
    ytdlp: ytdlpV ? { path: found.ytdlp, version: ytdlpV } : null,
  };
  cache.at = Date.now();
  return cache.value;
}

export async function requireTool(name) {
  const t = (await tools())[name];
  if (!t) {
    const hint = name === 'ytdlp'
      ? 'Install yt-dlp (https://github.com/yt-dlp/yt-dlp) and make sure it is on the PATH, or set "ytdlpPath" in data/config.json.'
      : 'Install ffmpeg (https://ffmpeg.org) and make sure it is on the PATH, or set "ffmpegPath" in data/config.json.';
    const err = new Error(`${name === 'ytdlp' ? 'yt-dlp' : name} is not installed. ${hint}`);
    err.status = 501;
    throw err;
  }
  return t.path;
}
