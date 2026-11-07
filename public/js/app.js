// Sonara web client — entry point.
import { api, setUnauthorizedHandler } from './api.js';
import { html, ic, el, art, fmtTime } from './util.js';
import { player, eq, sound } from './player.js';
import { openEqualizer } from './eq.js';
import { attachLyrics } from './lyrics.js';
let lyricsPane = null;
import { state, bus, refreshPlaylists, toggleFavorite, createPlaylist } from './state.js';
import { route, match, onRoute, navigate, start as startRouter } from './router.js';
import { dragSort, toastError, toast, openMenu } from './ui.js';
import { trackMenu, emptyState, artistLinks } from './components.js';
import { attachSpectrum, startVisualizer, VIS_STYLES, visStyle, startMilkdrop, stopMilkdrop, nextPreset } from './visualizer.js';
import { clearPagePalette, settlePalette, setPlayingCover } from './theme.js';
import { homeView, albumsView, artistsView, songsView, genresView, genreView, mixView } from './views/library.js';
import { albumView, artistView, playlistsView, playlistView, favoritesView, searchView, searchInput } from './views/detail.js';
import { settingsView, applyPrefs } from './views/settings.js';
import { authView } from './views/auth.js';
import { inboxView } from './views/inbox.js';
import { statsView } from './views/stats.js';
import { smartPlaylistView } from './views/smart.js';
import { serverView } from './views/server.js';
import { partyView } from './views/party.js';
import { connect, startConnect, moveTo, controlDevice, playHere, castSupported, startCast, startParty, leaveParty, partyUrl, clientId } from './connect.js';
import { copyText } from './components.js';
import { registerServiceWorker } from './offline.js';
import { toggleMiniPlayer, miniSupported } from './mini.js';
import { podcastsView, podcastView, episodeMenu } from './views/podcasts.js';
import { radioView, stationMenu } from './views/radio.js';
import { isLibrary, isEpisode, isStation, subtitle, sourceLabel } from './media.js';
import { t, loadLocale } from './i18n.js';
import { announce } from './a11y.js';
import { getAnalysis, forgetAnalysis, drawWave } from './analysis.js';
import { addBookmark, markMenuItems, markTicks } from './marks.js';
import { alarmDialog, alarmLabel, startAlarms } from './alarm.js';
import { requestsDialog } from './party-requests.js';
import { prefs } from './util.js';

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
route('/stats', statsView);
route('/smart/:id', smartPlaylistView);
route('/server', serverView);
route('/party/:id', partyView);
route('/podcasts', podcastsView);
route('/podcast/:id', podcastView);
route('/radio', radioView);
route('/mix/:id', mixView);

const NAV = [
  ['/', 'home', 'Home'],
  ['/search', 'search', 'Search'],
  ['/albums', 'disc', 'Albums'],
  ['/artists', 'mic', 'Artists'],
  ['/songs', 'music', 'Songs'],
  ['/genres', 'tag', 'Genres'],
  ['/podcasts', 'podcast', 'Podcasts'],
  ['/radio', 'radio', 'Radio'],
];

// ───────────────────────── Boot ─────────────────────────

