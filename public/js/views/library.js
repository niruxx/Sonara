// Home, Albums, Artists, Songs, Genres views.
import { api } from '../api.js';
import { html, ic, el, art, greeting, plural, prefs } from '../util.js';
import { player } from '../player.js';
import { state } from '../state.js';
import { navigate } from '../router.js';
import { organizeDialog } from '../fileops.js';
import { albumCard, artistCard, genreTile, trackList, emptyState, skeletonGrid } from '../components.js';
import { t, locale } from '../i18n.js';

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

const noLibrary = () => emptyState('library', t('Your library is empty'),
  state.user?.isAdmin ? t('Add a music folder in Settings and Sonara will scan it for you.') : t('Ask an admin to add a music folder.'),
  state.user?.isAdmin ? html`<a class="btn primary" href="/settings">${ic('folderPlus')} ${t('Add music folder')}</a>` : '');

// ───────── Home ─────────

export async function homeView() {
  const v = el(html`<div><h1 class="page-title"><span class="greeting">${greeting()}</span>${state.user ? `, ${state.user.username}` : ''}</h1>
    <p class="page-sub">${t("Here's what's spinning in your library.")}</p><div class="home-body">${skeletonGrid(6)}</div></div>`);
  const [home, stats] = await Promise.all([api.get('/home'), api.get('/stats')]);
  const body = v.querySelector('.home-body');
  if (!stats.tracks) { body.replaceChildren(el(noLibrary())); return v; }

  const section = (title, href, inner) => html`<section class="section"><div class="section-head"><h2>${t(title)}</h2>${href ? html`<a href="${href}">${t('Show all')}</a>` : ''}</div>${inner}</section>`;
  body.innerHTML = String(html`
    <div class="actions">
      <button class="btn primary" data-shuffle-all>${ic('shuffle')} ${t('Shuffle library')}</button>
      <span class="muted">${plural(stats.tracks, 'song')} · ${plural(stats.albums, 'album')} · ${plural(stats.artists, 'artist')}</span>
    </div>
    ${home.continueListening?.length ? section('Continue listening', null, html`<div class="carousel">${home.continueListening.map((a, i) => html`
      <a class="card" href="/album/${a.id}" style="--i:${i}">
        <div class="card-art">${art(a.cover, a.name)}
          <button class="card-play" data-resume="${a.id}" data-at="${a.resumeIndex}" aria-label="${t('Resume {title}', { title: a.name })}">${ic('play')}</button>
          <div class="card-progress"><i style="width:${Math.round(a.progress * 100)}%"></i></div></div>
        <div class="card-title" title="${a.name}">${a.name}</div>
        <div class="card-sub">${t('Song {n} of {total}', { n: a.resumeIndex + 1, total: a.trackCount })} · ${a.artist}</div>
      </a>`)}</div>`) : ''}
    ${home.recentlyPlayed.length ? section('Jump back in', null, html`<div class="recent-list"></div>`) : ''}
    ${home.onThisDay?.length ? section(`On this day`, null, html`<p class="muted section-note">${t('What you were listening to on {date} in years past.', { date: new Date().toLocaleDateString(locale(), { month: 'long', day: 'numeric' }) })}</p><div class="otd-list"></div>`) : ''}
    ${home.recentAlbums?.length ? section('Recently played albums', '/albums?sort=lastPlayed', html`<div class="carousel">${home.recentAlbums.map(albumCard)}</div>`) : ''}
    ${section('Recently added', '/albums?sort=recent', html`<div class="carousel">${home.recentlyAdded.map(albumCard)}</div>`)}
    ${home.topArtists.length ? section('Your top artists', '/artists', html`<div class="carousel">${home.topArtists.map((a, i) => artistCard({ ...a, albumCount: null }, i))}</div>`) : ''}
    ${home.mostPlayed.length ? section('On repeat', null, html`<div class="most-list"></div>`) : ''}
    ${home.rediscover?.length ? section('Rediscover', null, html`<p class="muted section-note">${t("Songs you loved but haven't played in a while.")}</p><div class="rediscover-list"></div>`) : ''}
    ${section('Discover', '/albums?sort=random', html`<div class="carousel">${home.discover.map(albumCard)}</div>`)}
  `);
  if (home.recentlyPlayed.length) body.querySelector('.recent-list').replaceWith(trackList(home.recentlyPlayed.slice(0, 6), { head: false }).el);
  if (home.mostPlayed.length) body.querySelector('.most-list').replaceWith(trackList(home.mostPlayed, { head: false }).el);
  if (home.onThisDay?.length) body.querySelector('.otd-list').replaceWith(trackList(home.onThisDay.slice(0, 6), { head: false }).el);
  if (home.rediscover?.length) body.querySelector('.rediscover-list').replaceWith(trackList(home.rediscover.slice(0, 6), { head: false }).el);
  body.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-resume]');
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    const a = await api.get(`/albums/${b.dataset.resume}`);
    player.playList(a.tracks, Number(b.dataset.at));
  }, true);
  body.querySelector('[data-shuffle-all]').addEventListener('click', async () => {
    player.playList(await api.get('/tracks/random', { limit: 300 }), 0);
  });
  return v;
}

