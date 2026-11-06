// Album, Artist, Playlist, Favorites and Search views.
import { api } from '../api.js';
import { html, ic, el, art, plural, fmtLong, debounce } from '../util.js';
import { player } from '../player.js';
import { state, refreshPlaylists, createPlaylist } from '../state.js';
import { navigate } from '../router.js';
import { toast, toastError, confirmDialog, formDialog, openMenu } from '../ui.js';
import { albumCard, artistCard, playlistCard, trackList, emptyState, playlistArt, playlistPicker } from '../components.js';
import { setPalette } from '../theme.js';

const dot = html`<span class="dot"></span>`;

// ───────── Album ─────────

export async function albumView({ params }) {
  const a = await api.get(`/albums/${params.id}`);
  setPalette(a.cover);
  const lossless = a.tracks.some((t) => t.lossless);
  const v = el(html`<div>
    <header class="hero">
      <div class="hero-art">${art(a.cover, a.name)}</div>
      <div class="hero-info">
        <div class="eyebrow">Album${lossless ? ' · Lossless' : ''}</div>
        <h1 class="hero-title">${a.name}</h1>
        <div class="hero-meta"><a href="/artist/${a.artistId}">${a.artist}</a>
          ${a.year ? html`${dot}<span>${a.year}</span>` : ''}${dot}<span>${plural(a.trackCount, 'song')}, ${fmtLong(a.duration)}</span>
          ${a.genre ? html`${dot}<a href="/genre/${encodeURIComponent(a.genre)}" style="font-weight:550">${a.genre}</a>` : ''}
        </div>
      </div>
    </header>
    <div class="actions">
      <button class="play-fab" data-play aria-label="Play">${ic('play')}</button>
      <button class="icon-btn lg" data-shuffle aria-label="Shuffle">${ic('shuffle')}</button>
      <button class="icon-btn lg" data-more aria-label="More">${ic('more')}</button>
    </div>
    <div class="tracks"></div>
    ${a.more.length ? html`<section class="section"><div class="section-head"><h2>More by ${a.artist}</h2><a href="/artist/${a.artistId}">Show all</a></div>
      <div class="carousel">${a.more.map(albumCard)}</div></section>` : ''}
  </div>`);
  v.querySelector('.tracks').replaceWith(trackList(a.tracks, { cover: false, album: false, numbered: true, discs: true }).el);
  v.querySelector('[data-play]').addEventListener('click', () => player.playList(a.tracks, 0));
  v.querySelector('[data-shuffle]').addEventListener('click', () => player.playList(a.tracks, 0, { shuffle: true }));
  v.querySelector('[data-more]').addEventListener('click', (e) => openMenu(e.currentTarget, [
    { icon: 'playNext', label: 'Play next', action: () => player.playNext(a.tracks) },
    { icon: 'addQueue', label: 'Add to queue', action: () => player.addToQueue(a.tracks) },
    { icon: 'list', label: 'Add to playlist…', action: () => playlistPicker(e.target, a.tracks) },
    'sep',
    { icon: 'mic', label: 'Go to artist', action: () => navigate(`/artist/${a.artistId}`) },
  ]));
  return v;
}

// ───────── Artist ─────────

export async function artistView({ params }) {
  const a = await api.get(`/artists/${params.id}`);
  setPalette(a.cover);
  const v = el(html`<div>
    <header class="hero artist">
      <div class="hero-art">${art(a.cover, a.name, 'artist')}</div>
      <div class="hero-info">
        <div class="eyebrow">Artist</div>
        <h1 class="hero-title">${a.name}</h1>
        <div class="hero-meta"><span>${plural(a.albums.length, 'album')}</span>${dot}<span>${plural(a.trackCount, 'song')}</span>${dot}<span>${fmtLong(a.duration)}</span></div>
      </div>
    </header>
    <div class="actions">
      <button class="play-fab" data-play aria-label="Play">${ic('play')}</button>
      <button class="btn" data-shuffle>${ic('shuffle')} Shuffle</button>
    </div>
    ${a.topTracks.length ? html`<section class="section"><div class="section-head"><h2>Popular</h2></div><div class="top"></div></section>` : ''}
    ${a.albums.length ? html`<section class="section"><div class="section-head"><h2>Discography</h2></div><div class="grid">${a.albums.map(albumCard)}</div></section>` : ''}
    ${a.appearsOn.length ? html`<section class="section"><div class="section-head"><h2>Appears on</h2></div><div class="carousel">${a.appearsOn.map(albumCard)}</div></section>` : ''}
  </div>`);
  if (a.topTracks.length) v.querySelector('.top').replaceWith(trackList(a.topTracks, { head: false }).el);
  const all = () => api.get(`/artists/${params.id}/tracks`);
  v.querySelector('[data-play]').addEventListener('click', async () => player.playList(await all(), 0));
  v.querySelector('[data-shuffle]').addEventListener('click', async () => player.playList(await all(), 0, { shuffle: true }));
  return v;
}