async function boot() {
  await loadLocale();
  applyPrefs();
  registerServiceWorker();
  setUnauthorizedHandler(() => location.replace('/'));
  let status;
  try {
    status = await api.get('/auth/status');
  } catch {
    rootEl.replaceChildren(el(emptyState('alert', t("Can't reach the Sonara server"), t('Check that the service is running, then refresh.'))));
    return;
  }
  state.sharing = status.sharing;
  if (!status.user) {
    rootEl.replaceChildren(authView({ setup: status.setupRequired, passwordLogin: status.passwordLogin, oidc: status.oidc, onDone: (u) => startApp(u) }));
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
  lyricsPane = attachLyrics($('.np'));
  bindKeys();
  bindDevices();
  attachSpectrum($('.np-canvas'));
  startVisualizer();
  refreshPlaylists();

  const main = $('.main');
  main.addEventListener('scroll', () => $('.topbar').classList.toggle('scrolled', main.scrollTop > 8), { passive: true });

  onRoute(render);
  startRouter();
  player.restore(user);
  startConnect();
  startAlarms();
}

// ───────────────────────── Layout ─────────────────────────

const logo = html`<div class="logo-mark"><span></span><span></span><span></span><span></span><span></span></div>`;

function shell() {
  const u = state.user;
  return html`<div class="shell">
    <a class="skip-link" href="#main" data-skip>${t('Skip to content')}</a>
    <aside class="sidebar" aria-label="${t('Sidebar')}">
      <a class="brand" href="/" aria-label="${t('Sonara home')}">${logo}<span class="brand-name">Sonara</span></a>
      <nav class="nav" aria-label="${t('Browse')}">${NAV.map(([href, i, label]) => html`<a class="nav-item" href="${href}" data-nav="${href}">${ic(i)}<span>${t(label)}</span></a>`)}</nav>
      <div class="nav-title"><span>${t('Your music')}</span>
        <button class="icon-btn sm" data-new-pl aria-label="${t('New playlist')}" title="${t('New playlist')}">${ic('plus')}</button></div>
      <nav class="nav" aria-label="${t('Your music')}">
        <a class="nav-item" href="/favorites" data-nav="/favorites">${ic('heart')}<span>${t('Favorites')}</span></a>
        <a class="nav-item" href="/playlists" data-nav="/playlists">${ic('listMusic')}<span>${t('Playlists')}</span></a>
        <a class="nav-item" href="/stats" data-nav="/stats">${ic('chart')}<span>${t('Your stats')}</span></a>
        ${u.isAdmin ? html`<a class="nav-item" href="/inbox" data-nav="/inbox">${ic('download')}<span>${t('Inbox')}</span></a>
          <a class="nav-item" href="/server" data-nav="/server">${ic('activity')}<span>${t('Server')}</span></a>` : ''}
      </nav>
      <nav class="nav-pl" aria-label="${t('Playlists')}"></nav>
      <div class="user-chip">
        <a href="/settings" class="avatar" title="${t('Settings')}" aria-hidden="true" tabindex="-1">${u.username[0]}</a>
        <a href="/settings" class="uc-text" style="flex:1;min-width:0"><div class="uc-name">${u.username}</div><div class="uc-role">${u.isAdmin ? t('Admin') : t('Listener')}</div></a>
        <a href="/settings" class="icon-btn sm uc-text" aria-label="${t('Settings')}" title="${t('Settings')}" data-nav="/settings">${ic('settings')}</a>
        <button class="icon-btn sm uc-text" data-logout aria-label="${t('Sign out')}" title="${t('Sign out')}">${ic('logout')}</button>
      </div>
    </aside>

    <main class="main" id="main" tabindex="-1">
      <div class="topbar">
        <button class="icon-btn" data-back aria-label="${t('Back')}">${ic('chevronLeft')}</button>
        <button class="icon-btn" data-fwd aria-label="${t('Forward')}">${ic('chevronRight')}</button>
        <label class="search" role="search">
          <input type="search" placeholder="${t('Search songs, albums, artists')}" aria-label="${t('Search')}" spellcheck="false">
          ${ic('search')}<kbd aria-hidden="true">/</kbd>
        </label>
        <div class="spacer"></div>
      </div>
      <div class="view-host"></div>
    </main>

    <footer class="playerbar" aria-label="${t('Player')}">
      <div class="pb-remote" hidden>${ic('cast')}<span data-remote-label></span><button class="btn sm ghost" data-play-here>${t('Play here')}</button><button class="icon-btn sm" data-leave-remote aria-label="${t('Stop controlling')}" title="${t('Stop controlling')}">${ic('x')}</button></div>
      <div class="pb-party" hidden>${ic('party')}<span data-party-label></span><button class="btn sm ghost" data-party-requests>${t('Requests')}</button><button class="btn sm ghost" data-party-copy>${t('Copy link')}</button><button class="btn sm ghost" data-party-leave>${t('Leave')}</button></div>
      <div class="pb-track">
        <button class="pb-cover" data-open-np title="${t('Now playing')}" aria-label="${t('Open Now Playing')}">${art(null, '')}<div class="expand">${ic('maximize')}</div></button>
        <div class="pb-meta"><div class="pb-title">${t('Nothing playing')}</div><div class="pb-artist">${t('Pick something you love')}</div></div>
        <button class="icon-btn sm heart hide-sm" data-pb-fav aria-label="${t('Favorite')}" aria-pressed="false">${ic('heart')}</button>
      </div>
      <div class="pb-center">
        <div class="pb-controls">
          <button class="icon-btn sm" data-shuffle aria-label="${t('Shuffle')}" aria-pressed="false" title="${t('Shuffle')} (S)">${ic('shuffle')}</button>
          <button class="icon-btn sm" data-skip-back aria-label="${t('Back 15 seconds')}" title="${t('Back 15 seconds')}" hidden>${ic('skipBack')}</button>
          <button class="icon-btn" data-prev aria-label="${t('Previous')}" title="${t('Previous')}">${ic('prev')}</button>
          <button class="pb-play" data-toggle aria-label="${t('Play')}">${ic('play')}</button>
          <button class="icon-btn" data-next aria-label="${t('Next')}" title="${t('Next')}">${ic('next')}</button>
          <button class="icon-btn sm" data-skip-fwd aria-label="${t('Forward 30 seconds')}" title="${t('Forward 30 seconds')}" hidden>${ic('skipFwd')}</button>
          <button class="icon-btn sm" data-repeat aria-label="${t('Repeat: off')}" title="${t('Repeat')} (R)">${ic('repeat')}</button>
        </div>
        <div class="pb-progress">
          <span class="time" data-cur aria-hidden="true">0:00</span>
          <input class="range" type="range" min="0" max="1000" value="0" step="1" data-seek aria-label="${t('Seek')}">
          <span class="time" data-dur aria-hidden="true">0:00</span>
        </div>
      </div>
      <div class="pb-right">
        <button class="icon-btn sm hide-sm" data-open-np aria-label="${t('Now playing')}" title="${t('Now playing')} (F)">${ic('maximize')}</button>
        ${miniSupported() ? html`<button class="icon-btn sm hide-sm" data-mini aria-label="${t('Mini player')}" title="${t('Mini player')} (P)">${ic('pip')}</button>` : ''}
        <button class="icon-btn sm hide-sm pb-extra" data-speed aria-label="${t('Playback speed')}" title="${t('Playback speed')}"><span class="pill-label">1×</span></button>
        <button class="icon-btn sm hide-sm" data-eq aria-label="${t('Equalizer')}" title="${t('Equalizer')} (E)">${ic('sliders')}</button>
        <button class="icon-btn sm hide-sm" data-sleep aria-label="${t('Sleep timer')}" title="${t('Sleep timer')}">${ic('moon')}</button>
        <button class="icon-btn sm" data-devices aria-label="${t('Devices')}" title="${t('Play on another device')}">${ic('cast')}</button>
        <button class="icon-btn sm" data-queue aria-label="${t('Queue')}" aria-expanded="false" title="${t('Queue')} (Q)">${ic('queue')}</button>
        <div class="volume">
          <button class="icon-btn sm" data-mute aria-label="${t('Mute')}" aria-pressed="false">${ic('volume')}</button>
          <input class="range" type="range" min="0" max="100" step="1" data-vol aria-label="${t('Volume')}">
        </div>
      </div>
    </footer>

    <nav class="mobile-nav" aria-label="${t('Browse')}">
      <a href="/" data-nav="/">${ic('home')}${t('Home')}</a>
      <a href="/search" data-nav="/search">${ic('search')}${t('Search')}</a>
      <a href="/albums" data-nav="/albums">${ic('disc')}${t('Albums')}</a>
      <a href="/podcasts" data-nav="/podcasts">${ic('podcast')}${t('Podcasts')}</a>
      <a href="/settings" data-nav="/settings">${ic('settings')}${t('Settings')}</a>
    </nav>
  </div>`;
}

const queueDrawer = () => html`<aside class="drawer" aria-label="${t('Queue')}" id="queue-drawer">
  <div class="drawer-head"><h2 class="h3">${t('Queue')}</h2><div class="row-gap">
    <span class="radio-chip" hidden>${ic('waves')}<span data-radio-label></span><button class="icon-btn sm" data-stop-radio aria-label="${t('Stop radio')}" title="${t('Stop radio')}">${ic('x')}</button></span>
    <button class="btn sm ghost" data-clear-q>${t('Clear')}</button>
    <button class="icon-btn sm" data-close-q aria-label="${t('Close queue')}">${ic('x')}</button></div></div>
  <div class="drawer-body"></div></aside>`;

const nowPlaying = () => html`<section class="np paused" role="dialog" aria-modal="true" aria-label="${t('Now playing')}">
  <div class="np-bg"></div>
  <canvas class="np-canvas" aria-hidden="true"></canvas>
  <div class="np-top">
    <button class="icon-btn" data-close-np aria-label="${t('Close Now Playing')}">${ic('chevronDown')}</button>
    <div class="label"><span data-np-source>${t('Playing from your library')}</span><b data-np-album></b></div>
    <div class="row-gap">
      <button class="icon-btn" data-np-vis aria-label="${t('Visualizer style')}" title="${t('Visualizer style')} (V)">${ic('activity')}</button>
      <button class="icon-btn" data-np-karaoke aria-label="${t('Karaoke')}" aria-pressed="false" title="${t('Karaoke: vocals down, big lyrics')} (K)">${ic('party')}</button>
      <button class="icon-btn" data-np-lyrics aria-label="${t('Lyrics')}" title="${t('Lyrics')} (L)">${ic('mic')}</button>
      <button class="icon-btn" data-np-more aria-label="${t('More options')}">${ic('more')}</button>
    </div>
  </div>
  <div class="np-stage"><div class="np-art">${art(null, '')}</div><div class="np-lyrics" aria-live="off"></div></div>
  <div class="np-bottom">
    <div class="np-info">
      <div class="t"><div class="np-title">—</div><div class="np-artist"></div></div>
      <button class="icon-btn lg heart" data-np-fav aria-label="${t('Favorite')}" aria-pressed="false">${ic('heart')}</button>
    </div>
    <div class="np-progress">
      <span class="time" data-cur>0:00</span>
      <input class="range" type="range" min="0" max="1000" value="0" data-seek aria-label="${t('Seek')}">
      <span class="time" data-dur>0:00</span>
    </div>
    <div class="np-controls">
      <button class="icon-btn" data-shuffle aria-label="${t('Shuffle')}" aria-pressed="false">${ic('shuffle')}</button>
      <button class="icon-btn" data-skip-back aria-label="${t('Back 15 seconds')}" hidden>${ic('skipBack')}</button>
      <button class="icon-btn lg" data-prev aria-label="${t('Previous')}">${ic('prev')}</button>
      <button class="pb-play" data-toggle aria-label="${t('Play')}">${ic('play')}</button>
      <button class="icon-btn lg" data-next aria-label="${t('Next')}">${ic('next')}</button>
      <button class="icon-btn" data-skip-fwd aria-label="${t('Forward 30 seconds')}" hidden>${ic('skipFwd')}</button>
      <button class="icon-btn" data-repeat aria-label="${t('Repeat: off')}">${ic('repeat')}</button>
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
    const on = n === '/' ? url.pathname === '/' : url.pathname.startsWith(n) || (n === '/albums' && url.pathname.startsWith('/album/')) || (n === '/artists' && url.pathname.startsWith('/artist/')) || (n === '/playlists' && url.pathname.startsWith('/playlist/')) || (n === '/podcasts' && url.pathname.startsWith('/podcast/'));
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
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
      ? emptyState('alert', t('Nothing here'), t("This page doesn't exist — maybe the music moved?"), html`<a class="btn primary" href="/">${t('Go home')}</a>`)
      : emptyState('alert', t('Something went wrong'), err.message)}</div>`);
  }
  if (seq !== renderSeq) { view._destroy?.(); return; }
  currentView?._destroy?.();
  currentView = view;
  view.classList.add('view', 'view-enter');
  host.replaceChildren(view);
  main.scrollTop = scroll;
  settlePalette();
  // Screen readers: say which page opened, and start reading from its heading
  // (but leave focus alone while someone is typing a search).
  if (firstRender) { firstRender = false; return; }
  const heading = view.querySelector('h1');
  if (url.pathname !== '/search' && document.activeElement !== $('.search input')) {
    if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); } else main.focus({ preventScroll: true });
  }
  announce(heading?.textContent.trim() || t('Page loaded'));
}
let firstRender = true;

