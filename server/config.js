// Runtime configuration.
//
// Everything user-specific lives in the data directory (default: <repo>/data),
// which is git-ignored so `git pull` / the update scripts never touch it.
//
// Precedence: environment variables > data/config.json > defaults.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.resolve(process.env.SONARA_DATA_DIR || path.join(ROOT, 'data'));
export const COVERS_DIR = path.join(DATA_DIR, 'covers');
export const LOGS_DIR = path.join(DATA_DIR, 'logs');
export const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
export const PODCASTS_DIR = path.join(DATA_DIR, 'podcasts');
export const DB_FILE = path.join(DATA_DIR, 'sonara.db');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

for (const dir of [DATA_DIR, COVERS_DIR, LOGS_DIR, BACKUPS_DIR, PODCASTS_DIR]) {
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
  // Disk space for transcoded audio (MB). Least recently played files are removed first.
  transcodeCacheMB: 2048,
  // Optional online services (all off by default).
  onlineLyrics: false,      // LRCLIB
  onlineArtistInfo: false,  // MusicBrainz + Wikipedia (+ fanart.tv / Last.fm with keys)
  onlineCovers: false,      // Cover Art Archive for albums without art
  lastfmApiKey: '',
  lastfmSecret: '',
  fanartApiKey: '',
  onlineContact: '',        // added to the User-Agent sent to MusicBrainz etc.
  onlinePodcastDirectory: false, // search podcasts in the Apple Podcasts directory
  onlineRadioDirectory: false,   // search stations on radio-browser.info
  // Podcasts
  podcastRefreshHours: 6,    // how often feeds are checked for new episodes (0 = only by hand)
  podcastDownloadMB: 1024,   // largest single episode the server will download
  sessionDays: 30,
  // Public URL people use to reach Sonara (e.g. https://music.example.com). Used for share
  // links, single sign-on and casting. '' = work it out from each request.
  publicUrl: '',
  // Sharing and multi-device
  sharing: true,             // let users create public share links
  importPlaylists: true,     // turn .m3u / .m3u8 files in the music folders into playlists
  jukebox: false,            // play through the server's own speakers (needs mpv or ffplay)
  mpvPath: '',
  dlna: false,               // find DLNA / UPnP speakers on the network and play to them
  dlnaFormat: 'mp3',         // mp3 (plays everywhere) | original
  // Sign-in
  proxyAuthHeader: '',       // e.g. "Remote-User" behind Authelia / Authentik ('' = off)
  proxyAuthTrusted: ['127.0.0.1', '::1'], // addresses allowed to send that header
  proxyAuthAutoCreate: true,
  oidcIssuer: '',            // e.g. https://auth.example.com/application/o/sonara/
  oidcClientId: '',
  oidcClientSecret: '',
  oidcLabel: 'Single sign-on',
  oidcUsernameClaim: 'preferred_username',
  oidcAdminGroup: '',        // members of this group become admins
  oidcAutoCreate: true,
  passwordLogin: true,       // turn off to allow only single sign-on / proxy sign-in
  // Operations
  logFormat: 'text',         // text | json
  logRequests: false,        // write one log line per HTTP request
  metrics: false,            // Prometheus metrics at /metrics
  metricsToken: '',          // if set, /metrics needs "Authorization: Bearer <token>"
  backupIntervalHours: 0,    // automatic database backups (0 = off)
  backupKeep: 10,
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
  if (process.env.SONARA_LOG_FORMAT) o.logFormat = process.env.SONARA_LOG_FORMAT;
  if (process.env.SONARA_PUBLIC_URL) o.publicUrl = process.env.SONARA_PUBLIC_URL;
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

/** Random server secret (signed stream links for casting), created on first run. */
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');
let secret;
export function serverSecret() {
  if (secret) return secret;
  try { secret = fs.readFileSync(SECRET_FILE); } catch {
    secret = crypto.randomBytes(32);
    fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
  }
  return secret;
}

export const downloadsDir = () => path.resolve(config.downloadsDir || path.join(DATA_DIR, 'downloads'));

// Write a config file on first run so users have something to edit.
if (!fs.existsSync(CONFIG_FILE)) saveConfig({ ...DEFAULTS, ...fileConfig });
