// Sonara web client — entry point.
import { api, setUnauthorizedHandler } from './api.js';
import { html, ic, el, art, fmtTime } from './util.js';
import { player, eq } from './player.js';
import { openEqualizer } from './eq.js';
import { state, bus, refreshPlaylists, toggleFavorite, createPlaylist } from './state.js';
import { route, match, onRoute, navigate, start as startRouter } from './router.js';
import { dragSort, toastError, toast, openMenu } from './ui.js';
import { trackMenu, emptyState, artistLinks } from './components.js';
import { attachSpectrum, startVisualizer } from './visualizer.js';
import { clearPagePalette, settlePalette, setPlayingCover } from './theme.js';
import { homeView, albumsView, artistsView, songsView, genresView, genreView } from './views/library.js';
import { albumView, artistView, playlistsView, playlistView, favoritesView, searchView, searchInput } from './views/detail.js';
import { settingsView, applyPrefs } from './views/settings.js';
import { authView } from './views/auth.js';
import { inboxView } from './views/inbox.js';

const $ = (sel, root = document) => root.querySelector(sel);
const rootEl = document.getElementById('root');

route('/', homeView);
route('/search', searchView);
route('/albums', albumsView);
route('/album/:id', albumView);
route('/artists', artistsView);
route('/artist/:id', artistView);
route('/songs', songsView);
route('/genres', genresView);
route('/genre/:name', genreView);
route('/playlists', playlistsView);
route('/playlist/:id', playlistView);
route('/favorites', favoritesView);
route('/settings', settingsView);
route('/inbox', inboxView);

const NAV = [
  ['/', 'home', 'Home'],
  ['/search', 'search', 'Search'],
  ['/albums', 'disc', 'Albums'],
  ['/artists', 'mic', 'Artists'],
  ['/songs', 'music', 'Songs'],
  ['/genres', 'tag', 'Genres'],
];

// ───────────────────────── Boot ─────────────────────────

async function boot() {
  applyPrefs();
  setUnauthorizedHandler(() => location.replace('/'));
  let status;
  try {
    status = await api.get('/auth/status');
  } catch {
    rootEl.replaceChildren(el(emptyState('alert', "Can't reach the Sonara server", 'Check that the service is running, then refresh.')));
    return;
  }
  if (!status.user) {
    rootEl.replaceChildren(authView({ setup: status.setupRequired, onDone: (u) => startApp(u) }));
    return;
  }
  startApp(status.user);
}

function startApp(user) {
  state.user = user;
  rootEl.replaceChildren(el(shell()));
  document.getElementById('overlays').prepend(el(queueDrawer()), el(nowPlaying()));
  bindSidebar();
  bindPlayerBar();
  bindQueue();
  bindNowPlaying();
  bindKeys();
  attachSpectrum($('.np-canvas'));
  startVisualizer();
  refreshPlaylists();

  const main = $('.main');
  main.addEventListener('scroll', () => $('.topbar').classList.toggle('scrolled', main.scrollTop > 8), { passive: true });

  onRoute(render);
  startRouter();
  player.restore(user);
}

// ───────────────────────── Layout ─────────────────────────

const logo = html`<div class="logo-mark"><span></span><span></span><span></span><span></span><span></span></div>`;