// ───────────────────────── Sidebar ─────────────────────────

function bindSidebar() {
  $('[data-skip]').addEventListener('click', (e) => { e.preventDefault(); const h = $('.view-host h1') || $('.main'); h.tabIndex = -1; h.focus(); });
  const box = $('.nav-pl');
  const draw = (pls) => {
    box.innerHTML = String(html`${state.smartPlaylists.map((p) => html`<a class="nav-item" href="/smart/${p.id}">
      <div class="pl-thumb smart">${ic('sparkles')}</div><span>${p.name}</span></a>`)}${pls.map((p) => html`<a class="nav-item" href="/playlist/${p.id}">
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
    navigator.serviceWorker?.controller?.postMessage('clear-api');
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
  scope.querySelector('[data-skip-back]')?.addEventListener('click', () => player.seek(player.time - 15));
  scope.querySelector('[data-skip-fwd]')?.addEventListener('click', () => player.seek(player.time + 30));

  const seek = scope.querySelector('[data-seek]');
  const cur = scope.querySelector('[data-cur]');
  const dur = scope.querySelector('[data-dur]');
  let dragging = false;

  // Waveform drawn behind the seek bar (once the song has been analysed).
  const wrap = document.createElement('div');
  wrap.className = 'seek-wrap';
  seek.before(wrap);
  const wave = document.createElement('canvas');
  wave.className = 'wave';
  wave.setAttribute('aria-hidden', 'true');
  const ticks = document.createElement('div');
  ticks.className = 'ticks';
  ticks.setAttribute('aria-hidden', 'true');
  wrap.append(wave, ticks, seek);
  const loadTicks = async (tr) => {
    ticks.replaceChildren();
    if (!tr || tr.live) return;
    const list = await markTicks(tr).catch(() => []);
    if (player.current !== tr) return;
    ticks.innerHTML = String(html`${list.map((m) => html`<i class="${m.kind}" style="left:${(m.at * 100).toFixed(3)}%" title="${m.title}"></i>`)}`);
  };
  player.on('marks', (id) => { if (player.current?.id === id) loadTicks(player.current); });
  let peaks = null;
  let drawnAt = -1;
  const paint = (force = false) => {
    if (!peaks) return;
    const p = player.duration ? Math.min(1, player.time / player.duration) : 0;
    const px = Math.round(p * wave.clientWidth);
    if (!force && px === drawnAt) return;
    drawnAt = px;
    const css = getComputedStyle(document.body);
    drawWave(wave, peaks, p, { played: css.getPropertyValue('--accent').trim() || '#fff', rest: 'rgba(255,255,255,.22)' });
  };
  const loadWave = async (tr) => {
    peaks = null;
    wrap.classList.remove('has-wave');
    const ctx = wave.getContext('2d');
    ctx.clearRect(0, 0, wave.width, wave.height);
    if (!tr || typeof tr.id !== 'number' || prefs.get('waveform', true) === false) return;
    const a = await getAnalysis(tr);
    if (player.current !== tr || !a?.peaks) return;
    peaks = a.peaks;
    wrap.classList.add('has-wave');
    paint(true);
  };
  player.on('track', (tr) => { if (wrap.dataset.id !== String(tr?.id)) { wrap.dataset.id = tr?.id ?? ''; loadWave(tr); loadTicks(tr); } });
  player.on('analysis', (id) => { if (player.current?.id === id) { wrap.dataset.id = ''; loadWave(player.current); } });
  addEventListener('resize', () => paint(true));
  new MutationObserver(() => paint(true)).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
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
  player.on('time', (now, d) => {
    if (dragging) return;
    paint();
    const live = !!player.current?.live;
    setRange(seek, live ? 0 : now, live ? 0 : d);
    cur.textContent = fmtTime(now);
    dur.textContent = live ? t('LIVE') : fmtTime(d);
    seek.setAttribute('aria-valuetext', live ? t('Live stream, {time} listened', { time: fmtTime(now) }) : t('{time} of {total}', { time: fmtTime(now), total: fmtTime(d) }));
  });
  player.on('track', (tr) => {
    const ep = isEpisode(tr);
    scope.querySelectorAll('[data-skip-back], [data-skip-fwd]').forEach((b) => { b.hidden = !ep; });
    scope.classList.toggle('live', !!tr?.live);
    seek.disabled = !!tr?.live;
  });
  player.on('state', (playing) => {
    const b = scope.querySelector('[data-toggle]');
    b.innerHTML = ic(playing ? 'pause' : 'play');
    b.setAttribute('aria-label', playing ? t('Pause') : t('Play'));
  });
  player.on('mode', () => {
    const sh = scope.querySelector('[data-shuffle]');
    sh.classList.toggle('on', player.shuffle);
    sh.setAttribute('aria-pressed', String(player.shuffle));
    const r = scope.querySelector('[data-repeat]');
    r.classList.toggle('on', player.repeat !== 'off');
    r.innerHTML = ic(player.repeat === 'one' ? 'repeatOne' : 'repeat');
    r.setAttribute('aria-label', t({ off: 'Repeat: off', all: 'Repeat: all', one: 'Repeat: this song' }[player.repeat]));
  });
}

/** Songs without an analysis get one: by the server (ffmpeg), or in this browser after a few seconds of play. */
function bindAnalysis() {
  let timer = null;
  player.on('track', (tr) => {
    clearTimeout(timer);
    if (!isLibrary(tr)) return;
    timer = setTimeout(async () => {
      if (player.current !== tr) return;
      forgetAnalysis(tr.id);
      const before = await getAnalysis(tr);
      if (before?.analyzed) return;
      if (before?.pending) {
        // The server is on it; check back shortly.
        setTimeout(async () => { forgetAnalysis(tr.id); const a = await getAnalysis(tr); if (a?.analyzed) player.emit('analysis', tr.id); }, 20000);
        return;
      }
      forgetAnalysis(tr.id);
      const a = await getAnalysis(tr, { analyse: true });
      if (a?.analyzed) player.emit('analysis', tr.id);
    }, 6000);
  });
}

function bindPlayerBar() {
  const bar = $('.playerbar');
  bindTransport(bar);
  bindAnalysis();

  const vol = $('[data-vol]', bar);
  const mute = $('[data-mute]', bar);
  const drawVol = () => {
    const v = player.muted ? 0 : player.volume;
    setRange(vol, v, 1);
    vol.setAttribute('aria-valuetext', `${Math.round(v * 100)}%`);
    mute.innerHTML = ic(v === 0 ? 'mute' : v < 0.5 ? 'volumeLow' : 'volume');
    mute.setAttribute('aria-pressed', String(!!player.muted));
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
  $('[data-queue]', bar).addEventListener('click', () => toggleQueue(undefined, { focus: true }));
  $('[data-mini]', bar)?.addEventListener('click', () => toggleMiniPlayer().catch((err) => toast(err.message, { type: 'error' })));

  // Playback speed
  const speed = $('[data-speed]', bar);
  const drawRate = (r) => {
    speed.querySelector('.pill-label').textContent = `${r}×`;
    speed.classList.toggle('on', r !== 1);
  };
  drawRate(player.rate);
  player.on('rate', drawRate);
  speed.addEventListener('click', () => openMenu(speed, [
    { head: t('Playback speed') },
    ...[0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2].map((r) => ({
      icon: r === player.rate ? 'check' : null, label: r === 1 ? t('Normal') : `${r}×`, action: () => player.setRate(r),
    })),
  ]));

  // Equalizer
  const eqBtn = $('[data-eq]', bar);
  const drawEq = () => eqBtn.classList.toggle('on', !!eq.enabled || sound.active);
  drawEq();
  eqBtn.addEventListener('click', async () => { await openEqualizer(); drawEq(); });

  // Sleep timer
  const sleep = $('[data-sleep]', bar);
  let sleepTick = null;
  const drawSleep = (s) => {
    clearInterval(sleepTick);
    sleep.classList.toggle('on', !!s);
    const label = () => {
      if (!player.sleep) return t('Sleep timer');
      if (player.sleep.endOfTrack) return t('Sleep timer: stops after this song');
      return t('Sleep timer: {n} min left', { n: Math.max(1, Math.ceil((player.sleep.at - Date.now()) / 60000)) });
    };
    sleep.title = label();
    if (s?.at) sleepTick = setInterval(() => { sleep.title = label(); }, 15000);
  };
  player.on('sleep', drawSleep);
  sleep.addEventListener('click', () => openMenu(sleep, [
    { head: sleep.title },
    ...[5, 15, 30, 45, 60, 90].map((m) => ({ icon: 'clock', label: t('{n} minutes', { n: m }), action: () => { player.setSleep(m); toast(t('Sleep timer set for {n} minutes', { n: m })); } })),
    { icon: 'music', label: t('End of this song'), action: () => { player.setSleep('track'); toast(t('Playback will stop after this song')); } },
    ...(player.sleep ? ['sep', { icon: 'x', label: t('Turn off timer'), action: () => { player.setSleep(null); toast(t('Sleep timer off')); } }] : []),
    'sep',
    { icon: 'clock', label: html`${t('Wake-up alarm…')}${alarmLabel() ? html`<small class="menu-sub">${alarmLabel()}</small>` : ''}`, action: () => alarmDialog() },
  ]));

  let lastAnnounced = null;
  player.on('track', (tr) => {
    if (!tr) return;
    const meta = $('.pb-meta', bar);
    const same = meta.dataset.id === String(tr.id);
    meta.dataset.id = tr.id;
    meta.innerHTML = String(html`<div class="pb-title ${same ? '' : 'swap'}" title="${tr.title}">${tr.title}</div>
      <div class="pb-artist ${same ? '' : 'swap'}">${subtitle(tr)}</div>`);
    if (!same) {
      $('.pb-cover', bar).innerHTML = String(html`${art(tr.cover, tr.album, isEpisode(tr) ? 'podcast' : isStation(tr) ? 'radio' : 'disc', 120)}<div class="expand">${ic('maximize')}</div>`);
      $('.pb-cover', bar).firstElementChild.classList.add('swap');
    }
    const fav = $('[data-pb-fav]', bar);
    fav.hidden = !isLibrary(tr);
    fav.dataset.fav = tr.id;
    fav.classList.toggle('on', !!tr.favorite);
    fav.setAttribute('aria-pressed', String(!!tr.favorite));
    fav.innerHTML = ic(tr.favorite ? 'heartFill' : 'heart');
    setPlayingCover(tr.cover);
    // Tell screen readers what started (once per song, and for radio when the song on air changes).
    const key = `${tr.id}|${tr.artist}`;
    if (key !== lastAnnounced && player.playing) announce(t('Now playing: {title} by {artist}', { title: tr.title, artist: tr.artist }));
    lastAnnounced = key;
  });
  player.on('state', (playing) => {
    const tr = player.current;
    if (playing && tr && lastAnnounced !== `${tr.id}|${tr.artist}`) {
      lastAnnounced = `${tr.id}|${tr.artist}`;
      announce(t('Now playing: {title} by {artist}', { title: tr.title, artist: tr.artist }));
    }
  });
  // The speed button means nothing for live radio.
  player.on('track', (tr) => { speed.disabled = !!tr?.live; });
}

// ───────────────────────── Devices (Connect, casting, parties) ─────────────────────────

const KIND_ICON = { browser: 'laptop', jukebox: 'speaker', dlna: 'speaker', cast: 'cast', snapcast: 'speaker' };

function deviceLine(d) {
  const s = d.state;
  if (!s?.track) return d.kind === 'browser' ? 'Idle' : d.kind === 'jukebox' ? 'Server speakers' : 'Network speaker';
  return `${s.playing ? 'Playing' : 'Paused'}: ${s.track.title} · ${s.track.artist}`;
}

function openDevices(anchor) {
  const remote = player.remote;
  const devs = connect.devices;
  const localPlaying = !remote && player.local.current;
  const items = [{ head: remote ? `Controlling ${remote.name}` : 'Play on' }];
  items.push({
    icon: remote ? 'laptop' : 'check',
    label: `This browser${remote ? ' (play here)' : ''}`,
    action: () => remote && playHere(),
  });
  for (const d of devs) {
    const active = remote?.id === d.id;
    items.push({
      icon: active ? 'check' : KIND_ICON[d.kind] || 'speaker',
      label: html`${d.name}<small class="menu-sub">${deviceLine(d)}</small>`,
      action: () => {
        if (active) return;
        // Something playing here: move it over. Otherwise just take control of that device.
        if (localPlaying) moveTo(d);
        else controlDevice(d);
      },
    });
  }
  if (!devs.length) items.push({ icon: 'info', label: html`No other devices<small class="menu-sub">Open Sonara on your phone or another computer</small>` });
  if (castSupported()) items.push('sep', { icon: 'cast', label: 'Cast to Chromecast…', action: () => startCast() });
  items.push('sep');
  const p = connect.party;
  if (p) {
    if (p.hostClient === clientId) {
      items.push({ icon: 'link', label: 'Copy party link', action: () => copyText(partyUrl(p)) });
      items.push({ icon: 'x', label: 'End listening party', danger: true, action: () => leaveParty({ end: true }) });
    } else items.push({ icon: 'x', label: `Leave ${p.host}'s party`, action: () => leaveParty() });
  } else if (!remote) {
    items.push({ icon: 'party', label: html`Start a listening party<small class="menu-sub">Friends with an account listen along in sync</small>`, action: async () => {
      const party = await startParty();
      if (party) copyText(partyUrl(party));
    } });
  }
  if (remote) items.push({ icon: 'x', label: `Stop controlling ${remote.name}`, action: () => player.leaveRemote() });
  openMenu(anchor, items);
}

function bindDevices() {
  const bar = $('.playerbar');
  const btn = $('[data-devices]', bar);
  btn.addEventListener('click', () => openDevices(btn));
  const drawBtn = () => {
    btn.classList.toggle('on', !!player.remote);
    btn.classList.toggle('has-devices', connect.devices.length > 0);
    btn.title = player.remote ? `Playing on ${player.remote.name}` : connect.devices.length ? `${connect.devices.length} other device${connect.devices.length === 1 ? '' : 's'} available` : 'Play on another device';
  };
  connect.on('devices', drawBtn);
  const banner = $('.pb-remote', bar);
  player.on('remote', (r) => {
    banner.hidden = !r;
    if (r) $('[data-remote-label]', banner).textContent = `Playing on ${r.name}`;
    drawBtn();
    if (!r && !player.current) {
      $('.pb-meta', bar).innerHTML = String(html`<div class="pb-title">Nothing playing</div><div class="pb-artist">Pick something you love</div>`);
    }
  });
  $('[data-play-here]', banner).addEventListener('click', () => playHere());
  $('[data-leave-remote]', banner).addEventListener('click', () => player.leaveRemote());

  const pbar = $('.pb-party', bar);
  connect.on('party', (p) => {
    state.party = p;
    pbar.hidden = !p;
    const reqBtn = $('[data-party-requests]', pbar);
    const nReq = p?.requests?.length || 0;
    reqBtn.textContent = nReq ? `${t('Requests')} (${nReq})` : t('Requests');
    reqBtn.classList.toggle('on', nReq > 0);
    document.body.classList.toggle('in-party', !!p);
    if (!p) return;
    const host = p.hostClient === clientId;
    const n = p.members?.length || 0;
    $('[data-party-label]', pbar).textContent = host
      ? `Your listening party · ${n ? `${n} listening along` : 'share the link to invite people'}`
      : `Listening along with ${p.host}${n > 1 ? ` and ${n - 1} other${n > 2 ? 's' : ''}` : ''}`;
    $('[data-party-copy]', pbar).hidden = !host;
    $('[data-party-leave]', pbar).textContent = host ? 'End' : 'Leave';
  });
  $('[data-party-requests]', pbar).addEventListener('click', () => requestsDialog());
  $('[data-party-copy]', pbar).addEventListener('click', () => connect.party && copyText(partyUrl(connect.party)));
  $('[data-party-leave]', pbar).addEventListener('click', () => leaveParty({ end: connect.party?.hostClient === clientId }));
}

// ───────────────────────── Queue drawer ─────────────────────────

const queueOpen = () => $('.drawer').classList.contains('open');
function toggleQueue(force, { focus = false } = {}) {
  const d = $('.drawer');
  const was = d.classList.contains('open');
  const open = force ?? !was;
  d.classList.toggle('open', open);
  d.inert = !open;
  const btn = $('[data-queue]');
  btn.classList.toggle('on', open);
  btn.setAttribute('aria-expanded', String(open));
  if (open) drawQueue();
  if (focus && open && !was) requestAnimationFrame(() => $('[data-close-q]', d).focus());
  if (!open && was && d.contains(document.activeElement)) btn.focus();
}

function drawQueue() {
  const body = $('.drawer-body');
  const cur = player.current;
  if (!cur) { body.innerHTML = String(emptyState('queue', t('Queue is empty'), t('Play an album or a song and it shows up here.'))); return; }
  const up = player.upNext.slice(0, 300);
  const item = (tr, i, isCur) => html`<div class="q-item ${isCur ? 'current' : ''}" data-q="${i}" role="listitem" style="--i:${isCur ? 0 : i - player.index}" ${isCur ? 'aria-current="true"' : html`draggable="true" tabindex="0" aria-label="${t('Play {title} by {artist}', { title: tr.title, artist: tr.artist })}"`}>
    <div class="tl-cover">${art(tr.cover, tr.album, isEpisode(tr) ? 'podcast' : isStation(tr) ? 'radio' : 'disc', 80)}</div>
    <div class="tl-text"><div class="tl-title">${tr.title}</div><div class="tl-sub">${tr.artist}</div></div>
    ${isCur ? html`<span class="eq" aria-hidden="true"><i></i><i></i><i></i><i></i></span>` : html`<button class="icon-btn sm" data-q-rm="${i}" aria-label="${t('Remove {title} from the queue', { title: tr.title })}">${ic('x')}</button>`}
  </div>`;
  body.innerHTML = String(html`
    <h3 class="q-label">${t('Now playing')}</h3><div role="list">${item(cur, player.index, true)}</div>
    <h3 class="q-label">${t('Up next')}${player.shuffle ? ` · ${t('shuffled')}` : ''}</h3>
    <div class="q-up" role="list">${up.length ? up.map((tr, k) => item(tr, player.index + 1 + k, false)) : html`<p class="muted" style="padding:0 12px">${t('Nothing queued.')} ${player.repeat === 'all' ? t('The queue will repeat.') : ''}</p>`}</div>
    ${player.upNext.length > up.length ? html`<p class="muted" style="padding:8px 12px">${t('…and {n} more', { n: player.upNext.length - up.length })}</p>` : ''}`);
}

function bindQueue() {
  const d = $('.drawer');
  $('[data-close-q]', d).addEventListener('click', () => toggleQueue(false));
  $('[data-clear-q]', d).addEventListener('click', () => player.clearUpNext());
  const chip = $('.radio-chip', d);
  player.on('radio', (r) => {
    chip.hidden = !r;
    if (r) $('[data-radio-label]', chip).textContent = t('{name} radio', { name: r.label });
  });
  $('[data-stop-radio]', d).addEventListener('click', () => { player.stopRadio(); toast(t('Radio stopped: the queue won’t refill any more')); });
  const body = $('.drawer-body', d);
  body.addEventListener('click', (e) => {
    const rm = e.target.closest('[data-q-rm]');
    if (rm) return player.removeAt(Number(rm.dataset.qRm));
    const it = e.target.closest('[data-q]');
    if (it && !it.classList.contains('current')) player.jump(Number(it.dataset.q));
  });
  body.addEventListener('keydown', (e) => {
    const it = e.target.closest('[data-q]');
    if (!it || e.target !== it) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); player.jump(Number(it.dataset.q)); }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      const next = it.nextElementSibling || it.previousElementSibling;
      player.removeAt(Number(it.dataset.q));
      requestAnimationFrame(() => (body.querySelector(`[data-q="${next?.dataset.q}"]`) || $('[data-close-q]', d)).focus());
    }
  });
  body.addEventListener('contextmenu', (e) => {
    const it = e.target.closest('[data-q]');
    if (!it) return;
    e.preventDefault();
    const tr = player.queue[Number(it.dataset.q)];
    if (isLibrary(tr)) trackMenu(e, tr);
  });
  dragSort(body, '.q-up .q-item', (from, to) => player.move(player.index + 1 + from, player.index + 1 + to));
  player.on('queue', () => queueOpen() && drawQueue());
}

