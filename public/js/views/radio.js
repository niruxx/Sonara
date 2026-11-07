// Internet radio: your stations, plus (optionally) a search of radio-browser.info.
import { api } from '../api.js';
import { html, ic, el, art, debounce } from '../util.js';
import { player } from '../player.js';
import { toast, toastError, openMenu, confirmDialog, formDialog } from '../ui.js';
import { emptyState, copyText } from '../components.js';
import { stationItem, isStation } from '../media.js';
import { t, plural } from '../i18n.js';

const playing = (s) => isStation(player.current) && player.current.stationId === s.id;

function playStation(s) {
  if (playing(s)) return player.toggle();
  player.shuffle = false;
  player.playList([stationItem(s)], 0);
}

const stationCard = (s, i) => html`
  <div class="card station ${playing(s) ? 'on-air' : ''}" style="--i:${i}" data-st="${s.id}">
    <div class="card-art">${art(s.cover, s.name, 'radio')}
      <button class="card-play" data-st-play="${s.id}" aria-label="${t('Play {title}', { title: s.name })}">${ic(playing(s) && player.playing ? 'pause' : 'play')}</button>
      ${playing(s) ? html`<span class="live-badge">${t('LIVE')}</span>` : ''}
    </div>
    <div class="card-title" title="${s.name}">${s.name}</div>
    <div class="card-sub">${playing(s) && player.current.artist !== t('Live radio') ? player.current.artist : [s.codec, s.bitrate ? `${s.bitrate} kbps` : null, s.country].filter(Boolean).join(' · ') || s.tags.split(',').slice(0, 2).join(', ') || t('Internet radio')}</div>
    <button class="icon-btn sm card-more" data-st-more="${s.id}" aria-label="${t('More options for {title}', { title: s.name })}">${ic('more')}</button>
  </div>`;

