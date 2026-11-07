// Radio / "play similar": an endless, varied queue built around a seed
// (a track, album, artist or genre) from your own library. With a Last.fm API
// key, similar artists from Last.fm are mixed in too.

import { q } from './db.js';
import { getConfig } from './config.js';
import { getJson } from './online.js';

const similarCache = new Map(); // artist name (lower) -> { at, names }
const DAY = 86400000;

async function lastfmSimilar(name) {
  const key = getConfig().lastfmApiKey;
  if (!key || !name) return [];
  const k = name.toLowerCase();
  const hit = similarCache.get(k);
  if (hit && Date.now() - hit.at < DAY) return hit.names;
  const url = `https://ws.audioscrobbler.com/2.0/?${new URLSearchParams({ method: 'artist.getsimilar', artist: name, api_key: key, format: 'json', limit: '50', autocorrect: '1' })}`;
  const r = await getJson(url, { timeout: 6000 }).catch(() => null);
  const names = (r?.similarartists?.artist || []).map((a) => ({ name: a.name, match: Number(a.match) || 0 }));
  similarCache.set(k, { at: Date.now(), names });
  return names;
}

/** Artists and genres that describe the seed. */
function describeSeed(seed) {
  const { type, id } = seed;
  let trackIds = [];
  if (type === 'track') trackIds = [Number(id)];
  else if (type === 'album') trackIds = q('SELECT id FROM tracks WHERE album_id = ?').all(String(id)).map((r) => r.id);
  else if (type === 'artist') trackIds = q('SELECT track_id AS id FROM track_artists WHERE artist_id = ?').all(String(id)).map((r) => r.id);
  else if (type === 'genre') trackIds = q('SELECT track_id AS id FROM track_genres WHERE genre = ? COLLATE NOCASE LIMIT 500').all(String(id)).map((r) => r.id);
  if (!trackIds.length) return null;
  const ids = JSON.stringify(trackIds.slice(0, 2000));
  const artists = q(`SELECT artist_id AS id, MAX(name) AS name, COUNT(*) AS n FROM track_artists
    WHERE track_id IN (SELECT value FROM json_each(?)) AND role = 'artist' GROUP BY artist_id ORDER BY n DESC LIMIT 12`).all(ids);
  const genres = type === 'genre' ? [{ genre: String(id), n: 1 }] : q(`SELECT genre, COUNT(*) AS n FROM track_genres
    WHERE track_id IN (SELECT value FROM json_each(?)) GROUP BY genre ORDER BY n DESC LIMIT 6`).all(ids);
  const years = q(`SELECT AVG(year) AS y FROM tracks WHERE id IN (SELECT value FROM json_each(?)) AND year > 0`).get(ids).y;
  return { trackIds, artists, genres, year: years ? Math.round(years) : null };
}

/**
 * Track ids for a radio station. seed: { type: 'track'|'album'|'artist'|'genre', id }.
 * exclude: ids already queued. Returns up to `limit` ids, best first, varied.
 */