// ───────── Playlists ─────────

export async function playlistsView() {
  await refreshPlaylists();
  const v = el(html`<div>
    <h1 class="page-title">Playlists</h1><p class="page-sub">${plural(state.playlists.length, 'playlist')}</p>
    <div class="actions"><button class="btn primary" data-new>${ic('plus')} New playlist</button></div>
    ${state.playlists.length ? html`<div class="grid">
        <a class="card" href="/favorites" style="--i:0"><div class="card-art"><div class="ph" style="--h1:320;--h2:270">${ic('heartFill')}</div></div>
          <div class="card-title">Favorites</div><div class="card-sub">Songs you love</div></a>
        ${state.playlists.map((p, i) => playlistCard(p, i + 1))}</div>`
      : emptyState('listMusic', 'No playlists yet', 'Create one here, or right-click any song and choose “Add to playlist”.')}
  </div>`);
  v.querySelector('[data-new]').addEventListener('click', async () => {
    const pl = await createPlaylist();
    if (pl) navigate(`/playlist/${pl.id}`);
  });
  return v;
}

export async function playlistView({ params }) {
  const pl = await api.get(`/playlists/${params.id}`);
  setPalette(pl.covers[0]);
  const v = el(html`<div>
    <header class="hero">
      ${playlistArt(pl)}
      <div class="hero-info">
        <div class="eyebrow">Playlist</div>
        <h1 class="hero-title">${pl.name}</h1>
        <div class="hero-meta"><span>${state.user.username}</span>${dot}<span class="pl-count">${plural(pl.trackCount, 'song')}, ${fmtLong(pl.duration)}</span></div>
        ${pl.description ? html`<p class="hero-desc">${pl.description}</p>` : ''}
      </div>
    </header>
    <div class="actions">
      <button class="play-fab" data-play aria-label="Play">${ic('play')}</button>
      <button class="icon-btn lg" data-shuffle aria-label="Shuffle">${ic('shuffle')}</button>
      <button class="icon-btn lg" data-more aria-label="More">${ic('more')}</button>
    </div>
    <div class="tracks"></div>
  </div>`);
  let tl;
  if (pl.tracks.length) {
    tl = trackList(pl.tracks, {
      playlist: {
        id: pl.id,
        onRemove: async (t) => {
          try {
            await api.del(`/playlists/${pl.id}/tracks/${t.entryId}`);
            toast(`Removed “${t.title}”`);
            refreshPlaylists();
            reload();
          } catch (err) { toastError(err); }
        },
        onReorder: async (tracks) => {
          try {
            await api.put(`/playlists/${pl.id}/order`, { entryIds: tracks.map((t) => t.entryId) });
            reload();
          } catch (err) { toastError(err); }
        },
      },
    });
    v.querySelector('.tracks').replaceWith(tl.el);
  } else {
    v.querySelector('.tracks').replaceWith(el(emptyState('music', 'This playlist is empty', 'Find songs you like and add them with the ⋯ menu.')));
  }
  const reload = () => navigate(location.pathname, { replace: true });
  v.querySelector('[data-play]').addEventListener('click', () => pl.tracks.length && player.playList(pl.tracks, 0));
  v.querySelector('[data-shuffle]').addEventListener('click', () => pl.tracks.length && player.playList(pl.tracks, 0, { shuffle: true }));
  v.querySelector('[data-more]').addEventListener('click', (e) => openMenu(e.currentTarget, [
    { icon: 'addQueue', label: 'Add to queue', action: () => pl.tracks.length && player.addToQueue(pl.tracks) },
    { icon: 'edit', label: 'Edit details', action: async () => {
      const val = await formDialog({
        title: 'Edit playlist', confirm: 'Save',
        fields: [{ name: 'name', label: 'Name', value: pl.name }, { name: 'description', label: 'Description', value: pl.description, textarea: true }],
        validate: (x) => (x.name.trim() ? null : 'Name is required'),
      });
      if (!val) return;
      try { await api.put(`/playlists/${pl.id}`, val); refreshPlaylists(); reload(); } catch (err) { toastError(err); }
    } },
    'sep',
    { icon: 'trash', label: 'Delete playlist', danger: true, action: async () => {
      if (!(await confirmDialog({ title: 'Delete playlist?', message: `“${pl.name}” will be permanently deleted. Your music files are not affected.`, confirm: 'Delete', danger: true }))) return;
      try { await api.del(`/playlists/${pl.id}`); toast('Playlist deleted'); refreshPlaylists(); navigate('/playlists'); } catch (err) { toastError(err); }
    } },
  ]));
  return v;
}