// ───────────────────────── Now playing ─────────────────────────

let npReturnFocus = null;
function toggleNowPlaying(force) {
  const np = $('.np');
  const was = np.classList.contains('open');
  const open = force ?? !was;
  np.classList.toggle('open', open);
  np.inert = !open;
  // While it covers the page, keep keyboard and screen-reader focus inside it.
  $('.shell').inert = open;
  if (open) toggleQueue(false);
  if (open && !was) {
    npReturnFocus = document.activeElement;
    requestAnimationFrame(() => $('[data-close-np]', np).focus());
  } else if (!open && was) {
    (npReturnFocus?.isConnected && npReturnFocus !== document.body ? npReturnFocus : $('.playerbar [data-toggle]'))?.focus?.();
    npReturnFocus = null;
  }
}

function bindNowPlaying() {
  const np = $('.np');
  bindTransport(np);
  $('[data-close-np]', np).addEventListener('click', () => toggleNowPlaying(false));
  $('[data-np-fav]', np).addEventListener('click', () => player.current && toggleFavorite(player.current));
  np.inert = true;
  bindVisualizerStyle(np);
  bindKaraoke(np);
  $('[data-np-more]', np).addEventListener('click', async (e) => {
    const tr = player.current;
    const at = e.currentTarget;
    if (!tr) return;
    const marks = player.remote ? [] : await markMenuItems().catch(() => []);
    if (isLibrary(tr)) return trackMenu(at, tr, { extra: marks });
    if (isEpisode(tr)) {
      return openMenu(at, [
        { icon: 'podcast', label: t('Go to podcast'), action: () => { toggleNowPlaying(false); navigate(`/podcast/${tr.podcastId}`); } },
        { icon: 'checkCircle', label: t('Mark as played'), action: () => { player.markPlayed(); player.next(); } },
        ...(marks.length ? ['sep', ...marks] : []),
      ]);
    }
    openMenu(e.currentTarget, [
      { icon: 'radio', label: t('Go to Radio'), action: () => { toggleNowPlaying(false); navigate('/radio'); } },
      ...(tr.homepage ? [{ icon: 'globe', label: t('Open website'), action: () => window.open(tr.homepage, '_blank', 'noopener') }] : []),
    ]);
  });
  np.addEventListener('click', (e) => { if (e.target.closest('a[href]')) toggleNowPlaying(false); });

  let shownId = null;
  player.on('track', (tr) => {
    if (!tr) return;
    const same = shownId === tr.id;
    shownId = tr.id;
    if (!same) {
      $('.np-bg', np).style.backgroundImage = tr.cover ? `url("/api/cover/${tr.cover}")` : '';
      const a = $('.np-art', np);
      a.innerHTML = String(art(tr.cover, tr.album, isEpisode(tr) ? 'podcast' : isStation(tr) ? 'radio' : 'disc', 600));
      a.classList.remove('swap'); void a.offsetWidth; a.classList.add('swap');
    }
    $('.np-title', np).textContent = tr.title;
    $('.np-artist', np).innerHTML = String(subtitle(tr, ' — '));
    $('[data-np-source]', np).textContent = t({ 'Your library': 'Playing from your library', Podcast: 'Playing a podcast', 'Internet radio': 'Listening to the radio' }[sourceLabel(tr)]);
    $('[data-np-album]', np).textContent = tr.album;
    const fav = $('[data-np-fav]', np);
    fav.hidden = !isLibrary(tr);
    fav.dataset.fav = tr.id;
    fav.classList.toggle('on', !!tr.favorite);
    fav.setAttribute('aria-pressed', String(!!tr.favorite));
    fav.innerHTML = ic(tr.favorite ? 'heartFill' : 'heart');
    const tech = tr.live ? [t('Live stream')]
      : isEpisode(tr) ? [tr.publishedAt && new Date(tr.publishedAt).toLocaleDateString(document.documentElement.lang, { dateStyle: 'medium' })]
        : [tr.codec, tr.sampleRate && `${(tr.sampleRate / 1000).toFixed(1)} kHz`, tr.bitrate && `${Math.round(tr.bitrate / 1000)} kbps`];
    $('.np-tech', np).textContent = tech.filter(Boolean).join(' · ');
  });
  player.on('state', (playing) => np.classList.toggle('paused', !playing));
}

