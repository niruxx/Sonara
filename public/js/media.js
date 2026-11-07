// Things the player can play besides library songs: podcast episodes and
// internet radio stations. They travel through the queue as ordinary "track"
// objects with a `kind`, a string id and their own stream address.
import { html } from './util.js';
import { artistLinks } from './components.js';
import { t } from './i18n.js';

/** A song from the library (numeric id), as opposed to an episode or a station. */
export const isLibrary = (t) => !!t && typeof t.id === 'number';
export const isEpisode = (t) => t?.kind === 'episode';
export const isStation = (t) => t?.kind === 'station';

/** Episode from the API → queue item. */
export const episodeItem = (e) => ({
  id: `ep:${e.id}`,
  kind: 'episode',
  episodeId: e.id,
  podcastId: e.podcastId,
  title: e.title,
  artist: e.podcast,
  album: e.podcast,
  cover: e.cover,
  duration: e.duration || 0,
  publishedAt: e.publishedAt,
  // Where to pick up: the saved position, unless it's finished (or nearly).
  resumeAt: !e.played && e.position > 5 && (!e.duration || e.position < e.duration - 20) ? e.position : 0,
  src: `/api/podcasts/episodes/${e.id}/stream`,
});

/** Station from the API → queue item. */
export const stationItem = (s) => ({
  id: `st:${s.id}`,
  kind: 'station',
  stationId: s.id,
  live: true,
  title: s.name,
  artist: s.nowPlaying || t('Live radio'),
  album: s.name,
  cover: s.cover,
  duration: 0,
  homepage: s.homepage,
  src: `/api/stations/${s.id}/stream`,
});

/** The line under the title in the player bar and Now Playing view. */
export function subtitle(t, sep = ' · ') {
  if (isEpisode(t)) return html`<a href="/podcast/${t.podcastId}">${t.artist}</a>`;
  if (isStation(t)) return html`${t.artist}${sep}<a href="/radio">${t.album}</a>`;
  return html`${artistLinks(t)}${sep}<a href="/album/${t.albumId}">${t.album}</a>`;
}

/** Where the "Playing from …" label in Now Playing points. */
export const sourceLabel = (t) => (isEpisode(t) ? 'Podcast' : isStation(t) ? 'Internet radio' : 'Your library');