// ───────── Albums ─────────

const ALBUM_SORTS = [['name', 'A–Z'], ['artist', 'Artist'], ['recent', 'Recently added'], ['lastPlayed', 'Recently played'],
  ['played', 'Most played'], ['rating', 'Top rated'], ['year', 'Newest'], ['oldest', 'Oldest'], ['random', 'Random']];
const ALBUM_TYPES = [['', 'All'], ['album', 'Albums'], ['ep', 'EPs'], ['single', 'Singles'], ['compilation', 'Compilations'], ['live', 'Live'], ['soundtrack', 'Soundtracks']];

/** Build a URL from the current query with some keys changed (null/'' removes them). */
const withQuery = (path, query, patch) => {
  const p = new URLSearchParams(query);
  for (const [k, v] of Object.entries(patch)) (v == null || v === '' ? p.delete(k) : p.set(k, v));
  const s = p.toString();
  return s ? `${path}?${s}` : path;
};

/** Year-range inputs that navigate on change. */
function yearFilter(v, path, query) {
  const box = v.querySelector('.year-filter');
  if (!box) return;
  box.addEventListener('change', () => {
    const [from, to] = [...box.querySelectorAll('input')].map((i) => i.value.trim());
    navigate(withQuery(path, query, { yearFrom: from, yearTo: to }), { replace: true });
  });
  box.querySelector('[data-clear-years]')?.addEventListener('click', () => navigate(withQuery(path, query, { yearFrom: null, yearTo: null }), { replace: true }));
}

const yearInputs = (query, years) => html`<div class="year-filter">
  ${ic('clock')}<input class="input sm" type="number" placeholder="${years?.min || 'From'}" value="${query.get('yearFrom') || ''}" min="0" max="9999" aria-label="From year">
  <span class="muted">–</span><input class="input sm" type="number" placeholder="${years?.max || 'To'}" value="${query.get('yearTo') || ''}" min="0" max="9999" aria-label="To year">
  ${query.get('yearFrom') || query.get('yearTo') ? html`<button class="icon-btn sm" data-clear-years aria-label="Clear years">${ic('x')}</button>` : ''}
</div>`;

