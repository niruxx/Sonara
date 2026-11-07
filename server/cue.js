// Cue sheet parser: turns a single-file album (album.flac + album.cue) into tracks.

import fs from 'node:fs';
import path from 'node:path';

const unquote = (s) => s.trim().replace(/^"(.*)"$/, '$1').trim();

/** INDEX time "mm:ss:ff" (75 frames per second) → seconds. */
const toSeconds = (t) => {
  const m = String(t).trim().match(/^(\d+):(\d{1,2}):(\d{1,2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 75 : null;
};

/** Read a .cue as UTF-8, falling back to Latin-1 (common for older rips). */
function readText(file) {
  const buf = fs.readFileSync(file);
  let s = buf.toString('utf8');
  if (s.includes('�')) s = buf.toString('latin1');
  return s.replace(/^﻿/, '');
}

/**
 * Parse a cue sheet. Returns { title, performer, genre, date, files: [{ name, tracks: [{ no, title, performer, start }] }] }.
 */
export function parseCue(file) {
  const sheet = { title: '', performer: '', genre: '', date: '', files: [] };
  let curFile = null, curTrack = null;
  for (const raw of readText(file).split(/\r?\n/)) {
    const line = raw.trim();
    const [cmd, ...restParts] = line.split(/\s+/);
    const rest = line.slice(cmd.length).trim();
    switch ((cmd || '').toUpperCase()) {
      case 'REM': {
        const [key, ...v] = restParts;
        const val = unquote(v.join(' '));
        if (/^GENRE$/i.test(key)) sheet.genre = val;
        if (/^DATE$/i.test(key)) sheet.date = val;
        break;
      }
      case 'TITLE': (curTrack ? (curTrack.title = unquote(rest)) : (sheet.title = unquote(rest))); break;
      case 'PERFORMER': (curTrack ? (curTrack.performer = unquote(rest)) : (sheet.performer = unquote(rest))); break;
      case 'FILE': {
        const name = unquote(rest.replace(/\s+\w+$/, '')); // drop the trailing type (WAVE, MP3…)
        curFile = { name, tracks: [] };
        sheet.files.push(curFile);
        curTrack = null;
        break;
      }
      case 'TRACK': {
        if (!curFile) break;
        curTrack = { no: Number.parseInt(restParts[0], 10), title: '', performer: '', start: null, audio: /AUDIO/i.test(restParts[1] || '') };
        curFile.tracks.push(curTrack);
        break;
      }
      case 'INDEX': {
        if (!curTrack) break;
        const [num, time] = restParts;
        const sec = toSeconds(time);
        // INDEX 01 is where the track starts; INDEX 00 (pregap) is only a fallback.
        if (Number(num) === 1 || (Number(num) === 0 && curTrack.start == null)) curTrack.start = sec;
        break;
      }
      default: break;
    }
  }
  for (const f of sheet.files) f.tracks = f.tracks.filter((t) => t.audio && t.start != null).sort((a, b) => a.start - b.start);
  return sheet;
}

/**
 * Find the audio file a single-FILE cue sheet describes. Rips often reference
 * "album.wav" although the file was later converted to album.flac, so fall back
 * to matching the name without its extension, then to a lone audio file of the same name as the cue.
 */
export function resolveCueAudio(cuePath, sheet, audioFiles) {
  if (sheet.files.length !== 1 || sheet.files[0].tracks.length < 2) return null;
  const dir = path.dirname(cuePath);
  const inDir = audioFiles.filter((f) => path.dirname(f) === dir);
  const ref = sheet.files[0].name;
  const stem = (p) => path.parse(p).name.toLowerCase();
  return inDir.find((f) => path.basename(f).toLowerCase() === path.basename(ref).toLowerCase())
    || inDir.find((f) => stem(f) === stem(ref))
    || inDir.find((f) => stem(f) === stem(cuePath))
    || null;
}

/** Virtual library path of cue track n inside `file`. */
export const cueTrackPath = (file, n) => `${file}::cue:${String(n).padStart(2, '0')}`;
