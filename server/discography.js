// Discographies from MusicBrainz: albums and EPs by artists in your library
// that you don't have, and recent or upcoming releases. Off until an admin turns
// on "onlineDiscography". MusicBrainz allows one request a second; online.js
// spaces requests out, and results are cached for two weeks.

import express from 'express';
import { q } from './db.js';
import { getConfig } from './config.js';
import { getJson } from './online.js';
import { log } from './logger.js';

const DAY = 86400000;
const STALE = 14 * DAY;
const MB = 'https://musicbrainz.org/ws/2';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const enabled = () => !!getConfig().onlineDiscography;
/** Titles compared loosely: no case, accents, punctuation or "(Deluxe Edition)"-style suffixes. */
export const normTitle = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[([{][^)\]}]*(edition|remaster|deluxe|version|expanded|anniversary|bonus|mono|stereo|reissue)[^)\]}]*[)\]}]/g, '')
  .replace(/&/g, 'and').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

async function findMbid(artistId) {
  const tagged = q(`SELECT mbz_artist_id AS m FROM tracks WHERE album_artist_id = ? AND mbz_artist_id IS NOT NULL AND mbz_artist_id != '' LIMIT 1`).get(artistId)?.m;
  const fromTag = String(tagged || '').match(UUID)?.[0];
  if (fromTag) return fromTag;
  const name = q('SELECT album_artist AS n FROM tracks WHERE album_artist_id = ? LIMIT 1').get(artistId)?.n;
  if (!name) return null;
  const r = await getJson(`${MB}/artist?${new URLSearchParams({ query: `artist:"${name.replace(/"/g, '')}"`, fmt: 'json', limit: '3' })}`);
  const best = (r?.artists || []).find((a) => a.score >= 95 && normTitle(a.name) === normTitle(name));
  return best?.id || null;
}

/** Fetch (or reuse) an artist's albums and EPs from MusicBrainz. */
export async function discography(artistId, { force = false } = {}) {
  const row = q('SELECT * FROM artist_discography WHERE artist_id = ?').get(artistId);
  if (row && !force && Date.now() - row.fetched_at < STALE) return { ...row, data: row.data ? JSON.parse(row.data) : [] };
  const name = q('SELECT album_artist AS n FROM tracks WHERE album_artist_id = ? LIMIT 1').get(artistId)?.n;
  if (!name) return null;
  const mbid = row?.mbid || await findMbid(artistId);
  let data = [];
  if (mbid) {
    for (let offset = 0; offset < 300; offset += 100) {
      const r = await getJson(`${MB}/release-group?${new URLSearchParams({ artist: mbid, type: 'album|ep', fmt: 'json', limit: '100', offset: String(offset) })}`);
      const groups = r?.['release-groups'] || [];
      for (const g of groups) {
        // Studio albums and EPs only: no compilations, live albums, remixes, demos…
        if (g['secondary-types']?.length) continue;
        data.push({ id: g.id, title: g.title, type: g['primary-type'] || 'Album', date: g['first-release-date'] || null });
      }
      if (groups.length < 100) break;
    }
  }
  data.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  q(`INSERT INTO artist_discography (artist_id, name, mbid, data, fetched_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(artist_id) DO UPDATE SET name = excluded.name, mbid = excluded.mbid, data = excluded.data, fetched_at = excluded.fetched_at`)
    .run(artistId, name, mbid, JSON.stringify(data), Date.now());
  return { artist_id: artistId, name, mbid, data, fetched_at: Date.now() };
}

function ownedTitles(artistId) {
  return new Set(q('SELECT DISTINCT album FROM tracks WHERE album_artist_id = ?').all(artistId).map((r) => normTitle(r.album)));
}

const withCover = (g) => ({ ...g, cover: `https://coverartarchive.org/release-group/${g.id}/front-250`, url: `https://musicbrainz.org/release-group/${g.id}` });

// Refresh a few stale discographies in the background (artists you play most first).
let timer = null;
export function scheduleDiscography() {
  clearInterval(timer);
  const run = async () => {
    if (!enabled()) return;
    const due = q(`SELECT t.album_artist_id AS id, COUNT(*) AS n FROM tracks t
      LEFT JOIN artist_discography d ON d.artist_id = t.album_artist_id
      WHERE t.compilation = 0 AND (d.fetched_at IS NULL OR d.fetched_at < ?)
      GROUP BY t.album_artist_id HAVING n >= 3 ORDER BY n DESC LIMIT 25`).all(Date.now() - STALE);
    for (const { id } of due) await discography(id).catch((err) => log.warn(`[discography] ${id}: ${err.message}`));
  };
  timer = setInterval(run, 6 * 3600000);
  timer.unref?.();
  setTimeout(run, 5 * 60000).unref?.();
}

export const discographyApi = express.Router();

discographyApi.get('/artists/:id/discography', async (req, res) => {
  if (!enabled()) return res.json({ enabled: false });
  try {
    const d = await discography(String(req.params.id), { force: req.query.refresh === '1' });
    if (!d) return res.status(404).json({ error: 'Artist not found' });
    const owned = ownedTitles(d.artist_id);
    const today = new Date().toISOString().slice(0, 10);
    const missing = d.data.filter((g) => !owned.has(normTitle(g.title))).map((g) => ({ ...withCover(g), upcoming: !!g.date && g.date > today }));
    res.json({ enabled: true, found: !!d.mbid, total: d.data.length, owned: d.data.length - missing.length, missing, fetchedAt: d.fetched_at });
  } catch (err) {
    res.status(502).json({ error: `MusicBrainz: ${err.message}` });
  }
});

// Releases from the last 120 days (and announced ones) by artists you have, that you don't own yet.
discographyApi.get('/discography/new', (req, res) => {
  if (!enabled()) return res.json({ enabled: false, releases: [] });
  const since = new Date(Date.now() - 120 * DAY).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const out = [];
  for (const d of q('SELECT * FROM artist_discography WHERE data IS NOT NULL').all()) {
    // Respect folder access: only artists this listener can see.
    if (!q('SELECT 1 FROM tracks WHERE album_artist_id = ? LIMIT 1').get(d.artist_id)) continue;
    const owned = ownedTitles(d.artist_id);
    for (const g of JSON.parse(d.data)) {
      if (!g.date || g.date < since || owned.has(normTitle(g.title))) continue;
      out.push({ ...withCover(g), artist: d.name, artistId: d.artist_id, upcoming: g.date > today });
    }
  }
  out.sort((a, b) => (a.upcoming === b.upcoming ? b.date.localeCompare(a.date) : a.upcoming ? 1 : -1));
  res.json({ enabled: true, releases: out.slice(0, 40) });
});
