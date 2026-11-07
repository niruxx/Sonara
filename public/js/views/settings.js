// Settings: account, appearance, and (for admins) library folders, scanning and users.
import { api } from '../api.js';
import { html, ic, el, plural, fmtBytes, fmtLong, prefs } from '../util.js';
import { state } from '../state.js';
import { toast, toastError, confirmDialog, formDialog, modal } from '../ui.js';
import { refreshTheme, THEMES } from '../theme.js';
import { player, playback } from '../player.js';
import { preferredCodec } from '../api.js';
import { eqEditor } from '../eq.js';
import { organizeDialog } from '../fileops.js';
import { accountExtras, adminPanels, bindExtras, userAccessDialog, offlinePanel } from './settings-extra.js';
import { t, LANGUAGES, langPref, setLangPref } from '../i18n.js';

const QUALITIES = [[0, 'Original quality'], [320, '320 kbps'], [256, '256 kbps'], [192, '192 kbps'], [160, '160 kbps'], [128, '128 kbps'], [96, '96 kbps'], [64, '64 kbps']];

export async function settingsView({ query } = {}) {
  const admin = state.user.isAdmin;
  const [stats, settings, users, scan, toolInfo] = await Promise.all([
    api.get('/stats'),
    admin ? api.get('/admin/settings') : null,
    admin ? api.get('/admin/users') : null,
    admin ? api.get('/admin/scan') : null,
    admin ? api.get('/admin/tools').catch(() => null) : null,
  ]);

  const v = el(html`<div>
    <h1 class="page-title">${t('Settings')}</h1>
    <p class="page-sub">${t('Signed in as')} <b>${state.user.username}</b>${admin ? ` · ${t('Administrator')}` : ''}</p>
    <div class="panels">
      <section class="panel wide" style="--i:0">
        <h3>${ic('waves')} Your library</h3><p>A quick look at what Sonara is keeping track of.</p>
        <div class="stats">
          <div class="stat"><b>${stats.tracks.toLocaleString()}</b><span>Songs</span></div>
          <div class="stat"><b>${stats.albums.toLocaleString()}</b><span>Albums</span></div>
          <div class="stat"><b>${stats.artists.toLocaleString()}</b><span>Artists</span></div>
          <div class="stat"><b>${fmtLong(stats.duration).replace(' min', 'm').replace(' hr ', 'h ')}</b><span>Total length</span></div>
          <div class="stat"><b>${fmtBytes(stats.size)}</b><span>On disk</span></div>
          <div class="stat"><b>${stats.plays.toLocaleString()}</b><span>Your plays</span></div>
        </div>
      </section>

      ${admin ? html`
      <section class="panel" style="--i:1" data-panel="library">
        <h3>${ic('folder')} Music folders</h3>
        <p>Sonara scans these folders (and everything inside them) for music.</p>
        <div class="dirs"></div>
        <div class="row-gap" style="margin-top:12px">
          <button class="btn sm primary" data-add-dir>${ic('folderPlus')} Add folder</button>
        </div>
        ${settings.envMusicDirs ? html`<p class="muted" style="margin-top:12px">Note: SONARA_MUSIC_DIRS is set in the environment and overrides this list.</p>` : ''}
      </section>

      <section class="panel" style="--i:2" data-panel="scan">
        <h3>${ic('refresh')} Library scan</h3>
        <p>New, changed and removed files are picked up automatically.</p>
        <div class="scan-status"></div>
        <div class="row-gap" style="margin-top:14px">
          <button class="btn sm primary" data-scan>${ic('refresh')} Scan now</button>
          <button class="btn sm" data-scan-full>Full rescan</button>
        </div>
        <div style="margin-top:18px">
          <label class="muted">Automatic scan every</label>
          <div class="row-gap" style="margin-top:6px">
            <input class="input" type="number" min="0" max="10080" value="${settings.scanIntervalMinutes}" data-interval style="width:110px">
            <span class="muted">minutes (0 = off)</span>
          </div>
          <label class="check" style="margin-top:12px"><input type="checkbox" data-startup ${settings.scanOnStartup ? 'checked' : ''}><span class="sw"></span>Scan when Sonara starts</label>
          <label class="check"><input type="checkbox" data-watch ${settings.watch ? 'checked' : ''}><span class="sw"></span>Watch folders for changes (updates within seconds)</label>
        </div>
      </section>

      <section class="panel wide" style="--i:3" data-panel="files">
        <h3>${ic('folder')} File management</h3>
        <p>Let Sonara edit tags and move, rename and organize your music files. Off by default, because it changes files on disk.</p>
        <label class="check"><input type="checkbox" data-allow-files ${settings.allowFileChanges ? 'checked' : ''}><span class="sw"></span>Allow Sonara to change files</label>
        <div class="row-gap" style="margin-top:12px">
          <button class="btn sm" data-organize-lib>${ic('folder')} Organize library…</button>
          <a class="btn sm" href="/inbox">${ic('download')} Open Inbox</a>
        </div>
        <div style="margin-top:16px">
          <label class="muted">Downloads &amp; conversions go to (the Inbox)</label>
          <div class="list-row" style="animation:none;margin-top:6px">${ic('download')}<span class="grow mono" data-dl-dir>${settings.downloadsDir}</span>
            <button class="btn sm ghost" data-dl-change>Change…</button></div>
        </div>
        <div style="margin-top:16px">
          <label class="muted">Transcoding cache</label>
          <div class="list-row" style="animation:none;margin-top:6px">${ic('waves')}<span class="grow" data-cache-info>…</span>
            <input class="input sm" type="number" min="0" step="256" value="${settings.transcodeCacheMB}" data-cache-mb style="width:100px" aria-label="Cache size in MB"><span class="muted">MB</span>
            <button class="btn sm ghost" data-cache-clear>Clear</button></div>
        </div>
        <div class="tool-status">
          ${[['ffmpeg', 'ffmpeg', 'Tag editing and video → audio conversion'], ['ytdlp', 'yt-dlp', 'Downloading from YouTube and other sites']].map(([k, n, what]) => html`
            <div class="tool ${toolInfo?.[k] ? 'ok' : 'missing'}">${ic(toolInfo?.[k] ? 'check' : 'alert')}<span><b>${n}</b> ${toolInfo?.[k] ? html`<span class="muted">${toolInfo[k].version}</span>` : html`<span class="muted">not found</span>`}<br><span class="muted">${what}</span></span></div>`)}
        </div>
      </section>

      <section class="panel wide" style="--i:3" data-panel="online">
        <h3>${ic('sparkles')} Online services</h3>
        <p>Optional extras that look things up on the internet. Everything here is off until you turn it on, and only song, album and artist names are sent.</p>
        <label class="check"><input type="checkbox" data-online="onlineLyrics" ${settings.onlineLyrics ? 'checked' : ''}><span class="sw"></span>Find lyrics on <a href="https://lrclib.net" target="_blank" rel="noopener">LRCLIB</a> when a song has none</label>
        <label class="check"><input type="checkbox" data-online="onlineArtistInfo" ${settings.onlineArtistInfo ? 'checked' : ''}><span class="sw"></span>Artist bios and photos (MusicBrainz, Wikipedia)</label>
        <label class="check"><input type="checkbox" data-online="onlineCovers" ${settings.onlineCovers ? 'checked' : ''}><span class="sw"></span>Find missing album covers (Cover Art Archive)</label>
        <div class="row-gap" style="margin:6px 0 4px 50px"><button class="btn sm ghost" data-find-covers>${ic('search')} Look for missing covers now</button><span class="muted" data-cover-status></span></div>
        <label class="check"><input type="checkbox" data-online="onlinePodcastDirectory" ${settings.onlinePodcastDirectory ? 'checked' : ''}><span class="sw"></span>${t('Podcast search (Apple Podcasts directory; your search words are sent)')}</label>
        <label class="check"><input type="checkbox" data-online="onlineRadioDirectory" ${settings.onlineRadioDirectory ? 'checked' : ''}><span class="sw"></span>${html`${t('Radio station search')} (<a href="https://www.radio-browser.info" target="_blank" rel="noopener">radio-browser.info</a>)`}</label>
        <div class="row-gap" style="margin-top:12px">
          <label class="muted" for="pod-refresh">${t('Check podcasts for new episodes every')}</label>
          <input class="input sm" id="pod-refresh" type="number" min="0" max="168" value="${settings.podcastRefreshHours}" data-pod-refresh style="width:80px">
          <span class="muted">${t('hours (0 = only by hand)')}</span>
        </div>
        <div class="org-grid" style="margin-top:16px">
          <label class="muted">Last.fm API key</label>
          <input class="input sm mono" data-key="lastfmApiKey" value="${settings.lastfmApiKey}" placeholder="Needed for Last.fm scrobbling and similar artists" autocomplete="off" spellcheck="false">
          <label class="muted">Last.fm secret</label>
          <input class="input sm mono" type="password" data-key="lastfmSecret" placeholder="${settings.lastfmSecretSet ? '•••••••• (saved)' : 'Shared secret'}" autocomplete="new-password">
          <label class="muted">fanart.tv key</label>
          <input class="input sm mono" data-key="fanartApiKey" value="${settings.fanartApiKey}" placeholder="Optional: better artist photos" autocomplete="off" spellcheck="false">
          <label class="muted">Contact</label>
          <input class="input sm" data-key="onlineContact" value="${settings.onlineContact}" placeholder="Optional URL or email, sent to MusicBrainz so they can reach you" autocomplete="off">
        </div>
        <p class="muted" style="font-size:12px">Get a Last.fm key and secret at <a href="https://www.last.fm/api/account/create" target="_blank" rel="noopener">last.fm/api/account/create</a>. Leave the callback URL empty.</p>
      </section>

      <section class="panel wide" style="--i:3" data-panel="users">
        <h3>${ic('users')} Users</h3><p>Everyone gets their own favorites, playlists and history.</p>
        <div class="users"></div>
        <button class="btn sm primary" data-add-user style="margin-top:8px">${ic('plus')} Add user</button>
      </section>
      ${adminPanels(settings)}` : ''}

      <section class="panel" style="--i:4" data-panel="playback">
        <h3>${ic('waves')} Playback</h3><p>How songs flow into each other. Stored in this browser.</p>
        <label class="check"><input type="checkbox" data-pb="gapless" ${playback.gapless ? 'checked' : ''}><span class="sw"></span>Gapless playback</label>
        <div style="margin-top:14px">
          <label class="muted">Crossfade: <b data-xf-label>${playback.crossfade ? `${playback.crossfade} s` : 'Off'}</b></label>
          <input class="range" type="range" min="0" max="12" step="1" value="${playback.crossfade}" data-pb="crossfade" style="--pct:${(playback.crossfade / 12) * 100}%;margin-top:8px" aria-label="Crossfade seconds">
        </div>
        <label class="check"><input type="checkbox" data-pb="crossfadeAlbums" ${playback.crossfadeAlbums ? 'checked' : ''}><span class="sw"></span>Crossfade between songs on the same album</label>
        <h3 style="margin-top:22px;font-size:15px">Volume normalization (ReplayGain)</h3>
        <p>Evens out loudness using the ReplayGain tags in your files.</p>
        <div class="row-gap">
          <select class="input sm" data-pb="replayGain" aria-label="ReplayGain mode">
            ${[['off', 'Off'], ['auto', 'Automatic (album when playing an album)'], ['track', 'Track'], ['album', 'Album']].map(([k, l]) => html`<option value="${k}" ${playback.replayGain === k ? 'selected' : ''}>${l}</option>`)}
          </select>
        </div>
        <div class="row-gap" style="margin-top:10px">
          <label class="muted" style="min-width:150px">Pre-amp (dB)</label>
          <input class="input sm" type="number" min="-15" max="15" step="0.5" value="${playback.preamp}" data-pb="rgPreamp" style="width:90px">
        </div>
        <div class="row-gap" style="margin-top:8px">
          <label class="muted" style="min-width:150px">Untagged songs (dB)</label>
          <input class="input sm" type="number" min="-15" max="0" step="0.5" value="${playback.fallbackGain}" data-pb="rgFallback" style="width:90px">
        </div>
        <label class="check" style="margin-top:10px"><input type="checkbox" data-pb="rgClip" ${playback.preventClipping ? 'checked' : ''}><span class="sw"></span>Prevent clipping (use peak values)</label>
        <p class="muted" style="margin-top:8px;font-size:12px">Browsers can only turn volume down, so positive gains are capped at your current volume.</p>
        <h3 style="margin-top:22px;font-size:15px">Streaming quality</h3>
        <p>Lower it to save data. Files above this bitrate are converted on the server while they play.</p>
        <div class="org-grid">
          <label class="muted">On Wi-Fi / wired</label>
          <select class="input sm" data-pb="streamBitrate">${QUALITIES.map(([k, l]) => html`<option value="${k}" ${Number(prefs.get('streamBitrate', 0)) === k ? 'selected' : ''}>${l}</option>`)}</select>
          <label class="muted">On mobile data</label>
          <select class="input sm" data-pb="streamBitrateCellular">${QUALITIES.map(([k, l]) => html`<option value="${k}" ${Number(prefs.get('streamBitrateCellular', prefs.get('streamBitrate', 0))) === k ? 'selected' : ''}>${l}</option>`)}</select>
          <label class="muted">Format</label>
          <select class="input sm" data-pb="streamCodec">${[['auto', `Automatic (${preferredCodec().toUpperCase()})`], ['opus', 'Opus'], ['aac', 'AAC'], ['mp3', 'MP3']].map(([k, l]) => html`<option value="${k}" ${prefs.get('streamCodec', 'auto') === k ? 'selected' : ''}>${l}</option>`)}</select>
        </div>
        ${state.user.maxBitrate ? html`<p class="muted" style="font-size:12px">Your account is limited to ${state.user.maxBitrate} kbps by an admin.</p>` : ''}
        <p class="muted" style="font-size:12px">Mobile data is detected on browsers that report it (mainly Chrome on Android). Formats browsers can't play (WMA, APE, ALAC, DSD…) are always converted.</p>
      </section>

      <section class="panel wide" style="--i:5" data-panel="eq">
        <h3>${ic('sliders')} Equalizer</h3><p>Ten bands from deep bass to air. Double-click a slider to reset it. Stored in this browser.</p>
        <div data-eq-host></div>
      </section>

      <section class="panel" style="--i:5">
        <h3>${ic('languages')} ${t('Language')}</h3><p>${t('Used for menus, buttons and messages. Stored in this browser.')}</p>
        <select class="input sm" data-lang aria-label="${t('Language')}">
          <option value="auto" ${langPref() === 'auto' ? 'selected' : ''}>${t('Automatic (browser language)')}</option>
          ${LANGUAGES.map((l) => html`<option value="${l.code}" lang="${l.code}" ${langPref() === l.code ? 'selected' : ''}>${l.name}</option>`)}
        </select>
        <p class="muted" style="font-size:12px;margin-top:10px">${t('Some admin screens are still in English. Translations are welcome: see public/js/locales.')}</p>

        <h3 style="margin-top:26px">${ic('palette')} ${t('Appearance')}</h3><p>${t('Make it yours. Stored in this browser.')}</p>
        <label class="check"><input type="checkbox" data-pref="dynamicColor" ${prefs.get('dynamicColor', true) ? 'checked' : ''}><span class="sw"></span>Colours follow album art</label>
        <label class="check"><input type="checkbox" data-pref="ambient" ${prefs.get('ambient', true) ? 'checked' : ''}><span class="sw"></span>Animated ambient background</label>
        <label class="check"><input type="checkbox" data-pref="visualizer" ${prefs.get('visualizer', true) ? 'checked' : ''}><span class="sw"></span>Audio visualizer &amp; beat-reactive glow</label>
        <label class="check"><input type="checkbox" data-pref="reduceMotion" ${prefs.get('reduceMotion', false) ? 'checked' : ''}><span class="sw"></span>${t('Reduce motion')}${matchMedia('(prefers-reduced-motion: reduce)').matches ? html` <span class="muted">${t('(already on: your system asks for less motion)')}</span>` : ''}</label>
        <label class="check"><input type="checkbox" data-pref="highContrast" ${prefs.get('highContrast', false) ? 'checked' : ''}><span class="sw"></span>${t('High contrast')}</label>
        <label class="muted" style="display:block;margin-top:14px">Colour theme <span style="font-size:12px">(used when colours don't follow the album art)</span></label>
        <div class="theme-swatches">${Object.entries(THEMES).map(([k, t]) => html`<button class="swatch ${!prefs.get('accentCustom', '') && prefs.get('themePreset', 'aurora') === k ? 'on' : ''}" data-theme="${k}" title="${t.name}" aria-label="${t.name}"
          style="background:linear-gradient(135deg, ${t.colors[0]}, ${t.colors[1]} 55%, ${t.colors[2]})"></button>`)}
          <label class="swatch custom ${prefs.get('accentCustom', '') ? 'on' : ''}" title="Pick your own accent">${ic('palette')}<input type="color" data-accent value="${prefs.get('accentCustom', '') || '#8b5cf6'}" aria-label="Custom accent colour"></label></div>
      </section>

      ${offlinePanel()}

      <section class="panel" style="--i:6">
        <h3>${ic('key')} Account</h3><p>Change your password. Other sessions will be signed out.</p>
        <button class="btn sm" data-password>${ic('key')} Change password</button>
        <h3 style="margin-top:26px">${ic('radio')} Scrobbling</h3>
        <p>Share what you play with Last.fm or ListenBrainz.</p>
        <div class="services"><p class="muted">Loading…</p></div>
        ${accountExtras()}
        <h3 style="margin-top:26px">${ic('keyboard')} Keyboard shortcuts</h3>
        <div class="kbd-list" style="margin-top:12px">
          <kbd class="k">Space</kbd><span>Play / pause</span>
          <kbd class="k">← →</kbd><span>Seek 5 seconds</span>
          <kbd class="k">Shift ← →</kbd><span>Previous / next track</span>
          <kbd class="k">↑ ↓</kbd><span>Volume</span>
          <kbd class="k">M</kbd><span>Mute</span>
          <kbd class="k">&lt; &gt;</kbd><span>Slower / faster</span>
          <kbd class="k">S</kbd><span>Shuffle</span>
          <kbd class="k">R</kbd><span>Repeat mode</span>
          <kbd class="k">F</kbd><span>Now playing view</span>
          <kbd class="k">Q</kbd><span>Queue</span>
          <kbd class="k">P</kbd><span>Mini player</span>
          <kbd class="k">E</kbd><span>Equalizer</span>
          <kbd class="k">L</kbd><span>Lyrics</span>
          <kbd class="k">/</kbd><span>Search</span>
        </div>
        <p class="muted" style="font-size:12px;margin-top:10px">${t('Tab moves between controls, and arrow keys move inside menus. In the queue, Enter plays a song and Delete removes it.')}</p>
      </section>
    </div>
  </div>`);

  // ── Language: re-render everything in the new language.
  v.querySelector('[data-lang]').addEventListener('change', (e) => {
    setLangPref(e.target.value);
    location.reload();
  });
  v.querySelector('[data-pod-refresh]')?.addEventListener('change', async (e) => {
    try { await api.put('/admin/settings', { podcastRefreshHours: Number(e.target.value) }); toast(t('Saved'), { type: 'success', ms: 1200 }); } catch (err) { toastError(err); }
  });

  // ── Appearance
  v.querySelectorAll('[data-pref]').forEach((input) => input.addEventListener('change', () => {
    prefs.set(input.dataset.pref, input.checked);
    applyPrefs();
    if (input.dataset.pref === 'dynamicColor') refreshTheme();
    if (input.dataset.pref === 'visualizer' && input.checked) toast('Visualizer starts with the next song you play');
  }));

  const pickTheme = (preset, custom = '') => {
    prefs.set('themePreset', preset);
    prefs.set('accentCustom', custom);
    v.querySelectorAll('.swatch').forEach((b) => b.classList.toggle('on', custom ? b.classList.contains('custom') : b.dataset.theme === preset));
    refreshTheme();
  };
  v.querySelectorAll('[data-theme]').forEach((b) => b.addEventListener('click', () => pickTheme(b.dataset.theme)));
  v.querySelector('[data-accent]').addEventListener('input', (e) => pickTheme(prefs.get('themePreset', 'aurora'), e.target.value));

  v.querySelector('[data-eq-host]').replaceWith(eqEditor());

  // ── Playback
  v.querySelectorAll('[data-pb]').forEach((input) => input.addEventListener(input.type === 'range' ? 'input' : 'change', () => {
    const k = input.dataset.pb;
    const val = input.type === 'checkbox' ? input.checked : input.tagName === 'SELECT' ? (/^\d+$/.test(input.value) ? Number(input.value) : input.value) : Number(input.value);
    prefs.set(k, val);
    if (k === 'crossfade') {
      v.querySelector('[data-xf-label]').textContent = val ? `${val} s` : 'Off';
      input.style.setProperty('--pct', `${(val / 12) * 100}%`);
    }
    player.refreshSettings();
  }));

  // ── Password
  v.querySelector('[data-password]').addEventListener('click', async () => {
    const val = await formDialog({
      title: 'Change password', confirm: 'Update',
      fields: [{ name: 'current', label: 'Current password', type: 'password' }, { name: 'password', label: 'New password', type: 'password' }, { name: 'confirm', label: 'Confirm new password', type: 'password' }],
      validate: async (x) => {
        if (x.password !== x.confirm) return 'Passwords do not match';
        try { await api.put('/me/password', { current: x.current, password: x.password }); return null; } catch (err) { return err.message; }
      },
    });
    if (val) toast('Password updated', { type: 'success' });
  });

  // ── Scrobbling (every user)
  const servicesBox = v.querySelector('.services');
  const renderServices = (s) => {
    servicesBox.innerHTML = String(html`
      <div class="service">
        <b>Last.fm</b>
        ${s.lastfm.connected ? html`<span class="muted">Signed in as ${s.lastfm.name}</span>
            <label class="check sm"><input type="checkbox" data-svc-on="lastfm" ${s.lastfm.enabled ? 'checked' : ''}><span class="sw"></span>On</label>
            <button class="btn sm ghost" data-svc-off="lastfm">Disconnect</button>`
          : s.lastfm.available ? html`<a class="btn sm" href="/api/lastfm/connect">${ic('logout')} Connect Last.fm</a>`
          : html`<span class="muted">${admin ? 'Add a Last.fm API key and secret under Online services first.' : 'An admin needs to set up Last.fm first.'}</span>`}
      </div>
      <div class="service">
        <b>ListenBrainz</b>
        ${s.listenbrainz.connected ? html`<span class="muted">Signed in as ${s.listenbrainz.name}</span>
            <label class="check sm"><input type="checkbox" data-svc-on="listenbrainz" ${s.listenbrainz.enabled ? 'checked' : ''}><span class="sw"></span>On</label>
            <button class="btn sm ghost" data-svc-off="listenbrainz">Disconnect</button>`
          : html`<input class="input sm mono" data-lb-token placeholder="User token from listenbrainz.org/settings" autocomplete="off" spellcheck="false">
            <button class="btn sm" data-lb-connect>Connect</button>`}
      </div>
      ${s.pending ? html`<p class="muted" style="font-size:12px">${plural(s.pending, 'scrobble')} waiting to be sent (will retry).</p>` : ''}`);
  };
  api.get('/me/services').then(renderServices).catch(() => { servicesBox.innerHTML = ''; });
  servicesBox.addEventListener('click', async (e) => {
    const off = e.target.closest('[data-svc-off]');
    if (off) { try { renderServices({ ...(await api.del(`/me/services/${off.dataset.svcOff}`)), pending: 0 }); } catch (err) { toastError(err); } }
    if (e.target.closest('[data-lb-connect]')) {
      try {
        const r = await api.put('/me/services/listenbrainz', { token: servicesBox.querySelector('[data-lb-token]').value });
        toast(`Connected to ListenBrainz as ${r.name}`, { type: 'success' });
        renderServices(await api.get('/me/services'));
      } catch (err) { toastError(err); }
    }
  });
  servicesBox.addEventListener('change', async (e) => {
    const on = e.target.closest('[data-svc-on]');
    if (on) { try { await api.put(`/me/services/${on.dataset.svcOn}/enabled`, { enabled: on.checked }); } catch (err) { toastError(err); } }
  });
  if (query?.get('connected') === 'lastfm') toast('Connected to Last.fm', { type: 'success' });
  if (query?.get('error')) toast(query.get('error'), { type: 'error', ms: 6000 });

  bindExtras(v, admin ? settings : null);
  if (!admin) return v;

  // ── Online services
  v.querySelectorAll('[data-online]').forEach((input) => input.addEventListener('change', async () => {
    try { await api.put('/admin/settings', { [input.dataset.online]: input.checked }); toast(input.checked ? 'Turned on' : 'Turned off', { type: 'success', ms: 1200 }); } catch (err) { toastError(err); }
  }));
  v.querySelectorAll('[data-key]').forEach((input) => input.addEventListener('change', async () => {
    if (input.dataset.key === 'lastfmSecret' && !input.value.trim()) return;
    try {
      await api.put('/admin/settings', { [input.dataset.key]: input.value });
      if (input.type === 'password') { input.value = ''; input.placeholder = '•••••••• (saved)'; }
      toast('Saved', { type: 'success', ms: 1200 });
      renderServices(await api.get('/me/services'));
    } catch (err) { toastError(err); }
  }));
  const coverStatus = v.querySelector('[data-cover-status]');
  let coverPoll = null;
  const drawCovers = (c) => {
    coverStatus.textContent = c.running ? `Checking ${c.checked} / ${c.total}…` : c.finishedAt ? `Last check: ${plural(c.found, 'cover')} found in ${plural(c.total, 'album')}` : '';
    if (c.running && !coverPoll) coverPoll = setInterval(async () => {
      if (!v.isConnected) return clearInterval(coverPoll);
      const n = await api.get('/admin/covers').catch(() => null);
      if (n) drawCovers(n);
      if (n && !n.running) { clearInterval(coverPoll); coverPoll = null; }
    }, 1500);
  };
  api.get('/admin/covers').then(drawCovers).catch(() => {});
  v.querySelector('[data-find-covers]').addEventListener('click', async () => {
    try { drawCovers(await api.post('/admin/covers', { all: true })); } catch (err) { toastError(err); }
  });

  // ── Folders
  let dirs = settings.musicDirs;
  const dirsBox = v.querySelector('.dirs');
  const renderDirs = () => {
    dirsBox.innerHTML = dirs.length ? String(html`${dirs.map((d, i) => html`
      <div class="list-row" style="animation-delay:${i * 40}ms">${ic('folder')}
        <span class="grow mono" title="${d.path}">${d.path}</span>
        ${d.exists === false ? html`<span class="warn">Not found</span>` : ''}
        <button class="icon-btn sm" data-rm="${i}" aria-label="Remove">${ic('x')}</button></div>`)}`)
      : '<p class="muted">No folders yet. Add the folder where you keep your music.</p>';
  };
  renderDirs();
  const saveDirs = async (next) => {
    try {
      await api.put('/admin/settings', { musicDirs: next.map((d) => d.path) });
      dirs = next.map((d) => ({ ...d, exists: true }));
      renderDirs();
      return true;
    } catch (err) { toastError(err); return false; }
  };
  dirsBox.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-rm]');
    if (!b) return;
    const d = dirs[Number(b.dataset.rm)];
    if (!(await confirmDialog({ title: 'Remove folder?', message: `Songs from ${d.path} will be removed from the library on the next scan. Files on disk are not touched.`, confirm: 'Remove', danger: true }))) return;
    if (await saveDirs(dirs.filter((x) => x !== d))) startScan(false);
  });
  v.querySelector('[data-add-dir]').addEventListener('click', async () => {
    const picked = await folderPicker();
    if (!picked) return;
    if (dirs.some((d) => d.path === picked)) return toast('That folder is already in your library');
    if (await saveDirs([...dirs, { path: picked }])) {
      toast('Folder added — scanning…', { type: 'success' });
      startScan(false);
    }
  });

  // ── Scan
  const statusBox = v.querySelector('.scan-status');
  let poll = null;
  const renderScan = (s) => {
    const pct = s.found ? Math.round((s.processed / s.found) * 100) : 0;
    statusBox.innerHTML = String(s.running ? html`
      <div class="progress ${s.phase === 'discovering' ? 'indeterminate' : ''}" style="--p:${pct}%"><i></i></div>
      <div class="muted">${s.phase === 'discovering' ? `Discovering files… ${s.found.toLocaleString()} found` : s.phase === 'cleaning' ? 'Tidying up…' : `Reading ${s.processed.toLocaleString()} / ${s.found.toLocaleString()} (${pct}%)`}</div>
      <div class="muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:.7">${s.current}</div>`
      : html`<div class="list-row" style="animation:none">${ic(s.lastError ? 'alert' : 'check')}<span class="grow">${s.finishedAt
        ? `Last scan ${new Date(s.finishedAt).toLocaleString()} — ${plural(s.added, 'new song')}, ${s.updated} updated, ${s.removed} removed${s.errors ? `, ${s.errors} errors` : ''}${s.skipped ? `, ${s.skipped} unsupported` : ''}`
        : 'No scan has run since Sonara started.'}</span></div>
        ${s.lastError ? html`<p class="muted" style="color:#fca5a5">${s.lastError}</p>` : ''}
        ${s.issueCount ? html`<button class="btn sm ghost" data-issues style="margin-top:8px">${ic('alert')} Show ${plural(s.issueCount, 'skipped file')}</button>` : ''}
        ${s.watching ? html`<p class="muted inline-note">${ic('check')}<span>Watching folders for changes</span></p>` : ''}`);
    statusBox.querySelector('[data-issues]')?.addEventListener('click', showIssues);
    v.querySelectorAll('[data-scan], [data-scan-full]').forEach((b) => { b.disabled = s.running; });
  };
  const watch = () => {
    clearInterval(poll);
    poll = setInterval(async () => {
      if (!v.isConnected) return clearInterval(poll);
      const s = await api.get('/admin/scan').catch(() => null);
      if (!s) return;
      renderScan(s);
      if (!s.running) {
        clearInterval(poll);
        toast(`Scan complete — ${plural(s.added, 'new song')}`, { type: 'success' });
      }
    }, 900);
  };
  const startScan = async (full) => {
    try { renderScan(await api.post('/admin/scan', { full })); watch(); } catch (err) { toastError(err); }
  };
  renderScan(scan);
  if (scan.running) watch();
  v.querySelector('[data-scan]').addEventListener('click', () => startScan(false));
  v.querySelector('[data-scan-full]').addEventListener('click', () => startScan(true));
  v.querySelector('[data-interval]').addEventListener('change', async (e) => {
    try { await api.put('/admin/settings', { scanIntervalMinutes: Number(e.target.value) }); toast('Saved', { type: 'success', ms: 1200 }); } catch (err) { toastError(err); }
  });
  v.querySelector('[data-allow-files]').addEventListener('change', async (e) => {
    try { await api.put('/admin/settings', { allowFileChanges: e.target.checked }); toast(e.target.checked ? 'File changes allowed' : 'File changes turned off', { type: 'success', ms: 1500 }); } catch (err) { toastError(err); }
  });
  v.querySelector('[data-organize-lib]').addEventListener('click', () => organizeDialog({ type: 'library' }));
  const drawCache = (c) => { v.querySelector('[data-cache-info]').textContent = `${fmtBytes(c.size)} used by ${plural(c.files, 'converted file')}`; };
  api.get('/admin/transcode').then(drawCache).catch(() => {});
  v.querySelector('[data-cache-clear]').addEventListener('click', async () => {
    try { drawCache(await api.del('/admin/transcode')); toast('Cache cleared', { type: 'success', ms: 1200 }); } catch (err) { toastError(err); }
  });
  v.querySelector('[data-cache-mb]').addEventListener('change', async (e) => {
    try { await api.put('/admin/settings', { transcodeCacheMB: Number(e.target.value) }); toast('Saved', { type: 'success', ms: 1200 }); } catch (err) { toastError(err); }
  });
  v.querySelector('[data-dl-change]').addEventListener('click', async () => {
    const d = await folderPicker({ title: 'Downloads folder', message: 'Where yt-dlp downloads and conversions are saved until you file them. Must be outside your music folders.', start: settings.downloadsDir });
    if (!d) return;
    try { await api.put('/admin/settings', { downloadsDir: d }); v.querySelector('[data-dl-dir]').textContent = d; toast('Saved', { type: 'success', ms: 1200 }); } catch (err) { toastError(err); }
  });
  v.querySelector('[data-watch]').addEventListener('change', async (e) => {
    try { await api.put('/admin/settings', { watch: e.target.checked }); toast('Saved', { type: 'success', ms: 1200 }); } catch (err) { toastError(err); }
  });
  v.querySelector('[data-startup]').addEventListener('change', async (e) => {
    try { await api.put('/admin/settings', { scanOnStartup: e.target.checked }); toast('Saved', { type: 'success', ms: 1200 }); } catch (err) { toastError(err); }
  });

  // ── Users
  const usersBox = v.querySelector('.users');
  const renderUsers = (list) => {
    usersBox.innerHTML = String(html`${list.map((u, i) => html`
      <div class="list-row" style="animation-delay:${i * 40}ms">
        <div class="avatar">${u.username[0]}</div>
        <span class="grow"><b>${u.username}</b> <span class="muted">· ${u.isAdmin ? 'Admin' : 'Listener'} · joined ${new Date(u.createdAt).toLocaleDateString()}</span></span>
        <select class="input sm" data-u-max="${u.id}" title="Maximum streaming bitrate" aria-label="Maximum streaming bitrate">
          ${QUALITIES.map(([k, l]) => html`<option value="${k}" ${(u.maxBitrate || 0) === k ? 'selected' : ''}>${k ? `Max ${l}` : 'No bitrate limit'}</option>`)}
        </select>
        <button class="btn sm ghost" data-u-access="${u.id}" title="Permissions and library access">${u.libraryDirs?.length ? 'Limited access' : 'Access'}${u.twoFactor ? ' · 2FA' : ''}</button>
        <button class="btn sm ghost" data-u-pw="${u.id}">Reset password</button>
        ${u.id !== state.user.id ? html`
          <button class="btn sm ghost" data-u-admin="${u.id}" data-val="${u.isAdmin ? 0 : 1}">${u.isAdmin ? 'Make listener' : 'Make admin'}</button>
          <button class="icon-btn sm" data-u-del="${u.id}" aria-label="Delete">${ic('trash')}</button>` : html`<span class="muted">(you)</span>`}
      </div>`)}`);
  };
  renderUsers(users);
  usersBox.addEventListener('change', async (e) => {
    const sel = e.target.closest('[data-u-max]');
    if (!sel) return;
    try {
      await api.put(`/admin/users/${sel.dataset.uMax}`, { maxBitrate: Number(sel.value) });
      if (Number(sel.dataset.uMax) === state.user.id) state.user.maxBitrate = Number(sel.value);
      toast('Saved', { type: 'success', ms: 1200 });
    } catch (err) { toastError(err); }
  });
  const reloadUsers = async () => renderUsers(await api.get('/admin/users'));
  usersBox.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    const user = (await api.get('/admin/users')).find((u) => String(u.id) === (t.dataset.uPw || t.dataset.uAdmin || t.dataset.uDel || t.dataset.uAccess));
    if (!user) return;
    try {
      if (t.dataset.uAccess) { if (await userAccessDialog(user, settings.musicDirs.map((d) => d.path))) reloadUsers(); return; }
      if (t.dataset.uPw) {
        const val = await formDialog({ title: `Reset password for ${user.username}`, confirm: 'Reset', fields: [{ name: 'password', label: 'New password', type: 'password' }],
          validate: (x) => (x.password.length < 6 ? 'Password must be at least 6 characters' : null) });
        if (!val) return;
        await api.put(`/admin/users/${user.id}`, { password: val.password });
        toast('Password reset', { type: 'success' });
      } else if (t.dataset.uAdmin) {
        await api.put(`/admin/users/${user.id}`, { isAdmin: t.dataset.val === '1' });
        reloadUsers();
      } else if (t.dataset.uDel) {
        if (!(await confirmDialog({ title: `Delete ${user.username}?`, message: 'Their playlists, favorites and history will be deleted. Music files are not affected.', confirm: 'Delete', danger: true }))) return;
        await api.del(`/admin/users/${user.id}`);
        toast('User deleted');
        reloadUsers();
      }
    } catch (err) { toastError(err); }
  });
  v.querySelector('[data-add-user]').addEventListener('click', async () => {
    const val = await formDialog({
      title: 'Add user', confirm: 'Create',
      fields: [{ name: 'username', label: 'Username' }, { name: 'password', label: 'Password', type: 'password' }],
      validate: async (x) => {
        try { await api.post('/admin/users', x); return null; } catch (err) { return err.message; }
      },
    });
    if (val) { toast(`Created ${val.username}`, { type: 'success' }); reloadUsers(); }
  });

  v._destroy = () => clearInterval(poll);
  return v;
}

