// Album, Artist, Playlist, Favorites and Search views.
import { api } from '../api.js';
import { html, ic, el, art, plural, fmtLong, debounce } from '../util.js';
import { player } from '../player.js';
import { state, refreshPlaylists, createPlaylist } from '../state.js';
import { navigate } from '../router.js';
import { toast, toastError, confirmDialog, formDialog, openMenu } from '../ui.js';
import { albumCard, artistCard, playlistCard, trackList, emptyState, playlistArt, playlistPicker, releaseLabel, downloadDialog, shareDialog, canShare, canDownload } from '../components.js';
import { setPalette } from '../theme.js';
import { collectionFileItems } from '../fileops.js';
import { smartEditor } from './smart.js';
import { coverEditor } from '../covers.js';
import { offlineItems } from '../offline.js';

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
        <div class="eyebrow">${releaseLabel(a.releaseType, a.compilation)}${lossless ? ' · Lossless' : ''}</div>
        <h1 class="hero-title">${a.name}</h1>
        <div class="hero-meta"><a href="/artist/${a.artistId}">${a.artist}</a>
          ${a.year ? html`${dot}<span title="${a.originalYear && a.originalYear !== a.year ? `Originally released ${a.originalYear}` : ''}">${a.originalYear && a.originalYear !== a.year ? `${a.originalYear} (${a.year})` : a.year}</span>` : ''}${dot}<span>${plural(a.trackCount, 'song')}, ${fmtLong(a.duration)}</span>
          ${(a.genres?.length ? a.genres : a.genre ? [a.genre] : []).slice(0, 3).map((g) => html`${dot}<a href="/genre/${encodeURIComponent(g)}" style="font-weight:550">${g}</a>`)}
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
    { icon: 'radio', label: 'Start album radio', action: () => player.startRadio(`album:${a.id}`, a.name) },
    ...(canShare() ? [{ icon: 'share', label: 'Share album…', action: () => shareDialog('album', a.id, a.name) }] : []),
    ...(canDownload() ? [{ icon: 'download', label: 'Download album…', action: () => downloadDialog('album', a.id, a.name) }] : []),
    ...offlineItems('album', a.id, a.name, a.tracks, a.cover),
    ...collectionFileItems(a.tracks, { type: 'album', id: a.id, name: a.name }),
    ...(state.user.isAdmin ? ['sep', { icon: 'palette', label: 'Change cover…', action: async () => {
      if (await coverEditor(a)) setTimeout(() => navigate(location.pathname, { replace: true }), 300);
    } }] : []),
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
        <div class="hero-meta"><span>${plural(a.albumCount ?? a.albums.length, 'release')}</span>${dot}<span>${plural(a.trackCount, 'song')}</span>${dot}<span>${fmtLong(a.duration)}</span></div>
      </div>
    </header>
    <div class="actions">
      <button class="play-fab" data-play aria-label="Play">${ic('play')}</button>
      <button class="btn" data-shuffle>${ic('shuffle')} Shuffle</button>
      <button class="btn" data-radio>${ic('radio')} Radio</button>
      ${state.user.isAdmin ? html`<button class="icon-btn lg" data-more aria-label="More">${ic('more')}</button>` : ''}
    </div>
    ${a.topTracks.length ? html`<section class="section"><div class="section-head"><h2>Popular</h2></div><div class="top"></div></section>` : ''}
    <section class="section artist-bio" hidden></section>
    ${a.albums.length ? html`<section class="section"><div class="section-head"><h2>Albums</h2></div><div class="grid">${a.albums.map(albumCard)}</div></section>` : ''}
    ${a.eps?.length ? html`<section class="section"><div class="section-head"><h2>EPs &amp; singles</h2></div><div class="grid">${a.eps.map(albumCard)}</div></section>` : ''}
    ${a.live?.length ? html`<section class="section"><div class="section-head"><h2>Live, remixes &amp; compilations</h2></div><div class="grid">${a.live.map(albumCard)}</div></section>` : ''}
    ${a.appearsOn.length ? html`<section class="section"><div class="section-head"><h2>Appears on</h2></div><div class="carousel">${a.appearsOn.map(albumCard)}</div></section>` : ''}
  </div>`);
  if (a.topTracks.length) v.querySelector('.top').replaceWith(trackList(a.topTracks, { head: false }).el);
  const all = () => api.get(`/artists/${params.id}/tracks`);
  v.querySelector('[data-play]').addEventListener('click', async () => player.playList(await all(), 0));
  v.querySelector('[data-shuffle]').addEventListener('click', async () => player.playList(await all(), 0, { shuffle: true }));
  v.querySelector('[data-radio]').addEventListener('click', () => player.startRadio(`artist:${a.id}`, a.name));
  // Bio and photo from Wikipedia / Last.fm (only when an admin turned this on).
  api.get(`/artists/${encodeURIComponent(a.id)}/info`).then((info) => {
    if (!info?.bio || !v.isConnected) return;
    const box = v.querySelector('.artist-bio');
    box.hidden = false;
    box.innerHTML = String(html`<div class="section-head"><h2>About</h2></div>
      <div class="bio ${info.bio.length > 600 ? 'clamped' : ''}"><p>${info.bio}</p></div>
      <div class="bio-foot muted">${info.bio.length > 600 ? html`<button class="link" data-more-bio>Read more</button> · ` : ''}${info.url ? html`<a href="${info.url}" target="_blank" rel="noopener">${info.source || 'Source'}</a>` : info.source || ''}</div>`);
    box.querySelector('[data-more-bio]')?.addEventListener('click', (e) => { box.querySelector('.bio').classList.remove('clamped'); e.target.remove(); });
    if (info.image && !a.cover) {
      v.querySelector('.hero-art').innerHTML = String(art(info.image, a.name, 'artist'));
      setPalette(info.image);
    }
  }).catch(() => {});
  v.querySelector('[data-more]')?.addEventListener('click', async (e) => {
    const at = e.currentTarget;
    const tracks = await all();
    openMenu(at, [
      { icon: 'addQueue', label: 'Add to queue', action: () => player.addToQueue(tracks) },
      ...collectionFileItems(tracks, { type: 'artist', id: a.id, name: a.name }),
    ]);
  });
  return v;
}

// ───────── Playlists ─────────

const VIS_LABEL = { private: 'Private playlist', public: 'Shared playlist', collaborative: 'Collaborative playlist' };
const VIS_HELP = { private: 'only you', public: 'everyone here can listen', collaborative: 'everyone here can add and remove songs' };

/** Pick an .m3u / .m3u8 / .xspf file and turn it into a playlist. */
export function importPlaylistFile() {
  const input = el('<input type="file" accept=".m3u,.m3u8,.xspf,audio/x-mpegurl,application/xspf+xml" hidden>');
  document.body.append(input);
  input.addEventListener('change', async () => {
    const f = input.files[0];
    input.remove();
    if (!f) return;
    try {
      const res = await fetch(`/api/playlists/import?name=${encodeURIComponent(f.name)}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'text/plain' }, body: await f.text() });
      const r = await res.json();
      if (!res.ok) throw new Error(r.error);
      await refreshPlaylists();
      toast(`Imported “${r.name}”: ${r.matched} of ${r.total} songs${r.missing.length ? ` (${r.missing.length} not in your library)` : ''}`, { type: 'success', ms: 5000 });
      navigate(`/playlist/${r.id}`);
    } catch (err) { toastError(err); }
  });
  input.click();
}

