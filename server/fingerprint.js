// Identify songs by how they sound: Chromaprint's fpcalc makes a fingerprint,
// AcoustID matches it to MusicBrainz recordings, and the admin picks the right
// match to write into the file's tags (through the normal tag editor).
//
// Needs fpcalc (https://acoustid.org/chromaprint) and a free AcoustID API key
// (https://acoustid.org/new-application). Admin only, one song at a time.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { q } from './db.js';
import { getConfig } from './config.js';
import { request } from './online.js';

const httpError = (status, message) => Object.assign(new Error(message), { status });
const EXE = process.platform === 'win32' ? '.exe' : '';

export function fpcalcPath() {
  const c = getConfig();
  if (c.fpcalcPath) return fs.existsSync(c.fpcalcPath) ? c.fpcalcPath : null;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, `fpcalc${EXE}`);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return null;
}

function fpcalc(bin, file, { length = 120 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, ['-json', '-length', String(length), file], { timeout: 60000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(httpError(500, `fpcalc failed: ${(stderr || err.message).toString().trim().split('\n').pop()}`));
      try {
        const j = JSON.parse(stdout);
        resolve({ duration: Math.round(j.duration), fingerprint: j.fingerprint });
      } catch { reject(httpError(500, 'fpcalc gave no fingerprint')); }
    });
  });
}

/** Candidates for a track: [{ score, recordingId, title, artist, album, albumArtist, year, releaseGroupId, type }]. */
export async function identify(trackId) {
  const key = String(getConfig().acoustidApiKey || '').trim();
  if (!key) throw httpError(400, 'Add an AcoustID API key in Settings → Online services first (free at acoustid.org).');
  const bin = fpcalcPath();
  if (!bin) throw httpError(501, 'fpcalc (Chromaprint) is not installed. Install it from https://acoustid.org/chromaprint, or set "fpcalcPath" in data/config.json.');
  const t = q('SELECT id, path, cue_file, cue_start FROM tracks WHERE id = ?').get(trackId);
  if (!t) throw httpError(404, 'Track not found');
  if (t.cue_file) throw httpError(400, 'Songs cut from a single-file album (cue sheet) can’t be fingerprinted on their own.');
  const fp = await fpcalc(bin, t.path);
  const body = new URLSearchParams({ client: key, meta: 'recordings releasegroups compress', duration: String(fp.duration), fingerprint: fp.fingerprint, format: 'json' });
  const res = await request('https://api.acoustid.org/v2/lookup', { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 });
  const j = await res.json().catch(() => null);
  if (!res.ok || j?.status !== 'ok') throw httpError(502, `AcoustID: ${j?.error?.message || `answered ${res.status}`}`);
  const out = [];
  for (const r of j.results || []) {
    for (const rec of r.recordings || []) {
      if (!rec.title) continue;
      const artist = (rec.artists || []).map((a, i, all) => a.name + (i < all.length - 1 ? (a.joinphrase || ', ') : '')).join('');
      const groups = rec.releasegroups?.length ? rec.releasegroups : [null];
      for (const g of groups.slice(0, 4)) {
        out.push({
          score: Math.round((r.score || 0) * 100),
          recordingId: rec.id,
          title: rec.title,
          artist,
          album: g?.title || null,
          albumArtist: g?.artists?.map((a) => a.name).join(', ') || artist,
          type: g?.type || null,
          releaseGroupId: g?.id || null,
        });
      }
    }
  }
  // Albums before singles and compilations; best scores first; no duplicates.
  const rank = (c) => (c.type === 'Album' ? 0 : c.type === 'EP' ? 1 : c.type === 'Single' ? 2 : 3);
  const seen = new Set();
  return out.sort((a, b) => b.score - a.score || rank(a) - rank(b))
    .filter((c) => { const k = `${c.title}|${c.artist}|${c.album}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 15);
}

export const fingerprintStatus = () => ({ fpcalc: !!fpcalcPath(), apiKey: !!String(getConfig().acoustidApiKey || '').trim() });
