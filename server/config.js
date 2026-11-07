// Runtime configuration.
//
// Everything user-specific lives in the data directory (default: <repo>/data),
// which is git-ignored so `git pull` / the update scripts never touch it.
//
// Precedence: environment variables > data/config.json > defaults.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.resolve(process.env.SONARA_DATA_DIR || path.join(ROOT, 'data'));
export const COVERS_DIR = path.join(DATA_DIR, 'covers');
export const LOGS_DIR = path.join(DATA_DIR, 'logs');
export const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
export const DB_FILE = path.join(DATA_DIR, 'sonara.db');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

for (const dir of [DATA_DIR, COVERS_DIR, LOGS_DIR, BACKUPS_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const DEFAULTS = {
  port: 7700,
  host: '0.0.0.0',
  musicDirs: [],
  scanOnStartup: true,
  scanIntervalMinutes: 60,
  watch: true,
  // Let admins edit tags and move/organize files from the web UI.
  allowFileChanges: false,
  // Where yt-dlp downloads and conversions land before you file them ('' = data/downloads).
  downloadsDir: '',
  // Optional explicit tool paths ('' = look on the PATH).
  ffmpegPath: '',
  ytdlpPath: '',
  sessionDays: 30,
};

function readFileConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[config] Could not parse ${CONFIG_FILE}: ${err.message}`);
    return {};
  }
}

function envOverrides() {
  const o = {};
  if (process.env.SONARA_PORT) o.port = Number(process.env.SONARA_PORT);
  if (process.env.SONARA_HOST) o.host = process.env.SONARA_HOST;
  if (process.env.SONARA_MUSIC_DIRS) {
    o.musicDirs = process.env.SONARA_MUSIC_DIRS.split(path.delimiter).map((s) => s.trim()).filter(Boolean);
  }
  return o;
}

let fileConfig = readFileConfig();
const config = { ...DEFAULTS, ...fileConfig, ...envOverrides() };

export function getConfig() {
  return config;
}

/** Persist a partial update to data/config.json (env overrides still win at runtime). */
export function saveConfig(partial) {
  fileConfig = { ...fileConfig, ...partial };
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(fileConfig, null, 2) + '\n');
  fs.renameSync(tmp, CONFIG_FILE);
  Object.assign(config, partial, envOverrides());
  return config;
}

export const downloadsDir = () => path.resolve(config.downloadsDir || path.join(DATA_DIR, 'downloads'));

// Write a config file on first run so users have something to edit.
if (!fs.existsSync(CONFIG_FILE)) saveConfig({ ...DEFAULTS, ...fileConfig });
