// Home, Albums, Artists, Songs, Genres views.
import { api } from '../api.js';
import { html, ic, el, greeting, plural, prefs } from '../util.js';
import { player } from '../player.js';
import { state } from '../state.js';
import { albumCard, artistCard, genreTile, trackList, emptyState, skeletonGrid } from '../components.js';

/** Calls load() whenever the sentinel scrolls into view; stops when load returns false. */
export function infinite(sentinel, load) {
  let busy = false, done = false;
  const io = new IntersectionObserver(async (entries) => {
    if (!entries[0].isIntersecting || busy || done) return;
    busy = true;
    try { done = (await load()) === false; } finally { busy = false; }
    if (done) io.disconnect();
    else if (sentinel.getBoundingClientRect().top < innerHeight + 600) { io.unobserve(sentinel); io.observe(sentinel); }
  }, { root: document.querySelector('.main'), rootMargin: '600px' });
  io.observe(sentinel);
  return () => io.disconnect();
}

const noLibrary = () => emptyState('library', 'Your library is empty',
  state.user?.isAdmin ? 'Add a music folder in Settings and Sonara will scan it for you.' : 'Ask an admin to add a music folder.',
  state.user?.isAdmin ? html`<a class="btn primary" href="/settings">${ic('folderPlus')} Add music folder</a>` : '');

// ───────── Home ─────────

export async function homeView() {
  const v = el(html`<div><h1 class="page-title"><span class="greeting">${greeting()}</span>${state.user ? `, ${state.user.username}` : ''}</h1>
    <p class="page-sub">Here's what's spinning in your library.</p><div class="home-body">${skeletonGrid(6)}</div></div>`);
  const [home, stats] = await Promise.all([api.get('/home'), api.get('/stats')]);
  const body = v.querySelector('.home-body');
  if (!stats.tracks) { body.replaceChildren(el(noLibrary())); return v; }

  const section = (title, href, inner) => html`<section class="section"><div class="section-head"><h2>${title}</h2>${href ? html`<a href="${href}">Show all</a>` : ''}</div>${inner}</section>`;
  body.innerHTML = String(html`
    <div class="actions">
      <button class="btn primary" data-shuffle-all>${ic('shuffle')} Shuffle library</button>
      <span class="muted">${plural(stats.tracks, 'song')} · ${plural(stats.albums, 'album')} · ${plural(stats.artists, 'artist')}</span>
    </div>
    ${home.recentlyPlayed.length ? section('Jump back in', null, html`<div class="recent-list"></div>`) : ''}
    ${section('Recently added', '/albums?sort=recent', html`<div class="carousel">${home.recentlyAdded.map(albumCard)}</div>`)}
    ${home.topArtists.length ? section('Your top artists', '/artists', html`<div class="carousel">${home.topArtists.map((a, i) => artistCard({ ...a, albumCount: null }, i))}</div>`) : ''}
    ${home.mostPlayed.length ? section('On repeat', null, html`<div class="most-list"></div>`) : ''}
    ${section('Discover', '/albums?sort=random', html`<div class="carousel">${home.discover.map(albumCard)}</div>`)}
  `);
  if (home.recentlyPlayed.length) body.querySelector('.recent-list').replaceWith(trackList(home.recentlyPlayed.slice(0, 6), { head: false }).el);
  if (home.mostPlayed.length) body.querySelector('.most-list').replaceWith(trackList(home.mostPlayed, { head: false }).el);
  body.querySelector('[data-shuffle-all]').addEventListener('click', async () => {
    player.playList(await api.get('/tracks/random', { limit: 300 }), 0);
  });
  return v;
}

// ───────── Albums ─────────

const ALBUM_SORTS = [['name', 'A–Z'], ['artist', 'Artist'], ['recent', 'Recently added'], ['year', 'Year'], ['random', 'Random']];

