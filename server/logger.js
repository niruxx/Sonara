// Tiny logger: console + data/logs/sonara.log (rotated at 5 MB).
// Writing to a file matters on Windows, where the Scheduled Task has no console.
// "logFormat": "json" (or SONARA_LOG_FORMAT=json) writes one JSON object per line,
// for log collectors such as Loki, Elasticsearch or `docker logs | jq`.

import fs from 'node:fs';
import path from 'node:path';
import { LOGS_DIR, getConfig } from './config.js';

export const LOG_FILE = path.join(LOGS_DIR, 'sonara.log');
const MAX_BYTES = 5 * 1024 * 1024;
const counts = { INFO: 0, WARN: 0, ERROR: 0 };

function rotate() {
  try {
    if (fs.statSync(LOG_FILE).size > MAX_BYTES) fs.renameSync(LOG_FILE, LOG_FILE + '.1');
  } catch { /* file does not exist yet */ }
}

function write(level, args, fields) {
  counts[level]++;
  const msg = args.map((a) => (a instanceof Error ? a.stack : typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  const time = new Date().toISOString();
  let line;
  if (getConfig().logFormat === 'json') {
    const m = msg.match(/^\[([\w-]+)\]\s*/);
    line = JSON.stringify({ time, level: level.toLowerCase(), ...(m ? { component: m[1] } : {}), msg: m ? msg.slice(m[0].length) : msg, ...fields });
  } else {
    line = `${time} [${level}] ${msg}${fields ? ' ' + Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ') : ''}`;
  }
  (level === 'ERROR' ? console.error : console.log)(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch { /* never crash because of logging */ }
}

rotate();
setInterval(rotate, 60 * 60 * 1000).unref();

export const log = {
  info: (...a) => write('INFO', a),
  warn: (...a) => write('WARN', a),
  error: (...a) => write('ERROR', a),
  /** Structured entry: log.event('info', '[http] GET /x', { status: 200, ms: 4 }) */
  event: (level, msg, fields) => write(level.toUpperCase(), [msg], fields),
  counts,
};

/** Parse one log line (text or JSON) into { time, level, msg }. */
function parseLine(line) {
  if (line.startsWith('{')) {
    try {
      const o = JSON.parse(line);
      const { time, level, msg, component, ...rest } = o;
      const extra = Object.entries(rest).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ');
      return { time, level: String(level || 'info').toUpperCase(), msg: `${component ? `[${component}] ` : ''}${msg}${extra ? ' ' + extra : ''}` };
    } catch { /* fall through */ }
  }
  const m = line.match(/^(\S+) \[(INFO|WARN|ERROR)\] ([\s\S]*)$/);
  return m ? { time: m[1], level: m[2], msg: m[3] } : null;
}

/** The newest log entries (newest last). Continuation lines (stack traces) join their entry. */
export function tailLog({ limit = 500, level = '', search = '' } = {}) {
  const chunks = [];
  for (const f of [LOG_FILE + '.1', LOG_FILE]) {
    try {
      const size = fs.statSync(f).size;
      const want = 1024 * 1024;
      const fd = fs.openSync(f, 'r');
      const buf = Buffer.alloc(Math.min(size, want));
      fs.readSync(fd, buf, 0, buf.length, Math.max(0, size - buf.length));
      fs.closeSync(fd);
      chunks.push(buf.toString('utf8'));
    } catch { /* missing */ }
  }
  const entries = [];
  for (const line of chunks.join('\n').split('\n')) {
    if (!line) continue;
    const e = parseLine(line);
    if (e) entries.push(e);
    else if (entries.length) entries[entries.length - 1].msg += '\n' + line;
  }
  const levels = { INFO: 0, WARN: 1, ERROR: 2 };
  const min = levels[String(level).toUpperCase()] ?? 0;
  const s = String(search).toLowerCase();
  return entries.filter((e) => (levels[e.level] ?? 0) >= min && (!s || e.msg.toLowerCase().includes(s))).slice(-limit);
}