function shell() {
  const u = state.user;
  return html`<div class="shell">
    <aside class="sidebar">
      <a class="brand" href="/">${logo}<span class="brand-name">Sonara</span></a>
      <nav class="nav">${NAV.map(([href, i, label]) => html`<a class="nav-item" href="${href}" data-nav="${href}">${ic(i)}<span>${label}</span></a>`)}</nav>
      <div class="nav-title"><span>Your music</span>
        <button class="icon-btn sm" data-new-pl aria-label="New playlist" title="New playlist">${ic('plus')}</button></div>
      <nav class="nav">
        <a class="nav-item" href="/favorites" data-nav="/favorites">${ic('heart')}<span>Favorites</span></a>
        <a class="nav-item" href="/playlists" data-nav="/playlists">${ic('listMusic')}<span>Playlists</span></a>
        ${u.isAdmin ? html`<a class="nav-item" href="/inbox" data-nav="/inbox">${ic('download')}<span>Inbox</span></a>` : ''}
      </nav>
      <div class="nav-pl"></div>
      <div class="user-chip">
        <a href="/settings" class="avatar" title="Settings">${u.username[0]}</a>
        <a href="/settings" class="uc-text" style="flex:1;min-width:0"><div class="uc-name">${u.username}</div><div class="uc-role">${u.isAdmin ? 'Admin' : 'Listener'}</div></a>
        <a href="/settings" class="icon-btn sm uc-text" aria-label="Settings" title="Settings" data-nav="/settings">${ic('settings')}</a>
        <button class="icon-btn sm uc-text" data-logout aria-label="Sign out" title="Sign out">${ic('logout')}</button>
      </div>
    </aside>

    <main class="main">
      <div class="topbar">
        <button class="icon-btn" data-back aria-label="Back">${ic('chevronLeft')}</button>
        <button class="icon-btn" data-fwd aria-label="Forward">${ic('chevronRight')}</button>
        <label class="search">
          <input type="search" placeholder="Search songs, albums, artists" aria-label="Search" spellcheck="false">
          ${ic('search')}<kbd>/</kbd>
        </label>
        <div class="spacer"></div>
      </div>
      <div class="view-host"></div>
    </main>

    <footer class="playerbar">
      <div class="pb-track">
        <div class="pb-cover" data-open-np title="Now playing">${art(null, '')}<div class="expand">${ic('maximize')}</div></div>
        <div class="pb-meta"><div class="pb-title">Nothing playing</div><div class="pb-artist">Pick something you love</div></div>
        <button class="icon-btn sm heart hide-sm" data-pb-fav aria-label="Favorite">${ic('heart')}</button>
      </div>
      <div class="pb-center">
        <div class="pb-controls">
          <button class="icon-btn sm" data-shuffle aria-label="Shuffle" title="Shuffle (S)">${ic('shuffle')}</button>
          <button class="icon-btn" data-prev aria-label="Previous" title="Previous">${ic('prev')}</button>
          <button class="pb-play" data-toggle aria-label="Play">${ic('play')}</button>
          <button class="icon-btn" data-next aria-label="Next" title="Next">${ic('next')}</button>
          <button class="icon-btn sm" data-repeat aria-label="Repeat" title="Repeat (R)">${ic('repeat')}</button>
        </div>
        <div class="pb-progress">
          <span class="time" data-cur>0:00</span>
          <input class="range" type="range" min="0" max="1000" value="0" step="1" data-seek aria-label="Seek">
          <span class="time" data-dur>0:00</span>
        </div>
      </div>
      <div class="pb-right">
        <button class="icon-btn sm hide-sm" data-open-np aria-label="Now playing" title="Now playing (F)">${ic('maximize')}</button>
        <button class="icon-btn sm hide-sm pb-extra" data-speed aria-label="Playback speed" title="Playback speed"><span class="pill-label">1×</span></button>
        <button class="icon-btn sm hide-sm" data-eq aria-label="Equalizer" title="Equalizer (E)">${ic('sliders')}</button>
        <button class="icon-btn sm hide-sm" data-sleep aria-label="Sleep timer" title="Sleep timer">${ic('moon')}</button>
        <button class="icon-btn sm" data-queue aria-label="Queue" title="Queue (Q)">${ic('queue')}</button>
        <div class="volume">
          <button class="icon-btn sm" data-mute aria-label="Mute">${ic('volume')}</button>
          <input class="range" type="range" min="0" max="100" step="1" data-vol aria-label="Volume">
        </div>
      </div>
    </footer>

    <nav class="mobile-nav">
      <a href="/" data-nav="/">${ic('home')}Home</a>
      <a href="/search" data-nav="/search">${ic('search')}Search</a>
      <a href="/albums" data-nav="/albums">${ic('disc')}Albums</a>
      <a href="/playlists" data-nav="/playlists">${ic('listMusic')}Playlists</a>
      <a href="/settings" data-nav="/settings">${ic('settings')}Settings</a>
    </nav>
  </div>`;
}

const queueDrawer = () => html`<aside class="drawer" aria-label="Queue">
  <div class="drawer-head"><h3>Queue</h3><div>
    <button class="btn sm ghost" data-clear-q>Clear</button>
    <button class="icon-btn sm" data-close-q aria-label="Close">${ic('x')}</button></div></div>
  <div class="drawer-body"></div></aside>`;

