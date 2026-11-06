// Creates a consistent snapshot of the Sonara database in data/backups/
// (safe while the server is running) and keeps the newest 10 snapshots.
//
//   node scripts/backup.js            → back up
//   npm run backup                    → same thing

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.resolve(process.env.SONARA_DATA_DIR || path.join(ROOT, 'data'));
const DB_FILE = path.join(DATA_DIR, 'sonara.db');
const BACKUPS = path.join(DATA_DIR, 'backups');
const KEEP = 10;

if (!fs.existsSync(DB_FILE)) {
  console.log('No database yet - nothing to back up.');
  process.exit(0);
}

fs.mkdirSync(BACKUPS, { recursive: true });
const stamp = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+/, '');
const target = path.join(BACKUPS, `sonara-${stamp}.db`);

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA busy_timeout = 10000');
db.prepare('VACUUM INTO ?').run(target);
db.close();
console.log(`Database backed up to ${target}`);

const old = fs.readdirSync(BACKUPS).filter((f) => /^sonara-.*\.db$/.test(f)).sort().reverse().slice(KEEP);
for (const f of old) fs.rmSync(path.join(BACKUPS, f), { force: true });
