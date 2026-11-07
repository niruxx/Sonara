// Import listening history from Last.fm, ListenBrainz or a Spotify data export
// (the export is read in the browser and sent here in batches),
// so stats, "Rediscover" and time-of-day mixes work from day one. Listens are
// matched to library songs by artist and title; ones already in the history
// (same song within two minutes) are skipped.

import express from 'express';
import { q, tx } from './db.js';
import { getConfig } from './config.js';
import { getJson } from './online.js';
import { buildMatcher } from './playlists.js';
import { log } from './logger.js';

const MAX_LISTENS = 500000; // one import reads at most this many listens
const jobs = new Map(); // user id -> { source, state, fetched, matched, added, skipped, error, startedAt, finishedAt }
const httpError = (status, message) => Object.assign(new Error(message), { status });

function addPlays(userId, listens, job) {
  const matcher = job.matcher ||= buildMatcher();
  const near = q('SELECT 1 FROM plays WHERE user_id = ? AND track_id = ? AND played_at BETWEEN ? AND ? LIMIT 1');
  const ins = q('INSERT INTO plays (user_id, track_id, played_at) VALUES (?, ?, ?)');
  tx(() => {
    for (const l of listens) {
      job.fetched++;
      if (!l.title || !l.at) continue;
      const id = matcher(l.title, l.artist, l.album);
      if (!id) { job.unmatched++; continue; }
      job.matched++;
      if (near.get(userId, id, l.at - 120000, l.at + 120000)) { job.skipped++; continue; }
      ins.run(userId, id, l.at);
      job.added++;
    }
  });
}

async function fromLastfm(userId, username, job) {
  const key = getConfig().lastfmApiKey;
  if (!key) throw httpError(400, 'An admin needs to add a Last.fm API key in Settings → Online services first.');
  for (let page = 1, pages = 1; page <= pages && page <= 2500; page++) {
    if (job.cancelled || job.fetched >= MAX_LISTENS) return;
    const r = await getJson(`https://ws.audioscrobbler.com/2.0/?${new URLSearchParams({ method: 'user.getrecenttracks', user: username, api_key: key, format: 'json', limit: '200', page: String(page) })}`, { timeout: 20000 });
    if (r?.error) throw httpError(400, `Last.fm: ${r.message}`);
    const rt = r?.recenttracks;
    if (!rt) throw httpError(404, 'Last.fm user not found');
    pages = Number(rt['@attr']?.totalPages) || 1;
    job.total = Number(rt['@attr']?.total) || job.total;
    const listens = [].concat(rt.track || []).filter((t) => t.date?.uts).map((t) => ({
      title: t.name, artist: t.artist?.['#text'] || t.artist?.name, album: t.album?.['#text'], at: Number(t.date.uts) * 1000,
    }));
    addPlays(userId, listens, job);
  }
}

async function fromListenBrainz(userId, username, job) {
  let maxTs = Math.floor(Date.now() / 1000) + 60;
  for (let i = 0; i < 5000; i++) {
    if (job.cancelled || job.fetched >= MAX_LISTENS) return;
    const r = await getJson(`https://api.listenbrainz.org/1/user/${encodeURIComponent(username)}/listens?${new URLSearchParams({ count: '1000', max_ts: String(maxTs) })}`, { timeout: 20000 });
    if (!r) throw httpError(404, 'ListenBrainz user not found');
    const listens = r.payload?.listens || [];
    if (!listens.length) return;
    addPlays(userId, listens.map((l) => ({
      title: l.track_metadata?.track_name, artist: l.track_metadata?.artist_name, album: l.track_metadata?.release_name, at: l.listened_at * 1000,
    })), job);
    maxTs = Math.min(...listens.map((l) => l.listened_at));
  }
}

function start(user, source, fn) {
  const running = jobs.get(user.id);
  if (running?.state === 'running') throw httpError(409, 'An import is already running');
  const job = { source, state: 'running', fetched: 0, matched: 0, unmatched: 0, added: 0, skipped: 0, total: null, error: null, startedAt: Date.now(), finishedAt: null };
  jobs.set(user.id, job);
  (async () => {
    try { await fn(job); job.state = job.cancelled ? 'cancelled' : 'done'; } catch (err) { job.state = 'error'; job.error = err.message; }
    job.finishedAt = Date.now();
    job.matcher = null;
    log.info(`[history] ${user.username}: ${source} import ${job.state}: ${job.added} plays added, ${job.unmatched} not in the library`);
  })();
  return job;
}

const out = (j) => j && { ...j, matcher: undefined };

export const historyApi = express.Router();

historyApi.get('/', (req, res) => res.json(out(jobs.get(req.user.id)) || { state: 'idle' }));

historyApi.post('/lastfm', (req, res, next) => {
  try {
    const name = String(req.body?.username || '').trim();
    if (!name) throw httpError(400, 'Enter your Last.fm username');
    res.json(out(start(req.user, 'Last.fm', (job) => fromLastfm(req.user.id, name, job))));
  } catch (err) { next(err); }
});

historyApi.post('/listenbrainz', (req, res, next) => {
  try {
    const name = String(req.body?.username || '').trim();
    if (!name) throw httpError(400, 'Enter your ListenBrainz username');
    res.json(out(start(req.user, 'ListenBrainz', (job) => fromListenBrainz(req.user.id, name, job))));
  } catch (err) { next(err); }
});

// Listens the browser read from a file (Spotify data export), sent in batches of up to 5000.
historyApi.post('/listens', (req, res) => {
  const list = Array.isArray(req.body?.listens) ? req.body.listens.slice(0, 5000) : [];
  const job = { fetched: 0, matched: 0, unmatched: 0, added: 0, skipped: 0 };
  addPlays(req.user.id, list.map((l) => ({ title: String(l.title || ''), artist: String(l.artist || ''), album: l.album ? String(l.album) : null, at: Number(l.at) || null })), job);
  res.json({ ...job, matcher: undefined });
});

historyApi.delete('/', (req, res) => {
  const j = jobs.get(req.user.id);
  if (j?.state === 'running') j.cancelled = true;
  res.json({ ok: true });
});

historyApi.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