const nowPlaying = () => html`<section class="np paused" aria-label="Now playing">
  <div class="np-bg"></div>
  <canvas class="np-canvas"></canvas>
  <div class="np-top">
    <button class="icon-btn" data-close-np aria-label="Close">${ic('chevronDown')}</button>
    <div class="label">Playing from your library<b data-np-album></b></div>
    <button class="icon-btn" data-np-more aria-label="More">${ic('more')}</button>
  </div>
  <div class="np-stage"><div class="np-art">${art(null, '')}</div></div>
  <div class="np-bottom">
    <div class="np-info">
      <div class="t"><div class="np-title">—</div><div class="np-artist"></div></div>
      <button class="icon-btn lg heart" data-np-fav aria-label="Favorite">${ic('heart')}</button>
    </div>
    <div class="np-progress">
      <span class="time" data-cur>0:00</span>
      <input class="range" type="range" min="0" max="1000" value="0" data-seek aria-label="Seek">
      <span class="time" data-dur>0:00</span>
    </div>
    <div class="np-controls">
      <button class="icon-btn" data-shuffle aria-label="Shuffle">${ic('shuffle')}</button>
      <button class="icon-btn lg" data-prev aria-label="Previous">${ic('prev')}</button>
      <button class="pb-play" data-toggle aria-label="Play">${ic('play')}</button>
      <button class="icon-btn lg" data-next aria-label="Next">${ic('next')}</button>
      <button class="icon-btn" data-repeat aria-label="Repeat">${ic('repeat')}</button>
    </div>
    <div class="np-tech"></div>
  </div>
</section>`;

// ───────────────────────── Routing / rendering ─────────────────────────

let currentView = null;
let renderSeq = 0;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function render(url, { scroll = 0 } = {}) {
  const seq = ++renderSeq;
  const host = $('.view-host');
  const main = $('.main');
  clearPagePalette();
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const n = a.dataset.nav;
    a.classList.toggle('active', n === '/' ? url.pathname === '/' : url.pathname.startsWith(n) || (n === '/albums' && url.pathname.startsWith('/album/')) || (n === '/artists' && url.pathname.startsWith('/artist/')) || (n === '/playlists' && url.pathname.startsWith('/playlist/')));
  });
  document.querySelectorAll('.nav-pl .nav-item').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === url.pathname));
  const searchEl = $('.search input');
  if (url.pathname === '/search') { if (document.activeElement !== searchEl) searchEl.value = url.searchParams.get('q') || ''; }
  else searchEl.value = '';

  const old = host.firstElementChild;
  if (old && url.pathname !== '/search') old.classList.add('view-leave');

  const m = match(url.pathname);
  let view;
  try {
    if (!m) throw Object.assign(new Error('Page not found'), { status: 404 });
    [view] = await Promise.all([m.view({ params: m.params, query: url.searchParams }), old && url.pathname !== '/search' ? wait(150) : null]);
  } catch (err) {
    view = el(html`<div>${err.status === 404
      ? emptyState('alert', 'Nothing here', "This page doesn't exist — maybe the music moved?", html`<a class="btn primary" href="/">Go home</a>`)
      : emptyState('alert', 'Something went wrong', err.message)}</div>`);
  }
  if (seq !== renderSeq) { view._destroy?.(); return; }
  currentView?._destroy?.();
  currentView = view;
  view.classList.add('view', 'view-enter');
  host.replaceChildren(view);
  main.scrollTop = scroll;
  settlePalette();
}

// ───────────────────────── Sidebar ─────────────────────────

function bindSidebar() {
  const box = $('.nav-pl');
  const draw = (pls) => {
    box.innerHTML = String(html`${pls.map((p) => html`<a class="nav-item" href="/playlist/${p.id}">
      <div class="pl-thumb">${art(p.covers?.[0], p.name, 'playlist', 56)}</div><span>${p.name}</span></a>`)}`);
    box.querySelectorAll('.nav-item').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === location.pathname));
  };
  bus.on('playlists', draw);
  $('[data-new-pl]').addEventListener('click', async () => {
    const pl = await createPlaylist();
    if (pl) navigate(`/playlist/${pl.id}`);
  });
  $('[data-logout]').addEventListener('click', async () => {
    player.pause();
    await api.post('/auth/logout').catch(() => {});
    location.replace('/');
  });
  $('[data-back]').addEventListener('click', () => history.back());
  $('[data-fwd]').addEventListener('click', () => history.forward());
  const search = $('.search input');
  search.addEventListener('input', () => searchInput(search.value));
  search.addEventListener('focus', () => { if (location.pathname !== '/search' && search.value) searchInput(search.value); });
  search.addEventListener('keydown', (e) => { if (e.key === 'Escape') search.blur(); });
}

