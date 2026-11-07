// Podcasts: RSS/Atom subscriptions, episode lists, per-user resume positions,
// server-side downloads and OPML import/export. No extra dependency: feeds are
// read with a small tolerant parser that understands RSS 2.0 (with the iTunes
// tags) and Atom.
//
// Feeds are shared: two people subscribing to the same feed share one row and
// one set of downloads, but each has their own subscriptions and progress.

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { q, tx } from './db.js';
import { PODCASTS_DIR, getConfig } from './config.js';
import { requireAdmin } from './auth.js';
import { saveCover } from './scanner.js';
import { openUrl, fetchText, fetchImage, cleanUrl } from './net.js';
import { getJson } from './online.js';
import { log } from './logger.js';

const httpError = (status, message) => Object.assign(new Error(message), { status });
const h = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (err) {
    if (!err.status) log.error('[podcasts]', err);
    if (!res.headersSent) res.status(err.status || 500).json({ error: err.message || 'Something went wrong' });
  }
};
const int = (v, def = 0) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? n : def; };

// ───────────────────────── Feed parsing ─────────────────────────

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', mdash: '—', ndash: '–', copy: '©', reg: '®', trade: '™', eacute: 'é', egrave: 'è', aacute: 'á', oacute: 'ó', uacute: 'ú', iacute: 'í', ntilde: 'ñ', uuml: 'ü', ouml: 'ö', auml: 'ä', szlig: 'ß', ccedil: 'ç' };
export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(cp); } catch { return m; }
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

/** Text content of an XML fragment: CDATA kept as is, everything else entity-decoded. */
function xmlText(raw) {
  if (raw == null) return '';
  return String(raw).split(/(<!\[CDATA\[[\s\S]*?\]\]>)/).map((part) => (part.startsWith('<![CDATA[') ? part.slice(9, -3) : decodeEntities(part))).join('').trim();
}