export async function playlistsView() {
  await refreshPlaylists();
  const mine = state.playlists.filter((p) => p.owned !== false);
  const others = state.playlists.filter((p) => p.owned === false);
  const v = el(html`<div>
    <h1 class="page-title">Playlists</h1><p class="page-sub">${plural(state.playlists.length, 'playlist')}</p>
    <div class="actions"><button class="btn primary" data-new>${ic('plus')} New playlist</button>
      <button class="btn" data-new-smart>${ic('sparkles')} New smart playlist</button>
      <button class="btn" data-import>${ic('upload')} Import…</button></div>
    ${state.smartPlaylists.length ? html`<section class="section"><div class="section-head"><h2>Smart playlists</h2></div>
      <div class="grid">${state.smartPlaylists.map((p, i) => html`<a class="card" href="/smart/${p.id}" style="--i:${i}">
        <div class="card-art">${p.covers?.length >= 4 ? html`<div style="display:grid;grid-template-columns:1fr 1fr;width:100%;height:100%">${p.covers.slice(0, 4).map((c) => art(c))}</div>`
          : p.covers?.length ? art(p.covers[0], p.name, 'playlist') : html`<div class="ph smart-ph">${ic('sparkles')}</div>`}
          <span class="card-badge">${ic('sparkles')}</span></div>
        <div class="card-title">${p.name}</div><div class="card-sub">${plural(p.trackCount || 0, 'song')}</div></a>`)}</div></section>` : ''}
    ${mine.length ? html`<div class="section-head" style="margin-top:8px"><h2>Playlists</h2></div>` : ''}
    ${mine.length ? html`<div class="grid">
        <a class="card" href="/favorites" style="--i:0"><div class="card-art"><div class="ph" style="--h1:320;--h2:270">${ic('heartFill')}</div></div>
          <div class="card-title">Favorites</div><div class="card-sub">Songs you love</div></a>
        ${mine.map((p, i) => playlistCard(p, i + 1))}</div>`
      : emptyState('listMusic', 'No playlists yet', 'Create one here, import an .m3u file, or right-click any song and choose “Add to playlist”.')}
    ${others.length ? html`<section class="section"><div class="section-head"><h2>Shared with you</h2></div>
      <div class="grid">${others.map((p, i) => playlistCard(p, i))}</div></section>` : ''}
  </div>`);
  v.querySelector('[data-import]').addEventListener('click', () => importPlaylistFile());
  v.querySelector('[data-new]').addEventListener('click', async () => {
    const pl = await createPlaylist();
    if (pl) navigate(`/playlist/${pl.id}`);
  });
  v.querySelector('[data-new-smart]').addEventListener('click', async () => {
    const pl = await smartEditor();
    if (pl) navigate(`/smart/${pl.id}`);
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
        <div class="eyebrow">${pl.fromFile ? 'Playlist file' : VIS_LABEL[pl.visibility] || 'Playlist'}</div>
        <h1 class="hero-title">${pl.name}</h1>
        <div class="hero-meta"><span>${pl.owner || state.user.username}</span>${dot}<span class="pl-count">${plural(pl.trackCount, 'song')}, ${fmtLong(pl.duration)}</span></div>
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
      playlist: !pl.canEdit ? null : {
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
    ...(pl.tracks.length ? offlineItems('playlist', pl.id, pl.name, pl.tracks, pl.covers?.[0]) : []),
    ...(pl.tracks.length && canShare() ? [{ icon: 'share', label: 'Share playlist…', action: () => shareDialog('playlist', pl.id, pl.name) }] : []),
    ...(pl.tracks.length && canDownload() ? [{ icon: 'download', label: 'Download playlist…', action: () => downloadDialog('playlist', pl.id, pl.name) }] : []),
    ...(pl.tracks.length ? [{ icon: 'file', label: 'Export as file…', action: () => openMenu(v.querySelector('[data-more]'), [
      { head: 'Export playlist' },
      ...[['m3u8', 'M3U8 (most players)'], ['m3u', 'M3U (older players)'], ['xspf', 'XSPF']].map(([f, l]) => ({ icon: 'file', label: l, action: () => {
        const a = document.createElement('a');
        a.href = `/api/playlists/${pl.id}/export?format=${f}`;
        a.download = '';
        document.body.append(a); a.click(); a.remove();
      } })),
    ]) }] : []),
    ...(pl.canManage ? ['sep', { head: 'Who can see it' },
      ...Object.entries(VIS_LABEL).map(([k, l]) => ({ icon: pl.visibility === k ? 'check' : null, label: `${l}: ${VIS_HELP[k]}`, action: async () => {
        try { await api.put(`/playlists/${pl.id}`, { visibility: k }); toast(`${l}`, { type: 'success' }); refreshPlaylists(); reload(); } catch (err) { toastError(err); }
      } }))] : []),
    ...(!pl.canManage ? [] : ['sep']),
    ...(pl.tracks.length ? collectionFileItems(pl.tracks, { type: 'playlist', id: pl.id, name: pl.name }).filter((x) => x === 'sep' || x.label !== 'Move to folder…') : []),
    ...(!pl.canManage ? [] : [{ icon: 'edit', label: 'Edit details', action: async () => {
      const val = await formDialog({
        title: 'Edit playlist', confirm: 'Save',
        fields: [{ name: 'name', label: 'Name', value: pl.name }, { name: 'description', label: 'Description', value: pl.description, textarea: true }],
        validate: (x) => (x.name.trim() ? null : 'Name is required'),
      });
      if (!val) return;
      try { await api.put(`/playlists/${pl.id}`, val); refreshPlaylists(); reload(); } catch (err) { toastError(err); }
    } },
    { icon: 'trash', label: 'Delete playlist', danger: true, action: async () => {
      if (!(await confirmDialog({ title: 'Delete playlist?', message: `“${pl.name}” will be permanently deleted${pl.fromFile ? ' (the .m3u file stays, so it comes back on the next scan unless you turn off playlist import)' : ''}. Your music files are not affected.`, confirm: 'Delete', danger: true }))) return;
      try { await api.del(`/playlists/${pl.id}`); toast('Playlist deleted'); refreshPlaylists(); navigate('/playlists'); } catch (err) { toastError(err); }
    } }]),
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