// ───────────────────────── Visualizer styles and karaoke ─────────────────────────

const VIS_LABEL = { bars: 'Bars', wave: 'Wave', radial: 'Radial', milkdrop: 'Milkdrop' };

async function setVisStyle(np, style) {
  if (style === 'milkdrop' && !prefs.get('milkdropOk', false)) {
    const { confirmDialog } = await import('./ui.js');
    const ok = await confirmDialog({ title: t('Load Milkdrop visualizer?'), message: t('Milkdrop presets need the butterchurn library (about 850 KB), downloaded from cdn.jsdelivr.net. Nothing about your music is sent.'), confirm: t('Load') });
    if (!ok) return;
    prefs.set('milkdropOk', true);
  }
  prefs.set('visStyle', style);
  np.classList.toggle('vis-milkdrop', style === 'milkdrop');
  if (style === 'milkdrop') {
    try { await startMilkdrop($('.np-stage', np).parentElement); } catch (err) { toast(err.message, { type: 'error' }); prefs.set('visStyle', 'bars'); np.classList.remove('vis-milkdrop'); return; }
  } else stopMilkdrop();
  toast(t('Visualizer: {name}', { name: t(VIS_LABEL[style]) }), { ms: 1200 });
}

function bindVisualizerStyle(np) {
  const btn = $('[data-np-vis]', np);
  const next = () => setVisStyle(np, VIS_STYLES[(VIS_STYLES.indexOf(visStyle()) + 1) % VIS_STYLES.length]);
  btn.addEventListener('click', next);
  btn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openMenu(e, [{ head: t('Visualizer style') }, ...VIS_STYLES.map((s) => ({ icon: s === visStyle() ? 'check' : null, label: t(VIS_LABEL[s]), action: () => setVisStyle(np, s) })),
      ...(visStyle() === 'milkdrop' ? ['sep', { icon: 'refresh', label: t('Next preset'), action: () => nextPreset(1) }] : [])]);
  });
  np.addEventListener('dblclick', (e) => { if (visStyle() === 'milkdrop' && !e.target.closest('button, input, a, .np-lyrics')) nextPreset(1); });
  // Milkdrop needs the audio graph; start it when Now Playing opens.
  new MutationObserver(() => {
    if (np.classList.contains('open') && visStyle() === 'milkdrop' && prefs.get('milkdropOk', false) && player.analyser) startMilkdrop($('.np-stage', np).parentElement).catch(() => {});
    if (!np.classList.contains('open')) stopMilkdrop();
  }).observe(np, { attributes: true, attributeFilter: ['class'] });
  np.classList.toggle('vis-milkdrop', visStyle() === 'milkdrop');
}