export async function albumsView({ query }) {
  const sort = query.get('sort') || prefs.get('albumSort', 'name');
  const type = query.get('type') || '';
  const facets = await api.get('/albums/facets').catch(() => null);
  const present = new Set((facets?.types || []).map((t) => t.type));
  const types = ALBUM_TYPES.filter(([k]) => !k || present.has(k));
  const v = el(html`<div>
    <h1 class="page-title">${t('Albums')}</h1>
    <div class="toolbar"><div class="chips">${ALBUM_SORTS.map(([k, l]) => html`<a class="chip ${k === sort ? 'active' : ''}" href="${withQuery('/albums', query, { sort: k })}">${t(l)}</a>`)}</div></div>
    <div class="toolbar">
      ${types.length > 2 ? html`<div class="chips">${types.map(([k, l]) => html`<a class="chip ${k === type ? 'active' : ''}" href="${withQuery('/albums', query, { type: k })}">${t(l)}</a>`)}</div>` : ''}
      ${yearInputs(query, facets?.years)}
    </div>
    <div class="grid"></div><div class="sentinel"></div><div class="loader"><div class="logo-mark"><span></span><span></span><span></span><span></span><span></span></div></div>
  </div>`);
  prefs.set('albumSort', sort);
  yearFilter(v, '/albums', query);
  const grid = v.querySelector('.grid');
  const filtered = type || query.get('yearFrom') || query.get('yearTo') || ['played', 'lastPlayed', 'rating'].includes(sort);
  let offset = 0;
  const load = async () => {
    const rows = await api.get('/albums', { sort, type, yearFrom: query.get('yearFrom'), yearTo: query.get('yearTo'), limit: 60, offset });
    if (!offset && !rows.length) {
      grid.replaceWith(el(filtered
        ? emptyState('disc', 'No albums match', sort === 'played' || sort === 'lastPlayed' ? 'Play some music and it will show up here.' : sort === 'rating' ? 'Rate songs from their ⋯ menu to see your top albums.' : 'Try a different filter.')
        : noLibrary()));
    }
    grid.insertAdjacentHTML('beforeend', rows.map((a, i) => albumCard(a, i)).join(''));
    offset += rows.length;
    if (rows.length < 60) { v.querySelector('.loader')?.remove(); return false; }
  };
  if ((await load()) !== false) v._destroy = infinite(v.querySelector('.sentinel'), load);
  return v;
}

// ───────── Artists ─────────

