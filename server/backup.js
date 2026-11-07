// Database backups from the UI: create, download, delete, scheduled snapshots,
// and restore (staged as data/restore-pending.db and swapped in at the next start,
// see db.js, so the running database is never replaced underneath itself).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { db, RESTORE_FILE } from './db.js';
import { BACKUPS_DIR, getConfig } from './config.js';
import { log } from './logger.js';

const NAME_RE = /^sonara-[\w.-]+\.db$/;

export function listBackups() {
  let files = [];
  try { files = fs.readdirSync(BACKUPS_DIR).filter((f) => NAME_RE.test(f)); } catch { /* none */ }
  return files.map((name) => {
    const st = fs.statSync(path.join(BACKUPS_DIR, name));
    return { name, size: st.size, createdAt: Math.floor(st.mtimeMs) };
  }).sort((a, b) => b.createdAt - a.createdAt);
}

export function backupPath(name) {
  if (!NAME_RE.test(String(name))) throw Object.assign(new Error('Invalid backup name'), { status: 400 });
  const p = path.join(BACKUPS_DIR, name);
  if (!fs.existsSync(p)) throw Object.assign(new Error('Backup not found'), { status: 404 });
  return p;
}

export function createBackup(label = '') {
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+/, '');
  const name = `sonara-${stamp}${label ? `-${label}` : ''}.db`;
  const target = path.join(BACKUPS_DIR, name);
  fs.rmSync(target, { force: true });
  db.prepare('VACUUM INTO ?').run(target);
  log.info(`[backup] Saved ${name}`);
  prune();
  return listBackups().find((b) => b.name === name);
}

function prune() {
  const keep = Math.max(1, Number(getConfig().backupKeep) || 10);
  // Only automatic snapshots are pruned; ones made before a restore are kept.
  const auto = listBackups().filter((b) => !b.name.includes('before-restore'));
  for (const b of auto.slice(keep)) fs.rmSync(path.join(BACKUPS_DIR, b.name), { force: true });
}

export function deleteBackup(name) {
  fs.rmSync(backupPath(name), { force: true });
}

/** Check that a file is a Sonara database we can use. Returns { version, tracks, users }. */
function inspect(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  fs.closeSync(fd);
  if (head.toString('latin1') !== 'SQLite format 3\u0000') throw Object.assign(new Error("That file isn't a SQLite database"), { status: 400 });
  const d = new DatabaseSync(file, { readOnly: true });
  try {
    const ok = d.prepare('PRAGMA quick_check').get();
    if (Object.values(ok)[0] !== 'ok') throw Object.assign(new Error('The backup is damaged'), { status: 400 });
    const version = d.prepare('PRAGMA user_version').get().user_version;
    const current = db.prepare('PRAGMA user_version').get().user_version;
    if (version > current) throw Object.assign(new Error('That backup is from a newer version of Sonara. Update first.'), { status: 400 });
    const has = (t) => !!d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    if (!has('users') || !has('tracks')) throw Object.assign(new Error("That database isn't from Sonara"), { status: 400 });
    return { version, tracks: d.prepare('SELECT COUNT(*) AS n FROM tracks').get().n, users: d.prepare('SELECT COUNT(*) AS n FROM users').get().n };
  } finally { d.close(); }
}

/** Stage a backup (existing name, or an uploaded temp file) to be restored at the next start. */
export async function stageRestore({ name, uploadedFile }) {
  const src = name ? backupPath(name) : uploadedFile;
  const info = inspect(src);
  const tmp = RESTORE_FILE + '.tmp';
  await fsp.copyFile(src, tmp);
  await fsp.rename(tmp, RESTORE_FILE);
  log.info(`[backup] Restore staged from ${name || 'an uploaded file'} (${info.tracks} tracks, ${info.users} users). It is applied when Sonara restarts.`);
  return info;
}

export const restorePending = () => fs.existsSync(RESTORE_FILE);
export const cancelRestore = () => fs.rmSync(RESTORE_FILE, { force: true });

let timer = null;
export function scheduleBackups() {
  clearInterval(timer);
  const hours = Number(getConfig().backupIntervalHours) || 0;
  if (hours <= 0) return;
  timer = setInterval(() => {
    try { createBackup('auto'); } catch (err) { log.error('[backup] Scheduled backup failed', err); }
  }, hours * 3600000);
  timer.unref();
}