export async function radioTrackIds(userId, seed, { limit = 50, exclude = [] } = {}) {
  const d = describeSeed(seed);
  if (!d) return [];
  const seedArtistIds = new Set(d.artists.map((a) => a.id));
  // Artists that appear on the same albums as the seed artists (features, collaborators).
  const related = q(`SELECT DISTINCT ta2.artist_id AS id FROM track_artists ta
    JOIN tracks t ON t.id = ta.track_id JOIN tracks t2 ON t2.album_id = t.album_id
    JOIN track_artists ta2 ON ta2.track_id = t2.id AND ta2.role = 'artist'
    WHERE ta.artist_id IN (SELECT value FROM json_each(?)) LIMIT 200`).all(JSON.stringify([...seedArtistIds])).map((r) => r.id);
  const relatedIds = new Set(related.filter((x) => !seedArtistIds.has(x)));

  // Last.fm similar artists, matched to artists in this library by name.
  const similar = new Map();
  for (const a of d.artists.slice(0, 3)) {
    for (const s of await lastfmSimilar(a.name)) {
      const local = q(`SELECT artist_id FROM track_artists WHERE name = ? COLLATE NOCASE LIMIT 1`).get(s.name);
      if (local && !seedArtistIds.has(local.artist_id)) similar.set(local.artist_id, Math.max(similar.get(local.artist_id) || 0, s.match));
    }
  }

  const genreList = d.genres.map((g) => g.genre);
  const artistPool = [...seedArtistIds, ...relatedIds, ...similar.keys()];
  const rows = q(`SELECT t.id, t.album_id AS albumId, t.year, t.artist_id AS artistId, (f.track_id IS NOT NULL) AS fav,
      COALESCE(r.rating, 0) AS rating, pc.last AS lastPlayed, pc.n AS plays,
      (SELECT group_concat(artist_id, '|') FROM track_artists WHERE track_id = t.id AND role = 'artist') AS artistIds,
      (SELECT group_concat(genre, '|') FROM track_genres WHERE track_id = t.id) AS genres
    FROM tracks t
    LEFT JOIN favorites f ON f.track_id = t.id AND f.user_id = $uid
    LEFT JOIN ratings r ON r.track_id = t.id AND r.user_id = $uid
    LEFT JOIN (SELECT track_id, COUNT(*) AS n, MAX(played_at) AS last FROM plays WHERE user_id = $uid GROUP BY track_id) pc ON pc.track_id = t.id
    WHERE t.id IN (SELECT track_id FROM track_artists WHERE artist_id IN (SELECT value FROM json_each($artists)))
       OR t.id IN (SELECT track_id FROM track_genres WHERE genre IN (SELECT value FROM json_each($genres)))
    ORDER BY RANDOM() LIMIT 5000`).all({ uid: userId, artists: JSON.stringify(artistPool), genres: JSON.stringify(genreList) });

  const skip = new Set([...exclude.map(Number), ...(seed.type === 'track' ? [Number(seed.id)] : [])]);
  const now = Date.now();
  const scored = [];
  for (const t of rows) {
    if (skip.has(t.id)) continue;
    const aIds = (t.artistIds || t.artistId || '').split('|');
    const gs = (t.genres || '').split('|').filter(Boolean);
    let s = 0;
    if (aIds.some((a) => seedArtistIds.has(a))) s += seed.type === 'artist' ? 3 : 2.2;
    if (aIds.some((a) => relatedIds.has(a))) s += 1.6;
    const sim = Math.max(0, ...aIds.map((a) => similar.get(a) || 0));
    if (sim) s += 1 + sim * 2;
    s += gs.filter((g) => genreList.includes(g)).length * 1.1;
    if (d.year && t.year) s += Math.max(0, 1 - Math.abs(t.year - d.year) / 15) * 0.8;
    if (t.fav) s += 0.8;
    s += t.rating * 0.25;
    // Don't replay what you just heard.
    if (t.lastPlayed && now - t.lastPlayed < 3 * 3600000) s -= 3;
    else if (t.lastPlayed && now - t.lastPlayed < DAY) s -= 1;
    s += Math.random() * 1.5; // variety
    scored.push({ ...t, aIds, s });
  }
  scored.sort((a, b) => b.s - a.s);

  // Spread things out: at most 2 songs per artist and 1 per album in each stretch of 10.
  const out = [];
  const pool = scored.slice(0, limit * 6);
  while (out.length < limit && pool.length) {
    const recent = out.slice(-10);
    const i = pool.findIndex((t) => recent.filter((x) => x.aIds[0] === t.aIds[0]).length < 2 && !recent.some((x) => x.albumId === t.albumId));
    out.push(pool.splice(i >= 0 ? i : 0, 1)[0]);
  }
  // Small libraries: top up with anything not played recently.
  if (out.length < Math.min(limit, 15)) {
    const have = new Set([...out.map((t) => t.id), ...skip]);
    const extra = q(`SELECT id FROM tracks ORDER BY RANDOM() LIMIT ?`).all(limit * 2).map((r) => r.id).filter((id) => !have.has(id));
    return [...out.map((t) => t.id), ...extra].slice(0, limit);
  }
  return out.map((t) => t.id);
}