export async function radioView() {
  let { stations, directory } = await api.get('/stations');
  const v = el(html`<div>
    <div class="page-head">
      <div><h1 class="page-title">${t('Radio')}</h1>
        <p class="page-sub">${stations.length ? plural(stations.length, 'station') : t('Listen to internet radio stations alongside your library.')}</p></div>
      <div class="row-gap"><button class="btn sm primary" data-add>${ic('plus')} ${t('Add station')}</button></div>
    </div>
    ${directory ? html`<div class="find-bar">
        <label class="search page-search"><input type="search" placeholder="${t('Search stations by name')}" aria-label="${t('Search stations by name')}" data-find spellcheck="false">${ic('search')}</label>
        <div class="chips" role="group" aria-label="${t('Genres')}">${['jazz', 'classical', 'rock', 'electronic', 'ambient', 'news', 'lofi', 'hip-hop', 'country', 'pop'].map((g) => html`<button class="chip" data-tag="${g}">${g}</button>`)}</div>
      </div>
      <div class="find-results" aria-live="polite"></div>` : ''}
    <section class="section"><div class="section-head"><h2>${t('Your stations')}</h2></div><div data-grid></div></section>
  </div>`);

  const grid = v.querySelector('[data-grid]');
  const draw = () => {
    grid.innerHTML = stations.length ? String(html`<div class="grid">${stations.map(stationCard)}</div>`)
      : String(emptyState('radio', t('No stations yet'), directory ? t('Search above, or add a stream address yourself.') : t('Add the stream address of a station (Icecast, SHOUTcast, .pls or .m3u).'), html`<button class="btn primary" data-add2>${ic('plus')} ${t('Add station')}</button>`));
    grid.querySelector('[data-add2]')?.addEventListener('click', () => stationDialog());
  };
  draw();
  const offs = [player.on('track', draw), player.on('state', draw)];
  v._destroy = () => offs.forEach((off) => off());

  const reload = async () => { ({ stations } = await api.get('/stations')); draw(); };
  const byId = (id) => stations.find((s) => s.id === Number(id));

  grid.addEventListener('click', (e) => {
    const more = e.target.closest('[data-st-more]');
    if (more) { e.preventDefault(); return stationMenu(more, byId(more.dataset.stMore), reload); }
    const card = e.target.closest('[data-st]');
    if (card) playStation(byId(card.dataset.st));
  });
  grid.addEventListener('contextmenu', (e) => {
    const card = e.target.closest('[data-st]');
    if (!card) return;
    e.preventDefault();
    stationMenu(e, byId(card.dataset.st), reload);
  });

  async function stationDialog(s = null) {
    const r = await formDialog({
      title: s ? t('Edit station') : t('Add a station'),
      message: s ? '' : t('Paste the stream address. Playlist files (.pls, .m3u) work too.'),
      fields: [
        { name: 'name', label: t('Name'), value: s?.name },
        { name: 'url', label: t('Stream address'), type: 'url', value: s?.url },
        { name: 'homepage', label: t('Website (optional)'), type: 'url', value: s?.homepage },
      ],
      confirm: s ? t('Save') : t('Add station'),
      validate: async (val) => {
        if (!val.name.trim()) return t('Give the station a name');
        if (!val.url.trim()) return t('Enter a web address');
        try {
          val.station = s ? await api.put(`/stations/${s.id}`, val) : await api.post('/stations', val);
          return null;
        } catch (err) { return err.message; }
      },
    });
    if (!r?.station) return;
    toast(s ? t('Station saved') : t('Added {name}', { name: r.station.name }), { type: 'success' });
    reload();
  }
  v.querySelector('[data-add]').addEventListener('click', () => stationDialog());
  editStation = stationDialog;

  // Directory search
  const find = v.querySelector('[data-find]');
  if (find) {
    const out = v.querySelector('.find-results');
    let seq = 0;
    const search = async (params) => {
      const mine = ++seq;
      if (!params.q && !params.tag) { out.innerHTML = ''; return; }
      out.innerHTML = String(html`<p class="muted">${t('Searching…')}</p>`);
      try {
        const rows = (await api.get('/stations/search', params)).filter((r) => !r.hls);
        if (mine !== seq) return;
        out.innerHTML = rows.length ? String(html`<div class="find-list">${rows.map((r, i) => html`<div class="find-row">
          <div class="find-art">${r.image ? html`<img src="${r.image}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}${art(null, r.name, 'radio')}</div>
          <div class="grow"><b>${r.name}</b><div class="muted">${[r.country, r.codec, r.bitrate ? `${r.bitrate} kbps` : null, r.tags.split(',').slice(0, 3).join(', ')].filter(Boolean).join(' · ')}</div></div>
          ${r.added ? html`<span class="muted">${ic('check')} ${t('Added')}</span>` : html`<button class="btn sm" data-r-add="${i}">${ic('plus')} ${t('Add')}</button>`}
        </div>`)}</div>`) : String(html`<p class="muted">${t('No stations found')}</p>`);
        out.querySelectorAll('[data-r-add]').forEach((b) => b.addEventListener('click', async () => {
          const r = rows[Number(b.dataset.rAdd)];
          b.disabled = true;
          b.textContent = t('Adding…');
          try {
            const s = await api.post('/stations', { ...r, skipCheck: false });
            b.replaceWith(el(html`<span class="muted">${ic('check')} ${t('Added')}</span>`));
            await reload();
            toast(t('Added {name}', { name: s.name }), { type: 'success' });
          } catch (err) { toastError(err); b.disabled = false; b.textContent = t('Add'); }
        }));
      } catch (err) { if (mine === seq) out.innerHTML = String(html`<p class="muted">${err.message}</p>`); }
    };
    find.addEventListener('input', debounce(() => {
      v.querySelectorAll('[data-tag]').forEach((c) => c.classList.remove('active'));
      search({ q: find.value.trim() });
    }, 400));
    v.querySelectorAll('[data-tag]').forEach((c) => c.addEventListener('click', () => {
      const on = !c.classList.contains('active');
      v.querySelectorAll('[data-tag]').forEach((x) => x.classList.toggle('active', x === c && on));
      find.value = '';
      search(on ? { tag: c.dataset.tag } : {});
    }));
  }
  return v;
}

let editStation = null;

export function stationMenu(at, s, reload = () => {}) {
  if (!s) return;
  openMenu(at, [
    { icon: playing(s) && player.playing ? 'pause' : 'play', label: playing(s) && player.playing ? t('Pause') : t('Play'), action: () => playStation(s) },
    { icon: 'addQueue', label: t('Add to queue'), action: () => player.addToQueue([stationItem(s)]) },
    'sep',
    ...(s.homepage ? [{ icon: 'globe', label: t('Open website'), action: () => window.open(s.homepage, '_blank', 'noopener') }] : []),
    { icon: 'link', label: t('Copy stream address'), action: () => copyText(s.url) },
    ...(editStation ? [{ icon: 'edit', label: t('Edit…'), action: () => editStation(s) }] : []),
    { icon: 'trash', label: t('Remove'), danger: true, action: async () => {
      if (!(await confirmDialog({ title: t('Remove {name}?', { name: s.name }), message: t('It disappears from your stations.'), confirm: t('Remove'), danger: true }))) return;
      try { await api.del(`/stations/${s.id}`); reload(); } catch (err) { toastError(err); }
    } },
  ]);
}