export async function artistsView() {
  const v = el(html`<div><h1 class="page-title">${t('Artists')}</h1><p class="page-sub artists-sub"></p>
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

const TRACK_SORTS = [['title', 'Title'], ['artist', 'Artist'], ['album', 'Album'], ['recent', 'Recently added'],
  ['lastPlayed', 'Recently played'], ['played', 'Most played'], ['rating', 'Top rated'], ['year', 'Year'], ['duration', 'Longest']];

export async function songsView({ query }) {
  const sort = query.get('sort') || prefs.get('trackSort', 'title');
  prefs.set('trackSort', sort);
  const filters = {
    sort, genre: query.get('genre'), yearFrom: query.get('yearFrom'), yearTo: query.get('yearTo'),
    minRating: query.get('minRating'), favorites: query.get('favorites'),
  };
  const [stats, count, genres] = await Promise.all([api.get('/stats'), api.get('/tracks/count', filters), api.get('/genres').catch(() => [])]);
  const minRating = Number(query.get('minRating') || 0);
  const v = el(html`<div>
    <h1 class="page-title">${t('Songs')}</h1>
    <p class="page-sub">${plural(count.n, 'song')}${count.n !== stats.tracks ? ` of ${stats.tracks.toLocaleString()}` : ''}</p>
    <div class="actions">
      <button class="play-fab" data-play>${ic('play')}</button>
      <button class="btn" data-shuffle>${ic('shuffle')} Shuffle${count.n !== stats.tracks ? '' : ' all'}</button>
    </div>
    <div class="toolbar"><div class="chips">${TRACK_SORTS.map(([k, l]) => html`<a class="chip ${k === sort ? 'active' : ''}" href="${withQuery('/songs', query, { sort: k })}">${l}</a>`)}</div></div>
    <div class="toolbar">
      <div class="chips">
        <a class="chip ${query.get('favorites') ? 'active' : ''}" href="${withQuery('/songs', query, { favorites: query.get('favorites') ? null : '1' })}">${ic('heart')} Favorites</a>
        ${[3, 4, 5].map((n) => html`<a class="chip ${minRating === n ? 'active' : ''}" href="${withQuery('/songs', query, { minRating: minRating === n ? null : n })}">${'★'.repeat(n)}${n < 5 ? '+' : ''}</a>`)}
      </div>
      ${genres.length ? html`<select class="input sm" data-genre aria-label="Genre"><option value="">All genres</option>
        ${genres.map((g) => html`<option value="${g.name}" ${g.name === query.get('genre') ? 'selected' : ''}>${g.name}</option>`)}</select>` : ''}
      ${yearInputs(query)}
    </div>
    <div class="list"></div><div class="sentinel"></div>
  </div>`);
  yearFilter(v, '/songs', query);
  v.querySelector('[data-genre]')?.addEventListener('change', (e) => navigate(withQuery('/songs', query, { genre: e.target.value }), { replace: true }));
  if (!stats.tracks) { v.querySelector('.list').replaceWith(el(noLibrary())); return v; }
  if (!count.n) { v.querySelector('.list').replaceWith(el(emptyState('music', 'No songs match', 'Try removing a filter.'))); return v; }
  const tl = trackList([]);
  v.querySelector('.list').replaceWith(tl.el);
  let offset = 0;
  const load = async () => {
    const rows = await api.get('/tracks', { ...filters, limit: 150, offset });
    tl.add(rows);
    offset += rows.length;
    if (rows.length < 150) return false;
  };
  const more = (await load()) !== false;
  const isFiltered = count.n !== stats.tracks;
  v.querySelector('[data-play]').addEventListener('click', () => player.playList(tl.tracks, 0));
  v.querySelector('[data-shuffle]').addEventListener('click', async () => {
    if (!isFiltered) return player.playList(await api.get('/tracks/random', { limit: 500 }), 0);
    const all = count.n <= tl.tracks.length ? tl.tracks : await api.get('/tracks', { ...filters, limit: 500, offset: 0 });
    player.playList(all, 0, { shuffle: true });
  });
  if (more) v._destroy = infinite(v.querySelector('.sentinel'), load);
  return v;
}

// ───────── Genres ─────────

export async function genresView() {
  const genres = await api.get('/genres');
  return el(html`<div><h1 class="page-title">${t('Genres')}</h1><p class="page-sub">${plural(genres.length, 'genre')}</p>
    ${genres.length ? html`<div class="grid">${genres.map(genreTile)}</div>`
      : emptyState('tag', 'No genres yet', 'Genres come from your files’ tags. Tag your music and rescan to see them here.')}
  </div>`);
}

export async function genreView({ params }) {
  const albums = await api.get('/albums', { genre: params.name, sort: 'artist', limit: 500 });
  const v = el(html`<div><div class="eyebrow" style="margin-top:12px">${t('Genre')}</div><h1 class="page-title">${params.name}</h1>
    <p class="page-sub">${plural(albums.length, 'album')}</p>
    <div class="actions">
      <button class="play-fab" data-play aria-label="Play">${ic('play')}</button>
      <button class="btn" data-radio>${ic('radio')} ${params.name} radio</button>
      ${state.user.isAdmin ? html`<button class="btn" data-organize>${ic('folder')} Organize files…</button>` : ''}
    </div>
    <div class="grid">${albums.map(albumCard)}</div></div>`);
  v.querySelector('[data-play]').addEventListener('click', async () => player.playList(await api.get('/tracks', { genre: params.name, sort: 'album', limit: 500 }), 0, { shuffle: true }));
  v.querySelector('[data-radio]').addEventListener('click', () => player.startRadio(`genre:${params.name}`, params.name));
  v.querySelector('[data-organize]')?.addEventListener('click', () => organizeDialog({ type: 'genre', id: params.name, name: params.name }));
  return v;
}