/** Karaoke: vocals turned down (centre cancellation) and big, centred synced lyrics. */
function bindKaraoke(np) {
  const btn = $('[data-np-karaoke]', np);
  let before = null;
  const set = (on) => {
    np.classList.toggle('karaoke', on);
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
    if (on) { before = prefs.get('karaoke', false); prefs.set('karaoke', true); if (!np.classList.contains('show-lyrics')) lyricsPane?.toggle(); }
    else if (before !== null) { prefs.set('karaoke', before); before = null; }
    player.applyEq();
  };
  btn.addEventListener('click', () => set(!np.classList.contains('karaoke')));
  karaokeToggle = () => { toggleNowPlaying(true); set(!np.classList.contains('karaoke')); };
}
let karaokeToggle = () => {};

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
    // Space and Enter belong to whatever button, link or list item has focus.
    if ((k === ' ' || k === 'Enter') && e.target.closest?.('button, a[href], [role=button], [tabindex]:not([tabindex="-1"]), summary')) return;
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
      p: () => miniSupported() && toggleMiniPlayer().catch(() => {}),
      l: () => { if (player.current) { toggleNowPlaying(true); lyricsPane?.toggle(); } },
      b: () => player.current && addBookmark(),
      v: () => { if (player.current) { toggleNowPlaying(true); $('[data-np-vis]').click(); } },
      k: () => player.current && karaokeToggle(),
      e: async () => { await openEqualizer(); $('[data-eq]')?.classList.toggle('on', !!eq.enabled || sound.active); },
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
