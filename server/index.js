import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { ROOT, DATA_DIR, getConfig } from './config.js';
import { log } from './logger.js';
import { db } from './db.js';
import { sessionMiddleware } from './auth.js';
import { api } from './api.js';
import { scanLibrary, scheduleScans } from './scanner.js';

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const config = getConfig();
const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 'loopback');

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

app.use(sessionMiddleware);
app.get('/api/version', (_req, res) => res.json({ name: 'Sonara', version: pkg.version }));
app.use('/api', api);

const PUBLIC = path.join(ROOT, 'public');
// maxAge 0 + ETag: browsers revalidate (cheap 304s), so updates show up immediately.
app.use(express.static(PUBLIC, { index: false, maxAge: 0 }));
// Single-page app: every other GET serves index.html.
app.get(/.*/, (_req, res) => res.sendFile(path.join(PUBLIC, 'index.html'), { maxAge: 0 }));

app.use((err, _req, res, _next) => {
  log.error('[http]', err);
  if (!res.headersSent) res.status(err.status || 500).json({ error: err.expose ? err.message : 'Internal server error' });
});

const server = app.listen(config.port, config.host, () => {
  log.info(`Sonara ${pkg.version} listening on http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
  log.info(`Data directory: ${DATA_DIR}`);
  if (!config.musicDirs.length) log.info('No music folders configured yet. Add one in Settings → Library.');
  if (config.scanOnStartup && config.musicDirs.length) setTimeout(() => scanLibrary(), 1500);
  scheduleScans();
});

server.on('error', (err) => {
  log.error(err.code === 'EADDRINUSE' ? `Port ${config.port} is already in use.` : err);
  process.exit(1);
});

function shutdown(signal) {
  log.info(`Received ${signal}, shutting down`);
  server.close();
  try { db.close(); } catch { /* already closed */ }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