// ───────── Favorites ─────────

export async function favoritesView() {
  const tracks = await api.get('/favorites');
  const v = el(html`<div>
    <header class="hero">
      <div class="hero-art"><div class="ph" style="--h1:320;--h2:265">${ic('heartFill')}</div></div>
      <div class="hero-info"><div class="eyebrow">Collection</div><h1 class="hero-title">Favorites</h1>
        <div class="hero-meta"><span>${plural(tracks.length, 'song')}</span></div></div>
    </header>
    <div class="actions">
      <button class="play-fab" data-play aria-label="Play">${ic('play')}</button>
      <button class="icon-btn lg" data-shuffle aria-label="Shuffle">${ic('shuffle')}</button>
    </div>
    <div class="tracks"></div></div>`);
  v.querySelector('.tracks').replaceWith(tracks.length ? trackList(tracks).el
    : el(emptyState('heart', 'No favorites yet', 'Tap the heart on any song to save it here.')));
  v.querySelector('[data-play]').addEventListener('click', () => tracks.length && player.playList(tracks, 0));
  v.querySelector('[data-shuffle]').addEventListener('click', () => tracks.length && player.playList(tracks, 0, { shuffle: true }));
  return v;
}

// ───────── Search ─────────

export async function searchView({ query }) {
  const q = query.get('q') || '';
  const v = el(html`<div><div class="results"></div></div>`);
  const box = v.querySelector('.results');
  if (!q.trim()) {
    box.replaceWith(el(emptyState('search', 'Search your library', 'Find songs, albums and artists. Press / anywhere to jump here.')));
    return v;
  }
  const r = await api.get('/search', { q });
  if (!r.tracks.length && !r.albums.length && !r.artists.length) {
    box.replaceWith(el(emptyState('search', 'No results', `Nothing matched “${q}”. Try a different spelling?`)));
    return v;
  }
  box.innerHTML = String(html`
    <h1 class="page-title" style="font-size:30px">Results for “${q}”</h1>
    ${r.tracks.length ? html`<section class="section"><div class="section-head"><h2>Songs</h2></div><div class="tl"></div></section>` : ''}
    ${r.artists.length ? html`<section class="section"><div class="section-head"><h2>Artists</h2></div><div class="carousel">${r.artists.map(artistCard)}</div></section>` : ''}
    ${r.albums.length ? html`<section class="section"><div class="section-head"><h2>Albums</h2></div><div class="carousel">${r.albums.map(albumCard)}</div></section>` : ''}
  `);
  if (r.tracks.length) box.querySelector('.tl').replaceWith(trackList(r.tracks).el);
  return v;
}

export const searchInput = debounce((value) => {
  const url = value.trim() ? `/search?q=${encodeURIComponent(value.trim())}` : '/search';
  navigate(url, { replace: location.pathname === '/search' });
}, 280);