async function showIssues() {
  const s = await api.get('/admin/scan', { issues: 1 }).catch(() => null);
  if (!s) return;
  modal(html`
    <h3>Files skipped in the last scan</h3>
    <p>These files weren't added to the library.${s.issueCount >= 300 ? ' Showing the first 300.' : ''}</p>
    <div class="issues">${s.issues.map((i) => html`<div class="issue ${i.kind}">
      <div class="mono" title="${i.path}">${i.path}</div><div class="muted">${i.reason}</div></div>`)}</div>
    <div class="modal-actions"><button class="btn primary" data-close>Close</button></div>`);
}

/**
 * Server-side folder (or file) browser. Resolves with an absolute path or null.
 * opts: { title, message, start, files: 'video' | 'all' (pick a file instead of a folder), confirm }
 */
export function folderPicker(opts = {}) {
  const pickFile = !!opts.files;
  return modal(html`
    <h3>${opts.title || 'Choose a music folder'}</h3>
    <p>${opts.message || "Browse the server's file system, or paste a path."}</p>
    <div class="field"><input name="path" placeholder=" " autocomplete="off"><label>Folder path</label></div>
    <div class="browser"></div>
    <div class="form-error"></div>
    <div class="modal-actions"><button class="btn ghost" data-close>Cancel</button>${pickFile ? '' : html`<button class="btn primary" data-ok>${ic('check')} ${opts.confirm || 'Use this folder'}</button>`}</div>
  `, (box, close) => {
    const input = box.querySelector('input');
    const list = box.querySelector('.browser');
    const err = box.querySelector('.form-error');
    const go = async (p) => {
      try {
        const r = await api.get('/admin/browse', { path: p, files: opts.files });
        err.textContent = '';
        input.value = r.path;
        list.innerHTML = String(html`
          ${r.parent !== null ? html`<button class="menu-item" data-p="${r.parent}">${ic('chevronLeft')}<span>Up</span></button>` : ''}
          ${r.dirs.map((d) => html`<button class="menu-item" data-p="${d.path}">${ic('folder')}<span>${d.name}</span></button>`)}
          ${(r.files || []).map((f) => html`<button class="menu-item" data-f="${f.path}">${ic('music')}<span>${f.name}</span></button>`)}
          ${!r.dirs.length && !r.files?.length ? html`<p class="muted" style="padding:10px">${pickFile ? 'Nothing here' : 'No sub-folders'}</p>` : ''}`);
        list.scrollTop = 0;
      } catch (e) { err.textContent = e.message; }
    };
    list.addEventListener('click', (e) => {
      const f = e.target.closest('[data-f]');
      if (f) return close(f.dataset.f);
      const b = e.target.closest('[data-p]');
      if (b) go(b.dataset.p);
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(input.value); } });
    box.querySelector('[data-ok]')?.addEventListener('click', () => {
      if (!input.value.trim()) { err.textContent = 'Pick a folder first'; return; }
      close(input.value.trim());
    });
    go(opts.start || '');
  });
}

const systemReducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
systemReducedMotion.addEventListener?.('change', () => applyPrefs());

export function applyPrefs() {
  document.body.classList.toggle('no-ambient', !prefs.get('ambient', true));
  // The system setting counts too, so the ripple, card tilt and smooth scrolling (done in JS) also calm down.
  document.body.classList.toggle('reduce-motion', !!prefs.get('reduceMotion', false) || systemReducedMotion.matches);
  document.body.classList.toggle('high-contrast', !!prefs.get('highContrast', false));
}