/** Show-notes are HTML: turn them into plain text with paragraph breaks. */
export function htmlToText(s, max = 6000) {
  return decodeEntities(String(s)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote)>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function tag(block, name) {
  const m = block.match(new RegExp(`<${reEsc(name)}(?:\\s[^>]*)?>([\\s\\S]*?)</${reEsc(name)}>`, 'i'));
  return m ? xmlText(m[1]) : '';
}
function attr(block, name, attrName) {
  const m = block.match(new RegExp(`<${reEsc(name)}\\b[^>]*?\\s${reEsc(attrName)}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  return m ? decodeEntities(m[2] ?? m[3] ?? '').trim() : '';
}
/** Drop nested elements whose own children would confuse a flat search (e.g. <image> inside <item>). */
const without = (block, ...names) => names.reduce((b, n) => b.replace(new RegExp(`<${reEsc(n)}[\\s>][\\s\\S]*?</${reEsc(n)}>`, 'gi'), ''), block);

export function parseDuration(s) {
  s = String(s || '').trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const parts = s.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

const parseDate = (s) => { const t = Date.parse(String(s || '').trim()); return Number.isFinite(t) ? t : null; };

export function parseFeed(xml) {
  xml = String(xml).replace(/^﻿/, '');
  const atom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const itemRe = atom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi;
  const first = xml.search(atom ? /<entry[\s>]/i : /<item[\s>]/i);
  const head = first >= 0 ? xml.slice(0, first) : xml;
  if (!atom && !/<(rss|channel)[\s>]/i.test(xml)) throw httpError(400, "That address isn't a podcast feed (no RSS or Atom found)");

  const channel = without(head, 'item', 'entry');
  const imageBlock = (channel.match(/<image[\s>][\s\S]*?<\/image>/i) || [''])[0];
  const feed = {
    title: tag(without(channel, 'image'), 'title') || 'Untitled podcast',
    author: tag(channel, 'itunes:author') || tag(channel, 'managingEditor') || tag(without(channel, 'image'), 'name') || '',
    description: htmlToText(tag(channel, 'itunes:summary') || tag(channel, 'description') || tag(channel, 'subtitle') || ''),
    link: atom ? attr(channel, 'link', 'href') : tag(without(channel, 'image', 'atom:link'), 'link'),
    imageUrl: attr(channel, 'itunes:image', 'href') || tag(imageBlock, 'url') || tag(channel, 'logo') || tag(channel, 'icon') || '',
    items: [],
  };

  for (const m of xml.matchAll(itemRe)) {
    const it = m[0];
    let audioUrl = '', mime = '', size = null;
    if (atom) {
      const enc = it.match(/<link\b[^>]*\brel\s*=\s*["']enclosure["'][^>]*>/i)?.[0] || '';
      audioUrl = attr(enc, 'link', 'href'); mime = attr(enc, 'link', 'type'); size = int(attr(enc, 'link', 'length'), null);
    } else {
      audioUrl = attr(it, 'enclosure', 'url'); mime = attr(it, 'enclosure', 'type'); size = int(attr(it, 'enclosure', 'length'), null);
      if (!audioUrl) audioUrl = attr(it, 'media:content', 'url');
    }
    if (!audioUrl) continue;
    // Video podcasts still play as audio in an <audio> element, but plain documents don't.
    if (mime && !/^(audio|video)\//i.test(mime) && !/octet-stream|x-m4a|mpeg/i.test(mime)) continue;
    const title = tag(without(it, 'image'), 'title') || 'Untitled episode';
    // Podcasting 2.0 chapters / transcripts (best transcript format first), Podlove inline chapters.
    const transcripts = [...it.matchAll(/<podcast:transcript\b[^>]*>/gi)].map((t) => ({ url: attr(t[0], 'podcast:transcript', 'url'), type: attr(t[0], 'podcast:transcript', 'type').toLowerCase() }))
      .filter((t) => t.url);
    const rank = (type) => ['text/vtt', 'application/x-subrip', 'application/srt', 'text/srt', 'application/json'].indexOf(type);
    transcripts.sort((a, b) => (rank(a.type) < 0 ? 99 : rank(a.type)) - (rank(b.type) < 0 ? 99 : rank(b.type)));
    const inline = [...it.matchAll(/<psc:chapter\b[^>]*>/gi)].map((c) => ({ start: parseDuration(attr(c[0], 'psc:chapter', 'start')), title: attr(c[0], 'psc:chapter', 'title') }))
      .filter((c) => c.start != null && c.title);
    const guid = tag(it, 'guid') || tag(it, 'id') || audioUrl;
    const publishedAt = parseDate(tag(it, 'pubDate') || tag(it, 'published') || tag(it, 'updated') || tag(it, 'dc:date'));
    feed.items.push({
      guid: guid.slice(0, 500),
      title: title.slice(0, 500),
      description: htmlToText(tag(it, 'content:encoded') || tag(it, 'description') || tag(it, 'itunes:summary') || tag(it, 'summary') || tag(it, 'content') || ''),
      publishedAt,
      duration: parseDuration(tag(it, 'itunes:duration')),
      audioUrl: decodeEntities(audioUrl),
      mime: mime || null,
      size: size > 0 ? size : null,
      season: int(tag(it, 'itunes:season'), null),
      episode: int(tag(it, 'itunes:episode'), null),
      chaptersUrl: attr(it, 'podcast:chapters', 'url') || null,
      chapters: inline.length ? inline.slice(0, 500) : null,
      transcriptUrl: transcripts[0]?.url || null,
      transcriptType: transcripts[0]?.type || null,
    });
  }
  return feed;
}

// ───────────────────────── Feeds in the database ─────────────────────────

const MAX_EPISODES = 3000;
const refreshing = new Map(); // podcast id -> Promise

async function storeImage(p, imageUrl) {
  if (!imageUrl || (imageUrl === p.image_url && p.image)) return;
  const img = await fetchImage(imageUrl, { allowPrivate: !!p.trusted });
  const cover = img ? saveCover(img.data, img.type) : null;
  q('UPDATE podcasts SET image = ?, image_url = ? WHERE id = ?').run(cover || p.image || null, imageUrl, p.id);
}

function storeFeed(p, feed) {
  const now = Date.now();
  tx(() => {
    q(`UPDATE podcasts SET title = ?, author = ?, description = ?, link = ?, last_checked = ?, last_error = NULL WHERE id = ?`)
      .run(feed.title.slice(0, 300), feed.author.slice(0, 300), feed.description, feed.link || null, now, p.id);
    const up = q(`INSERT INTO podcast_episodes (podcast_id, guid, title, description, published_at, duration, audio_url, mime, size, season, episode,
        chapters, chapters_url, transcript_url, transcript_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(podcast_id, guid) DO UPDATE SET title = excluded.title, description = excluded.description,
        published_at = COALESCE(excluded.published_at, published_at), duration = COALESCE(excluded.duration, duration),
        audio_url = excluded.audio_url, mime = excluded.mime, size = COALESCE(excluded.size, size),
        season = excluded.season, episode = excluded.episode, chapters = excluded.chapters, chapters_url = excluded.chapters_url,
        transcript_url = excluded.transcript_url, transcript_type = excluded.transcript_type`);
    for (const it of feed.items.slice(0, MAX_EPISODES)) {
      up.run(p.id, it.guid, it.title, it.description, it.publishedAt, it.duration, it.audioUrl, it.mime, it.size, it.season, it.episode,
        it.chapters ? JSON.stringify(it.chapters) : null, it.chaptersUrl, it.transcriptUrl, it.transcriptType);
    }
  });
}

/** Re-read a feed. Resolves when done; errors are stored on the podcast and rethrown. */
export function refreshPodcast(id, { force = false } = {}) {
  if (refreshing.has(id)) return refreshing.get(id);
  const job = (async () => {
    const p = q('SELECT * FROM podcasts WHERE id = ?').get(id);
    if (!p) throw httpError(404, 'Podcast not found');
    try {
      const headers = {};
      if (!force && p.etag) headers['If-None-Match'] = p.etag;
      if (!force && p.last_modified) headers['If-Modified-Since'] = p.last_modified;
      const r = await fetchText(p.feed_url, { headers, allowPrivate: !!p.trusted, accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5' });
      if (r.status === 304) {
        q('UPDATE podcasts SET last_checked = ?, last_error = NULL WHERE id = ?').run(Date.now(), id);
      } else {
        const feed = parseFeed(r.text);
        storeFeed(p, feed);
        q('UPDATE podcasts SET etag = ?, last_modified = ? WHERE id = ?').run(r.headers.etag || null, r.headers['last-modified'] || null, id);
        await storeImage(p, feed.imageUrl).catch(() => {});
      }
      autoDownload(id);
    } catch (err) {
      q('UPDATE podcasts SET last_checked = ?, last_error = ? WHERE id = ?').run(Date.now(), String(err.message).slice(0, 300), id);
      throw err;
    }
  })().finally(() => refreshing.delete(id));
  refreshing.set(id, job);
  return job;
}

async function addPodcast(input, user) {
  const url = cleanUrl(input).href;
  let p = q('SELECT * FROM podcasts WHERE feed_url = ?').get(url);
  if (!p) {
    // Read it first, so a typo doesn't leave an empty podcast behind.
    const r = await fetchText(url, { allowPrivate: !!user.is_admin, accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5' });
    const feed = parseFeed(r.text);
    // The feed may have moved: store where it actually lives.
    const finalUrl = r.url.href;
    p = q('SELECT * FROM podcasts WHERE feed_url = ?').get(finalUrl);
    if (!p) {
      const { lastInsertRowid } = q(`INSERT INTO podcasts (feed_url, title, trusted, created_at) VALUES (?, ?, ?, ?)`)
        .run(finalUrl, feed.title, user.is_admin ? 1 : 0, Date.now());
      p = q('SELECT * FROM podcasts WHERE id = ?').get(Number(lastInsertRowid));
      storeFeed(p, feed);
      q('UPDATE podcasts SET etag = ?, last_modified = ? WHERE id = ?').run(r.headers.etag || null, r.headers['last-modified'] || null, p.id);
      await storeImage(p, feed.imageUrl).catch(() => {});
      log.info(`[podcasts] ${user.username} added “${feed.title}” (${feed.items.length} episodes)`);
    }
  }
  q('INSERT OR IGNORE INTO podcast_subscriptions (user_id, podcast_id, created_at) VALUES (?, ?, ?)').run(user.id, p.id, Date.now());
  return p.id;
}

/** Feeds nobody follows any more are removed, downloads included. */
function removeIfOrphan(id) {
  if (q('SELECT 1 FROM podcast_subscriptions WHERE podcast_id = ? LIMIT 1').get(id)) return;
  q('DELETE FROM podcasts WHERE id = ?').run(id);
  fs.rmSync(path.join(PODCASTS_DIR, String(id)), { recursive: true, force: true });
}

let refreshTimer = null;
export function schedulePodcastRefresh() {
  clearInterval(refreshTimer);
  const run = async () => {
    const hours = Number(getConfig().podcastRefreshHours);
    if (!(hours > 0)) return;
    const due = q('SELECT id FROM podcasts WHERE last_checked IS NULL OR last_checked < ? ORDER BY last_checked LIMIT 50').all(Date.now() - hours * 3600000);
    for (const { id } of due) await refreshPodcast(id).catch((err) => log.warn(`[podcasts] Could not refresh feed ${id}: ${err.message}`));
  };
  refreshTimer = setInterval(run, 15 * 60000);
  refreshTimer.unref?.();
  setTimeout(run, 60000).unref?.();
}

// ───────────────────────── Downloads ─────────────────────────

const downloads = new Map(); // episode id -> { received, total, error }
const queue = [];
let downloading = false;

const EXT = { 'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/aac': '.aac', 'audio/ogg': '.ogg', 'audio/opus': '.opus', 'audio/wav': '.wav', 'video/mp4': '.mp4' };
const extFor = (ep) => EXT[String(ep.mime || '').toLowerCase()] || (path.extname(new URL(ep.audio_url).pathname).toLowerCase().match(/^\.(mp3|m4a|aac|ogg|opus|wav|mp4|m4b)$/)?.[0]) || '.mp3';
const filePath = (ep) => (ep.file ? path.join(PODCASTS_DIR, ep.file) : null);

export function queueDownload(episodeId) {
  if (downloads.has(episodeId)) return;
  downloads.set(episodeId, { received: 0, total: 0 });
  queue.push(episodeId);
  pump();
}

async function pump() {
  if (downloading) return;
  downloading = true;
  try {
    while (queue.length) {
      const id = queue.shift();
      const state = downloads.get(id);
      try {
        await downloadEpisode(id, state);
        downloads.delete(id);
      } catch (err) {
        log.warn(`[podcasts] Download of episode ${id} failed: ${err.message}`);
        state.error = err.message;
        setTimeout(() => { if (downloads.get(id) === state) downloads.delete(id); }, 60000).unref?.();
      }
    }
  } finally { downloading = false; }
}

async function downloadEpisode(id, state) {
  const ep = q('SELECT e.*, p.trusted FROM podcast_episodes e JOIN podcasts p ON p.id = e.podcast_id WHERE e.id = ?').get(id);
  if (!ep) throw httpError(404, 'Episode not found');
  if (ep.file && fs.existsSync(filePath(ep))) return;
  const limit = (Number(getConfig().podcastDownloadMB) || 1024) * 1024 * 1024;
  const { res } = await openUrl(ep.audio_url, { allowPrivate: !!ep.trusted, timeout: 30000 });
  state.total = Number(res.headers['content-length']) || ep.size || 0;
  if (state.total > limit) { res.destroy(); throw httpError(413, 'This episode is larger than the download limit'); }
  const rel = path.join(String(ep.podcast_id), `${id}${extFor(ep)}`);
  const dest = path.join(PODCASTS_DIR, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  res.on('data', (c) => {
    state.received += c.length;
    if (state.received > limit) res.destroy(httpError(413, 'This episode is larger than the download limit'));
  });
  try {
    await pipeline(res, fs.createWriteStream(tmp));
    fs.renameSync(tmp, dest);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  q('UPDATE podcast_episodes SET file = ?, file_size = ? WHERE id = ?').run(rel, fs.statSync(dest).size, id);
}

function deleteDownload(ep) {
  const f = filePath(ep);
  if (f) fs.rmSync(f, { force: true });
  q('UPDATE podcast_episodes SET file = NULL, file_size = NULL WHERE id = ?').run(ep.id);
}

function autoDownload(podcastId) {
  const p = q('SELECT auto_download FROM podcasts WHERE id = ?').get(podcastId);
  if (!p?.auto_download) return;
  const newest = q(`SELECT id, file FROM podcast_episodes WHERE podcast_id = ? ORDER BY published_at DESC, id DESC LIMIT ?`).all(podcastId, p.auto_download);
  for (const ep of newest) if (!ep.file) queueDownload(ep.id);
}

// ───────────────────────── Output shapes ─────────────────────────

const EPISODE_COLS = `e.id, e.podcast_id AS podcastId, p.title AS podcast, p.author, p.image AS cover, e.title, e.description,
  e.published_at AS publishedAt, e.duration, e.mime, e.size, e.season, e.episode, e.file IS NOT NULL AS downloaded, e.file_size AS fileSize,
  (e.chapters IS NOT NULL OR e.chapters_url IS NOT NULL) AS hasChapters, e.transcript_url IS NOT NULL AS hasTranscript,
  COALESCE(pp.position, 0) AS position, COALESCE(pp.played, 0) AS played, pp.updated_at AS progressAt`;
const EPISODE_FROM = `FROM podcast_episodes e JOIN podcasts p ON p.id = e.podcast_id
  LEFT JOIN podcast_progress pp ON pp.episode_id = e.id AND pp.user_id = ?`;

const episodeOut = (e) => {
  const d = downloads.get(e.id);
  return { ...e, downloaded: !!e.downloaded, played: !!e.played, hasChapters: !!e.hasChapters, hasTranscript: !!e.hasTranscript, downloading: d ? { received: d.received, total: d.total, error: d.error || null } : null };
};

const PODCAST_COLS = `p.id, p.title, p.author, p.description, p.link, p.image AS cover, p.feed_url AS feedUrl, p.last_checked AS lastChecked,
  p.last_error AS lastError, p.auto_download AS autoDownload,
  (SELECT COUNT(*) FROM podcast_episodes e WHERE e.podcast_id = p.id) AS episodeCount,
  (SELECT COUNT(*) FROM podcast_episodes e LEFT JOIN podcast_progress pp ON pp.episode_id = e.id AND pp.user_id = ?
     WHERE e.podcast_id = p.id AND COALESCE(pp.played, 0) = 0) AS unplayed,
  (SELECT MAX(published_at) FROM podcast_episodes e WHERE e.podcast_id = p.id) AS latestAt`;

const subscribed = (uid, id) => !!q('SELECT 1 FROM podcast_subscriptions WHERE user_id = ? AND podcast_id = ?').get(uid, id);

// ───────────────────────── OPML ─────────────────────────

const xmlEsc = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

function opmlFeeds(text) {
  const urls = [];
  for (const m of String(text).matchAll(/<outline\b[^>]*>/gi)) {
    const u = attr(m[0], 'outline', 'xmlUrl');
    if (u) urls.push(u);
  }
  return [...new Set(urls)];
}

// ───────────────────────── Routes ─────────────────────────

export const podcastsApi = express.Router();

podcastsApi.get('/', (req, res) => {
  const rows = q(`SELECT ${PODCAST_COLS} FROM podcasts p JOIN podcast_subscriptions s ON s.podcast_id = p.id AND s.user_id = ?
    ORDER BY latestAt DESC`).all(req.user.id, req.user.id);
  res.json({ podcasts: rows, directory: !!getConfig().onlinePodcastDirectory, refreshHours: Number(getConfig().podcastRefreshHours) || 0 });
});

podcastsApi.post('/', h(async (req, res) => {
  const id = await addPodcast(req.body?.url, req.user);
  res.json(q(`SELECT ${PODCAST_COLS} FROM podcasts p WHERE p.id = ?`).get(req.user.id, id));
}));

// Apple Podcasts directory search (opt-in).
podcastsApi.get('/search', h(async (req, res) => {
  if (!getConfig().onlinePodcastDirectory) throw httpError(403, 'Podcast search is turned off. An admin can enable it in Settings → Online services.');
  const term = String(req.query.q || '').trim().slice(0, 200);
  if (!term) return res.json([]);
  const r = await getJson(`https://itunes.apple.com/search?${new URLSearchParams({ media: 'podcast', entity: 'podcast', term, limit: '30' })}`);
  const mine = new Set(q('SELECT p.feed_url AS u FROM podcasts p JOIN podcast_subscriptions s ON s.podcast_id = p.id WHERE s.user_id = ?').all(req.user.id).map((x) => x.u));
  res.json((r?.results || []).filter((x) => x.feedUrl).map((x) => ({
    title: x.collectionName || x.trackName, author: x.artistName || '', feedUrl: x.feedUrl,
    image: x.artworkUrl600 || x.artworkUrl100 || null, genre: x.primaryGenreName || '', episodes: x.trackCount || null,
    subscribed: mine.has(x.feedUrl),
  })));
}));

podcastsApi.get('/opml', (req, res) => {
  const rows = q('SELECT p.title, p.feed_url, p.link FROM podcasts p JOIN podcast_subscriptions s ON s.podcast_id = p.id WHERE s.user_id = ? ORDER BY p.title COLLATE NOCASE').all(req.user.id);
  res.type('text/x-opml').set('Content-Disposition', 'attachment; filename="sonara-podcasts.opml"').send(`<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>Sonara podcasts</title><dateCreated>${new Date().toUTCString()}</dateCreated></head>
  <body>
${rows.map((p) => `    <outline type="rss" text="${xmlEsc(p.title)}" title="${xmlEsc(p.title)}" xmlUrl="${xmlEsc(p.feed_url)}"${p.link ? ` htmlUrl="${xmlEsc(p.link)}"` : ''}/>`).join('\n')}
  </body>
</opml>
`);
});

podcastsApi.post('/opml', express.json({ limit: '5mb' }), h(async (req, res) => {
  const urls = opmlFeeds(req.body?.text).slice(0, 500);
  if (!urls.length) throw httpError(400, 'No podcast feeds found in that file');
  const out = { added: 0, failed: [] };
  for (const u of urls) {
    try { await addPodcast(u, req.user); out.added++; } catch (err) { out.failed.push({ url: u, error: err.message }); }
  }
  res.json(out);
}));

// Newest episodes across everything you follow.
podcastsApi.get('/episodes/latest', (req, res) => {
  const limit = Math.min(100, Math.max(1, int(req.query.limit, 30)));
  const rows = q(`SELECT ${EPISODE_COLS} ${EPISODE_FROM} JOIN podcast_subscriptions s ON s.podcast_id = e.podcast_id AND s.user_id = ?
    ORDER BY e.published_at DESC, e.id DESC LIMIT ?`).all(req.user.id, req.user.id, limit);
  res.json(rows.map(episodeOut));
});

// Started but not finished.
podcastsApi.get('/episodes/continue', (req, res) => {
  const rows = q(`SELECT ${EPISODE_COLS} ${EPISODE_FROM} WHERE pp.position > 5 AND pp.played = 0 ORDER BY pp.updated_at DESC LIMIT 20`).all(req.user.id);
  res.json(rows.map(episodeOut));
});

const episodeFor = (req) => {
  const ep = q('SELECT e.*, p.trusted FROM podcast_episodes e JOIN podcasts p ON p.id = e.podcast_id WHERE e.id = ?').get(int(req.params.id));
  if (!ep) throw httpError(404, 'Episode not found');
  return ep;
};

podcastsApi.get('/episodes/:id', h(async (req, res) => {
  const row = q(`SELECT ${EPISODE_COLS} ${EPISODE_FROM} WHERE e.id = ?`).get(req.user.id, int(req.params.id));
  if (!row) throw httpError(404, 'Episode not found');
  res.json(episodeOut(row));
}));

// Stream an episode: the downloaded copy if there is one, otherwise passed through
// from the podcast's host (same origin for the browser, so the EQ and visualizer work).
podcastsApi.get('/episodes/:id/stream', h(async (req, res) => {
  const ep = episodeFor(req);
  const f = filePath(ep);
  if (f && fs.existsSync(f)) {
    return res.sendFile(f, ep.mime && /^(audio|video)\//.test(ep.mime) ? { headers: { 'Content-Type': ep.mime } } : {});
  }
  const headers = {};
  if (req.headers.range) headers.Range = req.headers.range;
  const { res: up } = await openUrl(ep.audio_url, { headers, allowPrivate: !!ep.trusted, timeout: 20000 });
  let type = String(up.headers['content-type'] || '');
  if (!/^(audio|video)\//i.test(type)) type = ep.mime && /^(audio|video)\//i.test(ep.mime) ? ep.mime : 'audio/mpeg';
  res.status(up.statusCode === 206 ? 206 : 200);
  res.set('Content-Type', type);
  for (const k of ['content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) if (up.headers[k]) res.set(k, up.headers[k]);
  if (!up.headers['accept-ranges'] && up.statusCode === 206) res.set('Accept-Ranges', 'bytes');
  res.set('Cache-Control', 'no-store');
  res.on('close', () => up.destroy());
  up.on('error', () => res.destroy());
  up.pipe(res);
}));

// ── Chapters and transcripts (fetched from the podcast's host on first use, then cached)

const sideCache = new Map(); // `${kind}:${id}` -> { at, data }
function cached(key, fn) {
  const hit = sideCache.get(key);
  if (hit && Date.now() - hit.at < 6 * 3600000) return hit.data;
  const data = fn();
  sideCache.set(key, { at: Date.now(), data });
  if (sideCache.size > 200) sideCache.delete(sideCache.keys().next().value);
  data.catch?.(() => sideCache.delete(key));
  return data;
}

const tsec = (s) => {
  const m = String(s).trim().replace(',', '.').match(/^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
  return m ? (Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3])) : null;
};

/** WebVTT / SRT / Podcast Index JSON transcripts → [{ t, end, text, speaker }]. */
export function parseTranscript(text, type = '') {
  const body = String(text).replace(/^\uFEFF/, '');
  if (type.includes('json') || /^\s*\{/.test(body)) {
    const j = JSON.parse(body);
    return (j.segments || []).map((s) => ({ t: Number(s.startTime) || 0, end: Number(s.endTime) || null, text: String(s.body || '').trim(), speaker: s.speaker || null })).filter((c) => c.text);
  }
  const cues = [];
  for (const block of body.split(/\r?\n\r?\n+/)) {
    const lines = block.split(/\r?\n/).filter((l) => l.trim());
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->');
    const start = tsec(a), end = tsec(b.split(/\s/).filter(Boolean)[0]);
    if (start == null) continue;
    let textLines = lines.slice(i + 1).join(' ');
    let speaker = null;
    const v = textLines.match(/<v\s+([^>]+)>/);
    if (v) speaker = v[1].trim();
    textLines = textLines.replace(/<[^>]+>/g, '').trim();
    if (textLines) cues.push({ t: start, end, text: decodeEntities(textLines), speaker });
  }
  // Many transcripts split sentences into tiny cues: merge neighbours into readable lines.
  const merged = [];
  for (const c of cues) {
    const last = merged[merged.length - 1];
    if (last && last.speaker === c.speaker && last.text.length < 90 && !/[.!?]$/.test(last.text)) { last.text += ` ${c.text}`; last.end = c.end; } else merged.push({ ...c });
  }
  return merged.slice(0, 20000);
}

podcastsApi.get('/episodes/:id/chapters', h(async (req, res) => {
  const ep = episodeFor(req);
  if (ep.chapters) return res.json(JSON.parse(ep.chapters));
  if (!ep.chapters_url) return res.json([]);
  const list = await cached(`ch:${ep.id}`, async () => {
    const r = await fetchText(ep.chapters_url, { allowPrivate: !!ep.trusted, limit: 2 * 1024 * 1024, accept: 'application/json+chapters, application/json' });
    const j = JSON.parse(r.text);
    return (j.chapters || []).filter((c) => c.toc !== false && Number.isFinite(Number(c.startTime)))
      .map((c) => ({ start: Number(c.startTime), title: String(c.title || '').slice(0, 200), url: /^https?:/.test(c.url || '') ? c.url : null })).slice(0, 500);
  });
  res.json(list);
}));

podcastsApi.get('/episodes/:id/transcript', h(async (req, res) => {
  const ep = episodeFor(req);
  if (!ep.transcript_url) return res.json({ found: false });
  const cues = await cached(`tr:${ep.id}`, async () => {
    const r = await fetchText(ep.transcript_url, { allowPrivate: !!ep.trusted, limit: 8 * 1024 * 1024 });
    return parseTranscript(r.text, ep.transcript_type || String(r.headers['content-type'] || ''));
  });
  res.json({ found: cues.length > 0, cues });
}));

podcastsApi.put('/episodes/:id/progress', (req, res) => {
  const id = int(req.params.id);
  if (!q('SELECT 1 FROM podcast_episodes WHERE id = ?').get(id)) return res.status(404).json({ error: 'Episode not found' });
  const b = req.body || {};
  const position = Math.max(0, Number(b.position) || 0);
  const played = b.played ? 1 : 0;
  q(`INSERT INTO podcast_progress (user_id, episode_id, position, played, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, episode_id) DO UPDATE SET position = excluded.position, played = excluded.played, updated_at = excluded.updated_at`)
    .run(req.user.id, id, played ? 0 : position, played, Date.now());
  res.json({ ok: true });
});

podcastsApi.post('/episodes/:id/download', h(async (req, res) => {
  const ep = episodeFor(req);
  if (!subscribed(req.user.id, ep.podcast_id) && !req.user.is_admin) throw httpError(403, 'Subscribe to this podcast first');
  if (!ep.file) queueDownload(ep.id);
  res.json({ ok: true });
}));

podcastsApi.delete('/episodes/:id/download', requireAdmin, h(async (req, res) => {
  deleteDownload(episodeFor(req));
  res.json({ ok: true });
}));

podcastsApi.get('/:id', h(async (req, res) => {
  const id = int(req.params.id);
  const p = q(`SELECT ${PODCAST_COLS} FROM podcasts p WHERE p.id = ?`).get(req.user.id, id);
  if (!p) throw httpError(404, 'Podcast not found');
  const episodes = q(`SELECT ${EPISODE_COLS} ${EPISODE_FROM} WHERE e.podcast_id = ? ORDER BY e.published_at DESC, e.id DESC`).all(req.user.id, id);
  res.json({ ...p, subscribed: subscribed(req.user.id, id), episodes: episodes.map(episodeOut) });
}));

podcastsApi.post('/:id/subscribe', h(async (req, res) => {
  const id = int(req.params.id);
  if (!q('SELECT 1 FROM podcasts WHERE id = ?').get(id)) throw httpError(404, 'Podcast not found');
  q('INSERT OR IGNORE INTO podcast_subscriptions (user_id, podcast_id, created_at) VALUES (?, ?, ?)').run(req.user.id, id, Date.now());
  res.json({ ok: true });
}));

podcastsApi.delete('/:id', (req, res) => {
  const id = int(req.params.id);
  q('DELETE FROM podcast_subscriptions WHERE user_id = ? AND podcast_id = ?').run(req.user.id, id);
  q('DELETE FROM podcast_progress WHERE user_id = ? AND episode_id IN (SELECT id FROM podcast_episodes WHERE podcast_id = ?)').run(req.user.id, id);
  removeIfOrphan(id);
  res.json({ ok: true });
});

podcastsApi.post('/:id/refresh', h(async (req, res) => {
  const id = int(req.params.id);
  if (!subscribed(req.user.id, id) && !req.user.is_admin) throw httpError(403, 'Subscribe to this podcast first');
  await refreshPodcast(id, { force: true });
  res.json({ ok: true });
}));

podcastsApi.post('/:id/played', (req, res) => {
  const id = int(req.params.id);
  const played = req.body?.played !== false ? 1 : 0;
  const now = Date.now();
  q(`INSERT INTO podcast_progress (user_id, episode_id, position, played, updated_at)
    SELECT ?, id, 0, ?, ? FROM podcast_episodes WHERE podcast_id = ?
    ON CONFLICT(user_id, episode_id) DO UPDATE SET position = 0, played = excluded.played, updated_at = excluded.updated_at`).run(req.user.id, played, now, id);
  res.json({ ok: true });
});

podcastsApi.put('/:id/settings', requireAdmin, (req, res) => {
  const id = int(req.params.id);
  const n = Math.min(50, Math.max(0, int(req.body?.autoDownload, 0)));
  q('UPDATE podcasts SET auto_download = ? WHERE id = ?').run(n, id);
  autoDownload(id);
  res.json({ ok: true });
});