// ───────────────────────── Player bar + Now Playing (shared bindings) ─────────────────────────

function setRange(input, value, max) {
  const pct = max ? (value / max) * 100 : 0;
  input.value = String(Math.round((pct / 100) * Number(input.max)));
  input.style.setProperty('--pct', `${pct}%`);
}

function bindTransport(scope) {
  scope.querySelector('[data-toggle]').addEventListener('click', () => player.toggle());
  scope.querySelector('[data-prev]').addEventListener('click', () => player.prev());
  scope.querySelector('[data-next]').addEventListener('click', () => player.next());
  scope.querySelector('[data-shuffle]').addEventListener('click', () => player.toggleShuffle());
  scope.querySelector('[data-repeat]').addEventListener('click', () => player.cycleRepeat());

  const seek = scope.querySelector('[data-seek]');
  const cur = scope.querySelector('[data-cur]');
  const dur = scope.querySelector('[data-dur]');
  let dragging = false;
  seek.addEventListener('input', () => {
    dragging = true;
    const t = (seek.value / seek.max) * player.duration;
    cur.textContent = fmtTime(t);
    seek.style.setProperty('--pct', `${(seek.value / seek.max) * 100}%`);
  });
  seek.addEventListener('change', () => {
    player.seek((seek.value / seek.max) * player.duration);
    dragging = false;
  });
  player.on('time', (t, d) => {
    if (dragging) return;
    setRange(seek, t, d);
    cur.textContent = fmtTime(t);
    dur.textContent = fmtTime(d);
  });
  player.on('state', (playing) => {
    const b = scope.querySelector('[data-toggle]');
    b.innerHTML = ic(playing ? 'pause' : 'play');
    b.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  });
  player.on('mode', () => {
    scope.querySelector('[data-shuffle]').classList.toggle('on', player.shuffle);
    const r = scope.querySelector('[data-repeat]');
    r.classList.toggle('on', player.repeat !== 'off');
    r.innerHTML = ic(player.repeat === 'one' ? 'repeatOne' : 'repeat');
  });
}

function bindPlayerBar() {
  const bar = $('.playerbar');
  bindTransport(bar);

  const vol = $('[data-vol]', bar);
  const mute = $('[data-mute]', bar);
  const drawVol = () => {
    const v = player.muted ? 0 : player.volume;
    setRange(vol, v, 1);
    mute.innerHTML = ic(v === 0 ? 'mute' : v < 0.5 ? 'volumeLow' : 'volume');
  };
  vol.addEventListener('input', () => player.setVolume(vol.value / 100));
  mute.addEventListener('click', () => player.toggleMute());
  player.on('volume', drawVol);
  drawVol();
  bar.addEventListener('wheel', (e) => {
    if (!e.target.closest('.volume')) return;
    e.preventDefault();
    player.setVolume(player.volume - Math.sign(e.deltaY) * 0.05);
  }, { passive: false });

  $('[data-pb-fav]', bar).addEventListener('click', () => player.current && toggleFavorite(player.current));
  bar.querySelectorAll('[data-open-np]').forEach((b) => b.addEventListener('click', () => player.current && toggleNowPlaying(true)));
  $('[data-queue]', bar).addEventListener('click', () => toggleQueue());

  // Playback speed
  const speed = $('[data-speed]', bar);
  const drawRate = (r) => {
    speed.querySelector('.pill-label').textContent = `${r}×`;
    speed.classList.toggle('on', r !== 1);
  };
  drawRate(player.rate);
  player.on('rate', drawRate);
  speed.addEventListener('click', () => openMenu(speed, [
    { head: 'Playback speed' },
    ...[0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2].map((r) => ({
      icon: r === player.rate ? 'check' : null, label: r === 1 ? 'Normal' : `${r}×`, action: () => player.setRate(r),
    })),
  ]));

  // Equalizer
  const eqBtn = $('[data-eq]', bar);
  const drawEq = () => eqBtn.classList.toggle('on', !!eq.enabled);
  drawEq();
  eqBtn.addEventListener('click', async () => { await openEqualizer(); drawEq(); });

  // Sleep timer
  const sleep = $('[data-sleep]', bar);
  let sleepTick = null;
  const drawSleep = (s) => {
    clearInterval(sleepTick);
    sleep.classList.toggle('on', !!s);
    const label = () => {
      if (!player.sleep) return 'Sleep timer';
      if (player.sleep.endOfTrack) return 'Sleep timer: stops after this song';
      return `Sleep timer: ${Math.max(1, Math.ceil((player.sleep.at - Date.now()) / 60000))} min left`;
    };
    sleep.title = label();
    if (s?.at) sleepTick = setInterval(() => { sleep.title = label(); }, 15000);
  };
  player.on('sleep', drawSleep);
  sleep.addEventListener('click', () => openMenu(sleep, [
    { head: sleep.title },
    ...[5, 15, 30, 45, 60, 90].map((m) => ({ icon: 'clock', label: `${m} minutes`, action: () => { player.setSleep(m); toast(`Sleep timer set for ${m} minutes`); } })),
    { icon: 'music', label: 'End of this song', action: () => { player.setSleep('track'); toast('Playback will stop after this song'); } },
    ...(player.sleep ? ['sep', { icon: 'x', label: 'Turn off timer', action: () => { player.setSleep(null); toast('Sleep timer off'); } }] : []),
  ]));

  player.on('track', (t) => {
    if (!t) return;
    const meta = $('.pb-meta', bar);
    meta.innerHTML = String(html`<div class="pb-title swap" title="${t.title}">${t.title}</div>
      <div class="pb-artist swap">${artistLinks(t)} · <a href="/album/${t.albumId}">${t.album}</a></div>`);
    $('.pb-cover', bar).innerHTML = String(html`${art(t.cover, t.album, 'disc', 120)}<div class="expand">${ic('maximize')}</div>`);
    $('.pb-cover', bar).firstElementChild.classList.add('swap');
    const fav = $('[data-pb-fav]', bar);
    fav.dataset.fav = t.id;
    fav.classList.toggle('on', !!t.favorite);
    fav.innerHTML = ic(t.favorite ? 'heartFill' : 'heart');
    setPlayingCover(t.cover);
  });
}

