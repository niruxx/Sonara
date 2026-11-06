// Tiny logger: console + data/logs/sonara.log (rotated at 5 MB).
// Writing to a file matters on Windows, where the Scheduled Task has no console.

import fs from 'node:fs';
import path from 'node:path';
import { LOGS_DIR } from './config.js';

const LOG_FILE = path.join(LOGS_DIR, 'sonara.log');
const MAX_BYTES = 5 * 1024 * 1024;

function rotate() {
  try {
    if (fs.statSync(LOG_FILE).size > MAX_BYTES) fs.renameSync(LOG_FILE, LOG_FILE + '.1');
  } catch { /* file does not exist yet */ }
}

function write(level, args) {
  const msg = args.map((a) => (a instanceof Error ? a.stack : typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  const line = `${new Date().toISOString()} [${level}] ${msg}`;
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
};