export async function albumsView({ query }) {
  const sort = query.get('sort') || prefs.get('albumSort', 'name');
  const v = el(html`<div>
    <h1 class="page-title">Albums</h1>
    <div class="toolbar"><div class="chips">${ALBUM_SORTS.map(([k, l]) => html`<a class="chip ${k === sort ? 'active' : ''}" href="/albums?sort=${k}">${l}</a>`)}</div></div>
    <div class="grid"></div><div class="sentinel"></div><div class="loader"><div class="logo-mark"><span></span><span></span><span></span><span></span><span></span></div></div>
  </div>`);
  prefs.set('albumSort', sort);
  const grid = v.querySelector('.grid');
  let offset = 0;
  const load = async () => {
    const rows = await api.get('/albums', { sort, limit: 60, offset });
    if (!offset && !rows.length) grid.replaceWith(el(noLibrary()));
    grid.insertAdjacentHTML('beforeend', rows.map((a, i) => albumCard(a, i)).join(''));
    offset += rows.length;
    if (rows.length < 60) { v.querySelector('.loader')?.remove(); return false; }
  };
  if ((await load()) !== false) v._destroy = infinite(v.querySelector('.sentinel'), load);
  return v;
}

// ───────── Artists ─────────

export async function artistsView() {
  const v = el(html`<div><h1 class="page-title">Artists</h1><p class="page-sub artists-sub"></p>
    <div class="grid"></div><div class="sentinel"></div></div>`);
  const grid = v.querySelector('.grid');
  let offset = 0;
  const load = async () => {
    const rows = await api.get('/artists', { limit: 100, offset });
    if (!offset && !rows.length) grid.replaceWith(el(noLibrary()));
    grid.insertAdjacentHTML('beforeend', rows.map((a, i) => artistCard(a, i)).join(''));
    offset += rows.length;
    if (rows.length < 100) return false;
  };
  if ((await load()) !== false) v._destroy = infinite(v.querySelector('.sentinel'), load);
  return v;
}

// ───────── Songs ─────────

const TRACK_SORTS = [['title', 'Title'], ['artist', 'Artist'], ['album', 'Album'], ['recent', 'Recently added'], ['year', 'Year']];

export async function songsView({ query }) {
  const sort = query.get('sort') || prefs.get('trackSort', 'title');
  prefs.set('trackSort', sort);
  const stats = await api.get('/stats');
  const v = el(html`<div>
    <h1 class="page-title">Songs</h1>
    <p class="page-sub">${plural(stats.tracks, 'song')}</p>
    <div class="actions">
      <button class="play-fab" data-play>${ic('play')}</button>
      <button class="btn" data-shuffle>${ic('shuffle')} Shuffle all</button>
    </div>
    <div class="toolbar"><div class="chips">${TRACK_SORTS.map(([k, l]) => html`<a class="chip ${k === sort ? 'active' : ''}" href="/songs?sort=${k}">${l}</a>`)}</div></div>
    <div class="list"></div><div class="sentinel"></div>
  </div>`);
  if (!stats.tracks) { v.querySelector('.list').replaceWith(el(noLibrary())); return v; }
  const tl = trackList([]);
  v.querySelector('.list').replaceWith(tl.el);
  let offset = 0;
  const load = async () => {
    const rows = await api.get('/tracks', { sort, limit: 150, offset });
    tl.add(rows);
    offset += rows.length;
    if (rows.length < 150) return false;
  };
  const more = (await load()) !== false;
  v.querySelector('[data-play]').addEventListener('click', () => player.playList(tl.tracks, 0));
  v.querySelector('[data-shuffle]').addEventListener('click', async () => player.playList(await api.get('/tracks/random', { limit: 500 }), 0));
  if (more) v._destroy = infinite(v.querySelector('.sentinel'), load);
  return v;
}

// ───────── Genres ─────────

export async function genresView() {
  const genres = await api.get('/genres');
  return el(html`<div><h1 class="page-title">Genres</h1><p class="page-sub">${plural(genres.length, 'genre')}</p>
    ${genres.length ? html`<div class="grid">${genres.map(genreTile)}</div>`
      : emptyState('tag', 'No genres yet', 'Genres come from your files’ tags. Tag your music and rescan to see them here.')}
  </div>`);
}

export async function genreView({ params }) {
  const albums = await api.get('/albums', { genre: params.name, sort: 'artist', limit: 500 });
  return el(html`<div><div class="eyebrow" style="margin-top:12px">Genre</div><h1 class="page-title">${params.name}</h1>
    <p class="page-sub">${plural(albums.length, 'album')}</p>
    <div class="grid">${albums.map(albumCard)}</div></div>`);
}
