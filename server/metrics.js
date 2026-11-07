// Health check, Prometheus metrics and (optional) request logging.

import { q } from './db.js';
import { getConfig } from './config.js';
import { log } from './logger.js';
import { scanStatus } from './scanner.js';
import { connectStats } from './connect.js';

const started = Date.now();
const requests = new Map(); // `${method} ${class}` -> count
const BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 10];
const hist = { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 };
let activeStreams = 0;

/** Group request paths so metrics don't explode with ids. */
const routeOf = (url) => {
  const p = url.split('?')[0];
  if (!p.startsWith('/api/')) return 'static';
  const m = p.match(/^\/api\/(public\/\w+|admin\/\w+|\w+)/);
  return m ? m[1] : 'api';
};

export function requestMetrics(req, res, next) {
  const t0 = process.hrtime.bigint();
  const streaming = req.path.startsWith('/api/stream/') || req.path.startsWith('/api/public/stream/') || /\/api\/public\/shares\/[^/]+\/stream\//.test(req.path);
  if (streaming) activeStreams++;
  res.on('close', () => {
    if (streaming) activeStreams--;
    const sec = Number(process.hrtime.bigint() - t0) / 1e9;
    const key = `${req.method}|${routeOf(req.originalUrl)}|${String(res.statusCode)[0]}xx`;
    requests.set(key, (requests.get(key) || 0) + 1);
    hist.sum += sec;
    hist.count++;
    BUCKETS.forEach((b, i) => { if (sec <= b) hist.buckets[i]++; });
    const c = getConfig();
    if (c.logRequests && !streaming && !req.path.startsWith('/api/connect/')) {
      log.event(res.statusCode >= 500 ? 'error' : 'info', `[http] ${req.method} ${req.originalUrl.split('?')[0]}`,
        { status: res.statusCode, ms: Math.round(sec * 1000), user: req.user?.username || '-', ip: req.ip });
    }
  });
  next();
}

export function health() {
  let dbOk = true;
  try { q('SELECT 1').get(); } catch { dbOk = false; }
  return { status: dbOk ? 'ok' : 'error', database: dbOk ? 'ok' : 'error', uptime: Math.round((Date.now() - started) / 1000), scanning: scanStatus().running };
}

export function metricsText(version) {
  const lines = [];
  const metric = (name, type, help, samples) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [labels, v] of samples) lines.push(`${name}${labels ? `{${labels}}` : ''} ${v}`);
  };
  const lib = q(`SELECT COUNT(*) AS tracks, COUNT(DISTINCT album_id) AS albums, COUNT(DISTINCT album_artist_id) AS artists,
    COALESCE(SUM(duration), 0) AS duration, COALESCE(SUM(size), 0) AS size FROM tracks`).get();
  const scan = scanStatus();
  const conn = connectStats();
  metric('sonara_info', 'gauge', 'Sonara version', [[`version="${version}"`, 1]]);
  metric('sonara_uptime_seconds', 'gauge', 'Seconds since start', [['', Math.round((Date.now() - started) / 1000)]]);
  metric('sonara_library_tracks', 'gauge', 'Songs in the library', [['', lib.tracks]]);
  metric('sonara_library_albums', 'gauge', 'Albums in the library', [['', lib.albums]]);
  metric('sonara_library_artists', 'gauge', 'Album artists in the library', [['', lib.artists]]);
  metric('sonara_library_duration_seconds', 'gauge', 'Total length of the library', [['', Math.round(lib.duration)]]);
  metric('sonara_library_size_bytes', 'gauge', 'Total size of the library files', [['', lib.size]]);
  metric('sonara_users', 'gauge', 'User accounts', [['', q('SELECT COUNT(*) AS n FROM users').get().n]]);
  metric('sonara_plays_total', 'counter', 'Songs played (all users)', [['', q('SELECT COUNT(*) AS n FROM plays').get().n]]);
  metric('sonara_shares', 'gauge', 'Active share links', [['', q('SELECT COUNT(*) AS n FROM shares WHERE expires_at IS NULL OR expires_at > ?').get(Date.now()).n]]);
  metric('sonara_scan_running', 'gauge', '1 while a library scan runs', [['', scan.running ? 1 : 0]]);
  metric('sonara_scan_last_finished_timestamp_seconds', 'gauge', 'When the last scan finished', [['', Math.round((scan.finishedAt || 0) / 1000)]]);
  metric('sonara_scan_last_errors', 'gauge', 'Files that failed in the last scan', [['', scan.errors || 0]]);
  metric('sonara_streams_active', 'gauge', 'Audio streams being served right now', [['', activeStreams]]);
  metric('sonara_connect_clients', 'gauge', 'Open player tabs connected for remote control', [['', conn.clients]]);
  metric('sonara_connect_server_devices', 'gauge', 'Jukebox and network speakers', [['', conn.serverDevices]]);
  metric('sonara_listening_parties', 'gauge', 'Listening parties in progress', [['', conn.parties]]);
  metric('sonara_log_messages_total', 'counter', 'Log messages by level', Object.entries(log.counts).map(([l, n]) => [`level="${l.toLowerCase()}"`, n]));
  metric('sonara_http_requests_total', 'counter', 'HTTP requests', [...requests].map(([k, n]) => {
    const [method, route, status] = k.split('|');
    return [`method="${method}",route="${route}",status="${status}"`, n];
  }));
  lines.push('# HELP sonara_http_request_duration_seconds HTTP request duration', '# TYPE sonara_http_request_duration_seconds histogram');
  BUCKETS.forEach((b, i) => lines.push(`sonara_http_request_duration_seconds_bucket{le="${b}"} ${hist.buckets[i]}`));
  lines.push(`sonara_http_request_duration_seconds_bucket{le="+Inf"} ${hist.count}`, `sonara_http_request_duration_seconds_sum ${hist.sum.toFixed(3)}`, `sonara_http_request_duration_seconds_count ${hist.count}`);
  const mem = process.memoryUsage();
  metric('process_resident_memory_bytes', 'gauge', 'Resident memory', [['', mem.rss]]);
  metric('nodejs_heap_used_bytes', 'gauge', 'V8 heap in use', [['', mem.heapUsed]]);
  return lines.join('\n') + '\n';
}