// ───────────────────────── Queue drawer ─────────────────────────

const queueOpen = () => $('.drawer').classList.contains('open');
function toggleQueue(force) {
  const d = $('.drawer');
  const open = force ?? !d.classList.contains('open');
  d.classList.toggle('open', open);
  $('[data-queue]').classList.toggle('on', open);
  if (open) drawQueue();
}

function drawQueue() {
  const body = $('.drawer-body');
  const cur = player.current;
  if (!cur) { body.innerHTML = String(emptyState('queue', 'Queue is empty', 'Play an album or a song and it shows up here.')); return; }
  const up = player.upNext.slice(0, 300);
  const item = (t, i, isCur) => html`<div class="q-item ${isCur ? 'current' : ''}" data-q="${i}" style="--i:${isCur ? 0 : i - player.index}" ${isCur ? '' : 'draggable="true"'}>
    <div class="tl-cover">${art(t.cover, t.album, 'disc', 80)}</div>
    <div class="tl-text"><div class="tl-title">${t.title}</div><div class="tl-sub">${t.artist}</div></div>
    ${isCur ? html`<span class="eq"><i></i><i></i><i></i><i></i></span>` : html`<button class="icon-btn sm" data-q-rm="${i}" aria-label="Remove">${ic('x')}</button>`}
  </div>`;
  body.innerHTML = String(html`
    <div class="q-label">Now playing</div>${item(cur, player.index, true)}
    <div class="q-label">Up next${player.shuffle ? ' · shuffled' : ''}</div>
    <div class="q-up">${up.length ? up.map((t, k) => item(t, player.index + 1 + k, false)) : html`<p class="muted" style="padding:0 12px">Nothing queued. ${player.repeat === 'all' ? 'The queue will repeat.' : ''}</p>`}</div>
    ${player.upNext.length > up.length ? html`<p class="muted" style="padding:8px 12px">…and ${player.upNext.length - up.length} more</p>` : ''}`);
}

