// Small helper the install scripts use to edit data/config.json.
//
//   node scripts/configure.js --port 7700 --add-music "/srv/music"
//   node scripts/configure.js --get port

import fs from 'node:fs';
import path from 'node:path';
import { getConfig, saveConfig, CONFIG_FILE } from '../server/config.js';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const get = opt('--get');
if (get) {
  console.log(getConfig()[get] ?? '');
  process.exit(0);
}

const patch = {};
const port = opt('--port');
if (port) {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.error(`Invalid port: ${port}`);
    process.exit(1);
  }
  patch.port = n;
}

const music = opt('--add-music');
if (music) {
  const dir = path.resolve(music);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error(`Music folder not found: ${dir}`);
    process.exit(1);
  }
  const current = getConfig().musicDirs || [];
  if (!current.includes(dir)) patch.musicDirs = [...current, dir];
}

if (Object.keys(patch).length) {
  saveConfig(patch);
  console.log(`Updated ${CONFIG_FILE}`);
}
