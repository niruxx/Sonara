import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { ROOT, DATA_DIR, getConfig } from './config.js';
import { log } from './logger.js';
import { db } from './db.js';
import { sessionMiddleware } from './auth.js';
import { api, TOMBSTONE_DAYS } from './api.js';
import { subsonicApi } from './subsonic.js';
import { openapiSpec } from './openapi.js';
import { scanLibrary, scheduleScans, watchLibrary } from './scanner.js';
import { publicApi } from './public.js';
import { requestMetrics, health, metricsText } from './metrics.js';
import { setupJukebox } from './jukebox.js';
import { setupDlna } from './dlna.js';
import { scheduleBackups } from './backup.js';
import { schedulePodcastRefresh } from './podcasts.js';
import { scheduleAnalysis } from './analysis.js';
import { scheduleDiscography } from './discography.js';
import { setupSnapcast } from './snapcast.js';
import { setupIntegrations } from './integrations.js';

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

app.use(requestMetrics);

// Health check for Docker, load balancers and uptime monitors (no sign-in needed).
app.get('/api/health', (_req, res) => {
  const h = health();
  res.status(h.status === 'ok' ? 200 : 503).json({ ...h, version: pkg.version });
});
app.get('/api/version', (_req, res) => res.json({ name: 'Sonara', version: pkg.version }));

// Client apps (Subsonic / OpenSubsonic API). They sign in with every request, so this sits
// before the cookie session: a browser's own session never leaks into these calls.
app.use('/rest', subsonicApi);
// Machine-readable description of Sonara's own API.
app.get('/api/openapi.json', (req, res) => res.json(openapiSpec(req)));

app.use(sessionMiddleware);

// Prometheus metrics: off unless "metrics": true. With "metricsToken" set, scrapers send it as a bearer token.
app.get('/metrics', (req, res) => {
  const c = getConfig();
  if (!c.metrics) return res.status(404).end();
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const allowed = c.metricsToken ? bearer === c.metricsToken : true;
  if (!allowed && !req.user?.is_admin) return res.status(401).set('WWW-Authenticate', 'Bearer').end();
  res.type('text/plain; version=0.0.4').send(metricsText(pkg.version));
});

app.use('/api/public', publicApi);
app.use('/api', api);

const PUBLIC = path.join(ROOT, 'public');
// Public share pages work without an account.
app.get('/s/:id', (_req, res) => res.sendFile(path.join(PUBLIC, 'share.html'), { maxAge: 0 }));
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
  watchLibrary();
  scheduleBackups();
  schedulePodcastRefresh();
  scheduleAnalysis();
  scheduleDiscography();
  setupSnapcast().catch((err) => log.warn('[snapcast]', err.message));
  setupIntegrations();
  setupJukebox().catch((err) => log.warn('[jukebox]', err.message));
  setupDlna();
  // Forget removed songs once syncing apps have had plenty of time to notice.
  const pruneTombstones = () => db.prepare('DELETE FROM track_tombstones WHERE removed_at < ?').run(Date.now() - TOMBSTONE_DAYS * 86400000);
  pruneTombstones();
  setInterval(pruneTombstones, 24 * 3600000).unref();
});

server.on('error', (err) => {
  log.error(err.code === 'EADDRINUSE' ? `Port ${config.port} is already in use.` : err);
  process.exit(1);
});

function shutdown(signal, code = 0) {
  log.info(signal === 'restart' ? 'Restarting' : `Received ${signal}, shutting down`);
  server.close();
  server.closeAllConnections?.();
  try { db.close(); } catch { /* already closed */ }
  process.exit(code);
}
process.on('sonara:restart', () => shutdown('restart', 75));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