function bindQueue() {
  const d = $('.drawer');
  $('[data-close-q]', d).addEventListener('click', () => toggleQueue(false));
  $('[data-clear-q]', d).addEventListener('click', () => player.clearUpNext());
  const body = $('.drawer-body', d);
  body.addEventListener('click', (e) => {
    const rm = e.target.closest('[data-q-rm]');
    if (rm) return player.removeAt(Number(rm.dataset.qRm));
    const it = e.target.closest('[data-q]');
    if (it && !it.classList.contains('current')) player.jump(Number(it.dataset.q));
  });
  body.addEventListener('contextmenu', (e) => {
    const it = e.target.closest('[data-q]');
    if (!it) return;
    e.preventDefault();
    trackMenu(e, player.queue[Number(it.dataset.q)]);
  });
  dragSort(body, '.q-up .q-item', (from, to) => player.move(player.index + 1 + from, player.index + 1 + to));
  player.on('queue', () => queueOpen() && drawQueue());
}

// ───────────────────────── Now playing ─────────────────────────

function toggleNowPlaying(force) {
  const np = $('.np');
  const open = force ?? !np.classList.contains('open');
  np.classList.toggle('open', open);
  if (open) toggleQueue(false);
}

function bindNowPlaying() {
  const np = $('.np');
  bindTransport(np);
  $('[data-close-np]', np).addEventListener('click', () => toggleNowPlaying(false));
  $('[data-np-fav]', np).addEventListener('click', () => player.current && toggleFavorite(player.current));
  $('[data-np-more]', np).addEventListener('click', (e) => player.current && trackMenu(e.currentTarget, player.current));
  np.addEventListener('click', (e) => { if (e.target.closest('a[href]')) toggleNowPlaying(false); });

  player.on('track', (t) => {
    if (!t) return;
    $('.np-bg', np).style.backgroundImage = t.cover ? `url("/api/cover/${t.cover}")` : '';
    const a = $('.np-art', np);
    a.innerHTML = String(art(t.cover, t.album, 'disc', 600));
    a.classList.remove('swap'); void a.offsetWidth; a.classList.add('swap');
    $('.np-title', np).textContent = t.title;
    $('.np-artist', np).innerHTML = String(html`${artistLinks(t)} — <a href="/album/${t.albumId}">${t.album}</a>`);
    $('[data-np-album]', np).textContent = t.album;
    const fav = $('[data-np-fav]', np);
    fav.dataset.fav = t.id;
    fav.classList.toggle('on', !!t.favorite);
    fav.innerHTML = ic(t.favorite ? 'heartFill' : 'heart');
    const tech = [t.codec, t.sampleRate && `${(t.sampleRate / 1000).toFixed(1)} kHz`, t.bitrate && `${Math.round(t.bitrate / 1000)} kbps`].filter(Boolean);
    $('.np-tech', np).textContent = tech.join(' · ');
  });
  player.on('state', (playing) => np.classList.toggle('paused', !playing));
}

// ───────────────────────── Keyboard ─────────────────────────

function bindKeys() {
  addEventListener('keydown', (e) => {
    const typing = e.target.closest?.('input:not([type=range]), textarea, select, [contenteditable]');
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    const modalOpen = !!document.querySelector('.modal-backdrop, .menu');
    const k = e.key;
    if (k === 'Escape' && !modalOpen) {
      if ($('.np').classList.contains('open')) toggleNowPlaying(false);
      else if (queueOpen()) toggleQueue(false);
      return;
    }
    if (modalOpen) return;
    const handled = {
      ' ': () => player.toggle(),
      ArrowRight: () => (e.shiftKey ? player.next() : player.seek(player.time + 5)),
      ArrowLeft: () => (e.shiftKey ? player.prev() : player.seek(player.time - 5)),
      ArrowUp: () => player.setVolume(player.volume + 0.05),
      ArrowDown: () => player.setVolume(player.volume - 0.05),
      '>': () => player.setRate(player.rate + 0.25),
      '<': () => player.setRate(player.rate - 0.25),
      m: () => player.toggleMute(),
      s: () => player.toggleShuffle(),
      r: () => player.cycleRepeat(),
      f: () => player.current && toggleNowPlaying(),
      q: () => toggleQueue(),
      e: async () => { await openEqualizer(); $('[data-eq]')?.classList.toggle('on', !!eq.enabled); },
      '/': () => { toggleNowPlaying(false); $('.search input').focus(); },
    }[k.length === 1 ? k.toLowerCase() : k];
    if (handled) {
      if (e.target.matches?.('input[type=range]') && k.startsWith('Arrow')) return;
      e.preventDefault();
      handled();
    }
  });
}

boot().catch(toastError);
