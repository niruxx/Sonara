// Online metadata (opt-in): artist bios and photos, and cover art for albums
// that have none.
//
// Artists: MusicBrainz finds the artist → Wikidata → Wikipedia summary + image.
// With keys, fanart.tv supplies better artist photos and Last.fm a bio fallback.
// Covers: Cover Art Archive, by MusicBrainz release id (from tags) or by search.

import { q } from './db.js';
import { getConfig } from './config.js';
import { getJson, getBuffer } from './online.js';
import { saveCover } from './scanner.js';
import { log } from './logger.js';

const DAY = 86400000;
const FRESH_MS = 60 * DAY;
const MISS_MS = 14 * DAY;
const MB = 'https://musicbrainz.org/ws/2';

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const luceneEsc = (s) => String(s).replace(/([+\-!(){}[\]^"~*?:\\/]|&&|\|\|)/g, '\\$1');

async function saveImage(url) {
  const img = await getBuffer(url, { timeout: 15000 }).catch(() => null);
  if (!img?.data?.length || !/image\//.test(img.type) || img.data.length > 15e6) return null;
  return saveCover(img.data, img.type);
}

// ───────── Artists ─────────

async function findArtistMbid(name, hint) {
  if (hint) return hint;
  const r = await getJson(`${MB}/artist/?${new URLSearchParams({ query: `artist:"${luceneEsc(name)}"`, fmt: 'json', limit: '5' })}`);
  const want = norm(name);
  const hit = (r?.artists || []).find((a) => a.score >= 90 && (norm(a.name) === want || (a.aliases || []).some((x) => norm(x.name) === want)));
  return hit?.id || null;
}

async function wikipediaFor(mbid) {
  const a = await getJson(`${MB}/artist/${mbid}?inc=url-rels&fmt=json`);
  const rels = a?.relations || [];
  let title = null, lang = 'en';
  const wd = rels.find((r) => r.type === 'wikidata')?.url?.resource?.match(/(Q\d+)/)?.[1];
  if (wd) {
    const e = await getJson(`https://www.wikidata.org/wiki/Special:EntityData/${wd}.json`);
    const links = e?.entities?.[wd]?.sitelinks || {};
    const pick = links.enwiki ? ['en', links.enwiki] : Object.entries(links).find(([k]) => /^[a-z]{2,3}wiki$/.test(k))?.map((x, i) => (i === 0 ? x.slice(0, -4) : x));
    if (pick) { lang = pick[0]; title = pick[1].title; }
  }
  if (!title) {
    const wp = rels.find((r) => r.type === 'wikipedia')?.url?.resource?.match(/https?:\/\/(\w+)\.wikipedia\.org\/wiki\/(.+)$/);
    if (wp) { lang = wp[1]; title = decodeURIComponent(wp[2]); }
  }
  if (!title) return null;
  const s = await getJson(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`);
  if (!s?.extract || s.type === 'disambiguation') return null;
  return { bio: s.extract, url: s.content_urls?.desktop?.page || null, image: s.originalimage?.source || s.thumbnail?.source || null };
}

async function fanartImage(mbid) {
  const key = getConfig().fanartApiKey;
  if (!key) return null;
  const r = await getJson(`https://webservice.fanart.tv/v3/music/${mbid}?api_key=${encodeURIComponent(key)}`).catch(() => null);
  const best = (r?.artistthumb || []).sort((a, b) => Number(b.likes) - Number(a.likes))[0];
  return best?.url || null;
}

async function lastfmBio(name) {
  const key = getConfig().lastfmApiKey;
  if (!key) return null;
  const r = await getJson(`https://ws.audioscrobbler.com/2.0/?${new URLSearchParams({ method: 'artist.getinfo', artist: name, api_key: key, format: 'json', autocorrect: '1' })}`).catch(() => null);
  const text = r?.artist?.bio?.content || r?.artist?.bio?.summary;
  if (!text) return null;
  // Strip Last.fm's "Read more on Last.fm" link and the license footer.
  const clean = text.replace(/<a [^>]*>.*?<\/a>\.?/gs, '').replace(/User-contributed text is available.*$/s, '').replace(/<[^>]+>/g, '').trim();
  return clean ? { bio: clean, url: r.artist.url } : null;
}

const pending = new Map();

/** Cached artist info, fetching it (once at a time) when enabled and stale. */
export async function artistInfo(artistId, name, { refresh = false } = {}) {
  const row = q('SELECT * FROM artist_info WHERE artist_id = ?').get(artistId);
  const age = row ? Date.now() - row.fetched_at : Infinity;
  const usable = row && (row.bio || row.image);
  if (!getConfig().onlineArtistInfo) return usable ? row : null;
  if (!refresh && row && (usable ? age < FRESH_MS : age < MISS_MS)) return usable ? row : null;
  if (pending.has(artistId)) return pending.get(artistId);
  const job = (async () => {
    const hint = q(`SELECT mbz_artist_id FROM tracks WHERE artist_id = ? AND mbz_artist_id IS NOT NULL LIMIT 1`).get(artistId)?.mbz_artist_id;
    const info = { mbid: null, bio: null, bio_source: null, url: null, image: row?.image || null };
    try {
      info.mbid = await findArtistMbid(name, hint);
      if (info.mbid) {
        const wiki = await wikipediaFor(info.mbid).catch((e) => { log.warn(`[metadata] Wikipedia ${name}: ${e.message}`); return null; });
        if (wiki) Object.assign(info, { bio: wiki.bio, bio_source: 'Wikipedia', url: wiki.url });
        const photo = (await fanartImage(info.mbid)) || wiki?.image;
        if (photo) info.image = (await saveImage(photo)) || info.image;
      }
      if (!info.bio) {
        const lf = await lastfmBio(name);
        if (lf) Object.assign(info, { bio: lf.bio, bio_source: 'Last.fm', url: lf.url });
      }
    } catch (err) {
      log.warn(`[metadata] ${name}: ${err.message}`);
      if (row) return usable ? row : null; // keep what we had; try again later
    }
    q(`INSERT INTO artist_info (artist_id, name, mbid, bio, bio_source, url, image, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(artist_id) DO UPDATE SET name = excluded.name, mbid = excluded.mbid, bio = excluded.bio, bio_source = excluded.bio_source,
      url = excluded.url, image = excluded.image, fetched_at = excluded.fetched_at`)
      .run(artistId, name, info.mbid, info.bio, info.bio_source, info.url, info.image, Date.now());
    return q('SELECT * FROM artist_info WHERE artist_id = ?').get(artistId);
  })().finally(() => pending.delete(artistId));
  pending.set(artistId, job);
  return job;
}

// ───────── Missing cover art ─────────

const coverJob = { running: false, checked: 0, found: 0, total: 0, startedAt: null, finishedAt: null };
export const coverStatus = () => ({ ...coverJob });

async function coverFor(album) {
  const tryRelease = async (id, group = false) => saveImage(`https://coverartarchive.org/${group ? 'release-group' : 'release'}/${id}/front-500`);
  if (album.mbid) {
    const c = await tryRelease(album.mbid);
    if (c) return c;
  }
  if (!album.artist || /^unknown/i.test(album.name)) return null;
  const query = `releasegroup:"${luceneEsc(album.name)}" AND artist:"${luceneEsc(album.artist === 'Various Artists' ? '' : album.artist)}"`.replace(' AND artist:""', '');
  const r = await getJson(`${MB}/release-group/?${new URLSearchParams({ query, fmt: 'json', limit: '5' })}`);
  const want = norm(album.name);
  for (const g of (r?.['release-groups'] || []).filter((x) => x.score >= 90 && norm(x.title) === want)) {
    const c = await tryRelease(g.id, true);
    if (c) return c;
  }
  return null;
}

/** Look up art for albums without a cover. `all` retries albums tried before. */
export async function findMissingCovers({ all = false } = {}) {
  if (coverJob.running || !getConfig().onlineCovers) return false;
  const albums = q(`SELECT t.album_id AS id, MAX(t.album) AS name, MAX(t.album_artist) AS artist, MAX(t.mbz_album_id) AS mbid
    FROM tracks t LEFT JOIN cover_lookups cl ON cl.album_id = t.album_id
    GROUP BY t.album_id HAVING MAX(t.cover) IS NULL ${all ? '' : 'AND MAX(cl.tried_at) IS NULL'}`).all();
  Object.assign(coverJob, { running: true, checked: 0, found: 0, total: albums.length, startedAt: Date.now(), finishedAt: null });
  try {
    for (const a of albums) {
      let cover = null;
      try { cover = await coverFor(a); } catch (err) {
        // Service trouble (rate limit, outage): don't remember this album as "tried".
        log.warn(`[covers] ${a.name}: ${err.message}`);
        coverJob.checked++;
        continue;
      }
      if (cover) {
        q('UPDATE tracks SET cover = ?, updated_at = ? WHERE album_id = ? AND cover IS NULL').run(cover, Date.now(), a.id);
        coverJob.found++;
      }
      q(`INSERT INTO cover_lookups (album_id, tried_at, found, cover) VALUES (?, ?, ?, ?)
        ON CONFLICT(album_id) DO UPDATE SET tried_at = excluded.tried_at, found = excluded.found, cover = excluded.cover`).run(a.id, Date.now(), cover ? 1 : 0, cover);
      coverJob.checked++;
    }
  } finally {
    coverJob.running = false;
    coverJob.finishedAt = Date.now();
    if (albums.length) log.info(`[covers] Checked ${albums.length} album(s), found ${coverJob.found} cover(s)`);
  }
  return true;
}
