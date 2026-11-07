// Podcasts: your subscriptions, new and in-progress episodes, and a page per show.
import { api } from '../api.js';
import { html, ic, el, art, debounce } from '../util.js';
import { player } from '../player.js';
import { state } from '../state.js';
import { toast, toastError, openMenu, modal, confirmDialog, formDialog } from '../ui.js';
import { navigate } from '../router.js';
import { emptyState, copyText } from '../components.js';
import { setPalette } from '../theme.js';
import { episodeItem } from '../media.js';
import { t, plural, fmtDate } from '../i18n.js';

const dot = html`<span class="dot" aria-hidden="true"></span>`;

/** "45 min" / "1 hr 5 min", or the time left once you've started. */
function episodeLength(e) {
  const d = e.duration || 0;
  if (e.played) return t('Played');
  if (e.position > 5 && d) return t('{time} left', { time: fmtShort(Math.max(0, d - e.position)) });
  return d ? fmtShort(d) : '';
}
const fmtShort = (sec) => {
  const h = Math.floor(sec / 3600);
  const m = Math.max(1, Math.round((sec % 3600) / 60));
  return h ? t('{h} hr {m} min', { h, m }) : t('{m} min', { m });
};

const pct = (e) => (e.played ? 100 : e.duration && e.position ? Math.min(100, (e.position / e.duration) * 100) : 0);
const isCurrent = (e) => player.current?.kind === 'episode' && player.current.episodeId === e.id;

function playEpisodes(list, i) {
  player.shuffle = false;
  player.playList(list.map(episodeItem), i);
}

// ───────── Episode rows ─────────

const episodeRow = (e, i, { showPodcast = false } = {}) => html`
  <article class="ep-row ${e.played ? 'played' : ''} ${isCurrent(e) ? 'current' : ''}" data-ep="${e.id}" style="--i:${Math.min(i, 20)}">
    ${showPodcast ? html`<a class="ep-cover" href="/podcast/${e.podcastId}" tabindex="-1" aria-hidden="true">${art(e.cover, e.podcast, 'podcast', 120)}</a>` : ''}
    <div class="ep-main">
      <div class="ep-meta">${showPodcast ? html`<a href="/podcast/${e.podcastId}">${e.podcast}</a>${dot}` : ''}${e.publishedAt ? fmtDate(e.publishedAt) : ''}${e.season || e.episode ? html`${dot}${e.season ? `S${e.season} ` : ''}${e.episode ? `E${e.episode}` : ''}` : ''}</div>
      <h3 class="ep-title"><button class="link" data-ep-play="${e.id}">${e.title}</button></h3>
      ${e.description ? html`<p class="ep-desc">${e.description}</p>` : ''}
      <div class="ep-foot">
        <button class="btn sm ep-play" data-ep-play="${e.id}" aria-label="${t('Play {title}', { title: e.title })}">${ic(isCurrent(e) && player.playing ? 'pause' : 'play')}<span>${episodeLength(e) || t('Play')}</span></button>
        ${pct(e) > 0 && !e.played ? html`<div class="ep-progress" role="progressbar" aria-label="${t('Listened')}" aria-valuenow="${Math.round(pct(e))}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct(e)}%"></i></div>` : ''}
        <span class="spacer"></span>
        ${e.downloading ? html`<span class="muted ep-dl" title="${e.downloading.error || ''}">${e.downloading.error ? html`${ic('alert')} ${t('Download failed')}` : html`${ic('download')} ${e.downloading.total ? `${Math.round((e.downloading.received / e.downloading.total) * 100)}%` : t('Downloading…')}`}</span>`
          : e.downloaded ? html`<span class="muted ep-dl" title="${t('Saved on the server')}">${ic('checkCircle')} ${t('Downloaded')}</span>` : ''}
        <button class="icon-btn sm" data-ep-played="${e.id}" aria-pressed="${e.played ? 'true' : 'false'}" aria-label="${e.played ? t('Mark as unplayed') : t('Mark as played')}" title="${e.played ? t('Mark as unplayed') : t('Mark as played')}">${ic(e.played ? 'checkCircle' : 'check')}</button>
        <button class="icon-btn sm" data-ep-more="${e.id}" aria-label="${t('More options')}">${ic('more')}</button>
      </div>
    </div>
  </article>`;

/** Wire up a list of episode rows. `reload()` redraws after changes. */
function bindEpisodes(root, getList, reload) {
  const find = (id) => getList().find((e) => e.id === Number(id));
  root.addEventListener('click', async (ev) => {
    const play = ev.target.closest('[data-ep-play]');
    if (play) {
      const e = find(play.dataset.epPlay);
      if (isCurrent(e)) return player.toggle();
      playEpisodes([e], 0);
      return;
    }
    const pl = ev.target.closest('[data-ep-played]');
    if (pl) {
      const e = find(pl.dataset.epPlayed);
      const played = !e.played;
      try {
        await api.put(`/podcasts/episodes/${e.id}/progress`, { position: 0, played });
        Object.assign(e, { played, position: 0 });
        if (isCurrent(e) && player.current) player.current.resumeAt = 0;
        reload();
      } catch (err) { toastError(err); }
      return;
    }
    const more = ev.target.closest('[data-ep-more]');
    if (more) episodeMenu(more, find(more.dataset.epMore), reload);
    const desc = ev.target.closest('.ep-desc');
    if (desc) desc.classList.toggle('open');
  });
}

export function episodeMenu(at, e, reload = () => {}) {
  const items = [
    { icon: 'play', label: t('Play'), action: () => playEpisodes([e], 0) },
    { icon: 'playNext', label: t('Play next'), action: () => player.playNext([episodeItem(e)]) },
    { icon: 'addQueue', label: t('Add to queue'), action: () => player.addToQueue([episodeItem(e)]) },
    'sep',
    { icon: 'podcast', label: t('Go to podcast'), action: () => navigate(`/podcast/${e.podcastId}`) },
  ];
  if (!e.downloaded && !e.downloading) {
    items.push({ icon: 'download', label: t('Download to the server'), action: async () => {
      try { await api.post(`/podcasts/episodes/${e.id}/download`); e.downloading = { received: 0, total: 0 }; reload(); toast(t('Downloading “{title}”', { title: e.title })); } catch (err) { toastError(err); }
    } });
  }
  if (e.downloaded && state.user.isAdmin) {
    items.push({ icon: 'trash', label: t('Remove download'), danger: true, action: async () => {
      try { await api.del(`/podcasts/episodes/${e.id}/download`); e.downloaded = false; reload(); } catch (err) { toastError(err); }
    } });
  }
  openMenu(at, items);
}

// ───────── Podcasts home ─────────

export async function podcastsView() {
  const [{ podcasts, directory }, latest, cont] = await Promise.all([
    api.get('/podcasts'), api.get('/podcasts/episodes/latest', { limit: 20 }), api.get('/podcasts/episodes/continue'),
  ]);
  const v = el(html`<div>
    <div class="page-head">
      <div><h1 class="page-title">${t('Podcasts')}</h1>
        <p class="page-sub">${podcasts.length ? plural(podcasts.length, 'show') : t('Follow shows and pick up episodes where you left off, on any device.')}</p></div>
      <div class="row-gap">
        <button class="btn sm primary" data-add>${ic('plus')} ${t('Add podcast')}</button>
        <button class="icon-btn" data-more aria-label="${t('More options')}">${ic('more')}</button>
      </div>
    </div>
    ${directory ? html`<label class="search page-search"><input type="search" placeholder="${t('Search for podcasts')}" aria-label="${t('Search for podcasts')}" data-find spellcheck="false">${ic('search')}</label>
      <div class="find-results" aria-live="polite"></div>` : ''}
    ${cont.length ? html`<section class="section"><div class="section-head"><h2>${t('Continue listening')}</h2></div><div class="ep-list" data-list="cont"></div></section>` : ''}
    ${podcasts.length ? html`<section class="section"><div class="section-head"><h2>${t('Your shows')}</h2></div>
      <div class="grid">${podcasts.map((p, i) => html`<a class="card" href="/podcast/${p.id}" style="--i:${i}">
        <div class="card-art">${art(p.cover, p.title, 'podcast')}${p.unplayed ? html`<span class="count-badge" aria-label="${plural(p.unplayed, 'unplayed episode')}">${p.unplayed > 99 ? '99+' : p.unplayed}</span>` : ''}</div>
        <div class="card-title" title="${p.title}">${p.title}</div><div class="card-sub">${p.author || plural(p.episodeCount, 'episode')}</div></a>`)}</div></section>`
      : html`<div>${emptyState('podcast', t('No podcasts yet'), directory ? t('Search above, or paste the address of a podcast feed.') : t('Paste the address (RSS feed) of a podcast to follow it.'), html`<button class="btn primary" data-add2>${ic('plus')} ${t('Add podcast')}</button>`)}</div>`}
    ${latest.length ? html`<section class="section"><div class="section-head"><h2>${t('New episodes')}</h2></div><div class="ep-list" data-list="latest"></div></section>` : ''}
  </div>`);

  const lists = { cont, latest };
  const draw = () => {
    for (const [k, list] of Object.entries(lists)) {
      const box = v.querySelector(`[data-list="${k}"]`);
      if (box) box.innerHTML = String(html`${list.map((e, i) => episodeRow(e, i, { showPodcast: true }))}`);
    }
  };
  draw();
  for (const [k, list] of Object.entries(lists)) {
    const box = v.querySelector(`[data-list="${k}"]`);
    if (box) bindEpisodes(box, () => list, draw);
  }
  const offs = [player.on('track', draw), player.on('state', draw)];
  v._destroy = () => offs.forEach((off) => off());

  const add = () => addPodcastDialog();
  v.querySelector('[data-add]').addEventListener('click', add);
  v.querySelector('[data-add2]')?.addEventListener('click', add);
  v.querySelector('[data-more]').addEventListener('click', (e) => openMenu(e.currentTarget, [
    { icon: 'upload', label: t('Import OPML…'), action: importOpml },
    { icon: 'download', label: t('Export OPML'), action: () => { location.href = '/api/podcasts/opml'; } },
  ]));

  const find = v.querySelector('[data-find]');
  if (find) {
    const out = v.querySelector('.find-results');
    let seq = 0;
    find.addEventListener('input', debounce(async () => {
      const q = find.value.trim();
      const mine = ++seq;
      if (!q) { out.innerHTML = ''; return; }
      out.innerHTML = String(html`<p class="muted">${t('Searching…')}</p>`);
      try {
        const rows = await api.get('/podcasts/search', { q });
        if (mine !== seq) return;
        out.innerHTML = rows.length ? String(html`<div class="find-list">${rows.map((r, i) => html`<div class="find-row">
          <div class="find-art">${r.image ? html`<img src="${r.image}" alt="" loading="lazy" referrerpolicy="no-referrer">` : art(null, r.title, 'podcast')}</div>
          <div class="grow"><b>${r.title}</b><div class="muted">${[r.author, r.genre].filter(Boolean).join(' · ')}</div></div>
          ${r.subscribed ? html`<span class="muted">${ic('check')} ${t('Following')}</span>` : html`<button class="btn sm" data-sub="${i}">${ic('plus')} ${t('Follow')}</button>`}
        </div>`)}</div>`) : String(html`<p class="muted">${t('No podcasts found')}</p>`);
        out.querySelectorAll('[data-sub]').forEach((b) => b.addEventListener('click', async () => {
          b.disabled = true;
          b.textContent = t('Adding…');
          try {
            const p = await api.post('/podcasts', { url: rows[Number(b.dataset.sub)].feedUrl });
            toast(t('Following “{title}”', { title: p.title }), { type: 'success' });
            navigate(`/podcast/${p.id}`);
          } catch (err) { toastError(err); b.disabled = false; b.textContent = t('Follow'); }
        }));
      } catch (err) { if (mine === seq) out.innerHTML = String(html`<p class="muted">${err.message}</p>`); }
    }, 400));
  }
  return v;
}

async function addPodcastDialog() {
  const r = await formDialog({
    title: t('Add a podcast'),
    message: t('Paste the address of the podcast’s RSS feed. Most podcast websites link to it as “RSS”.'),
    fields: [{ name: 'url', label: t('Feed address'), type: 'url' }],
    confirm: t('Follow'),
    validate: async (v) => {
      if (!v.url.trim()) return t('Enter a web address');
      try { v.podcast = await api.post('/podcasts', { url: v.url }); return null; } catch (err) { return err.message; }
    },
  });
  if (r?.podcast) {
    toast(t('Following “{title}”', { title: r.podcast.title }), { type: 'success' });
    navigate(`/podcast/${r.podcast.id}`);
  }
}

function importOpml() {
  const input = el('<input type="file" accept=".opml,.xml,text/xml,text/x-opml" hidden>');
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    toast(t('Importing podcasts…'));
    try {
      const r = await api.post('/podcasts/opml', { text: await file.text() });
      toast(t('Imported {n} podcasts', { n: r.added }) + (r.failed.length ? ` · ${t('{n} could not be read', { n: r.failed.length })}` : ''), { type: r.failed.length ? 'info' : 'success', ms: 5000 });
      navigate('/podcasts', { replace: true });
    } catch (err) { toastError(err); }
  });
  input.click();
}

// ───────── One podcast ─────────

export async function podcastView({ params }) {
  let p = await api.get(`/podcasts/${params.id}`);
  setPalette(p.cover);
  const v = el(html`<div>
    <header class="hero">
      <div class="hero-art">${art(p.cover, p.title, 'podcast')}</div>
      <div class="hero-info">
        <div class="eyebrow">${t('Podcast')}</div>
        <h1 class="hero-title">${p.title}</h1>
        <div class="hero-meta">${p.author ? html`<span>${p.author}</span>${dot}` : ''}<span>${plural(p.episodeCount, 'episode')}</span>
          ${p.link ? html`${dot}<a href="${p.link}" target="_blank" rel="noopener noreferrer">${t('Website')}</a>` : ''}</div>
      </div>
    </header>
    <div class="actions">
      <button class="play-fab" data-play aria-label="${t('Play latest episode')}" title="${t('Play latest episode')}">${ic('play')}</button>
      ${p.subscribed ? html`<button class="btn sm" data-unsub aria-pressed="true">${ic('check')} ${t('Following')}</button>` : html`<button class="btn sm primary" data-sub>${ic('plus')} ${t('Follow')}</button>`}
      <button class="icon-btn lg" data-refresh aria-label="${t('Check for new episodes')}" title="${t('Check for new episodes')}">${ic('refresh')}</button>
      <button class="icon-btn lg" data-more aria-label="${t('More options')}">${ic('more')}</button>
    </div>
    ${p.lastError ? html`<p class="notice">${ic('alert')} ${t('The feed could not be updated last time: {error}', { error: p.lastError })}</p>` : ''}
    ${p.description ? html`<p class="podcast-about">${p.description}</p>` : ''}
    <div class="chips fit" role="group" aria-label="${t('Show')}">
      <button class="chip active" data-filter="all" aria-pressed="true">${t('All')}</button>
      <button class="chip" data-filter="unplayed" aria-pressed="false">${t('Unplayed')}</button>
      <button class="chip" data-filter="downloaded" aria-pressed="false">${t('Downloaded')}</button>
    </div>
    <div class="ep-list" data-list></div>
    <div class="row-gap" style="justify-content:center;margin:18px 0" data-more-wrap hidden><button class="btn sm ghost" data-show-more>${t('Show more')}</button></div>
  </div>`);

  let filter = 'all';
  let shown = 50;
  const visible = () => p.episodes.filter((e) => (filter === 'unplayed' ? !e.played : filter === 'downloaded' ? e.downloaded : true));
  const box = v.querySelector('[data-list]');
  const draw = () => {
    const list = visible();
    box.innerHTML = list.length ? String(html`${list.slice(0, shown).map((e, i) => episodeRow(e, i))}`)
      : String(emptyState('podcast', filter === 'unplayed' ? t('All caught up') : t('Nothing here'), filter === 'unplayed' ? t('You’ve played every episode.') : t('No episodes match.')));
    v.querySelector('[data-more-wrap]').hidden = list.length <= shown;
  };
  draw();
  bindEpisodes(box, () => p.episodes, draw);
  v.querySelector('[data-show-more]').addEventListener('click', () => { shown += 100; draw(); });
  v.querySelectorAll('[data-filter]').forEach((c) => c.addEventListener('click', () => {
    filter = c.dataset.filter;
    shown = 50;
    v.querySelectorAll('[data-filter]').forEach((x) => { x.classList.toggle('active', x === c); x.setAttribute('aria-pressed', String(x === c)); });
    draw();
  }));

  const reload = async () => {
    try { p = await api.get(`/podcasts/${params.id}`); draw(); } catch { /* keep what we have */ }
  };
  // Keep progress bars and download states current.
  const offs = [
    player.on('track', draw), player.on('state', draw),
    player.on('progress', (id, position, played) => { const e = p.episodes.find((x) => x.id === id); if (e) { Object.assign(e, { position, played }); } }),
  ];
  const poll = setInterval(() => { if (p.episodes.some((e) => e.downloading)) reload(); }, 3000);
  v._destroy = () => { offs.forEach((off) => off()); clearInterval(poll); };

  v.querySelector('[data-play]').addEventListener('click', () => {
    const next = p.episodes.find((e) => !e.played) || p.episodes[0];
    if (next) playEpisodes([next], 0);
  });
  v.querySelector('[data-sub]')?.addEventListener('click', async () => {
    try { await api.post(`/podcasts/${p.id}/subscribe`); navigate(location.pathname, { replace: true }); } catch (err) { toastError(err); }
  });
  v.querySelector('[data-unsub]')?.addEventListener('click', () => unsubscribe(p));
  v.querySelector('[data-refresh]').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    b.classList.add('spin');
    try {
      const before = p.episodeCount;
      await api.post(`/podcasts/${p.id}/refresh`);
      await reload();
      const n = p.episodeCount - before;
      toast(n > 0 ? plural(n, 'new episode') : t('No new episodes'), { type: n > 0 ? 'success' : 'info' });
    } catch (err) { toastError(err); } finally { b.classList.remove('spin'); }
  });
  v.querySelector('[data-more]').addEventListener('click', (e) => openMenu(e.currentTarget, [
    { icon: 'checkCircle', label: t('Mark all as played'), action: () => markAll(true) },
    { icon: 'refresh', label: t('Mark all as unplayed'), action: () => markAll(false) },
    'sep',
    { icon: 'link', label: t('Copy feed address'), action: () => copyText(p.feedUrl) },
    ...(state.user.isAdmin ? [{ icon: 'download', label: p.autoDownload ? t('Auto-download: newest {n}', { n: p.autoDownload }) : t('Auto-download new episodes…'), action: autoDownloadDialog }] : []),
    ...(p.subscribed ? ['sep', { icon: 'x', label: t('Unfollow'), danger: true, action: () => unsubscribe(p) }] : []),
  ]));

  async function markAll(played) {
    try {
      await api.post(`/podcasts/${p.id}/played`, { played });
      p.episodes.forEach((e) => Object.assign(e, { played, position: 0 }));
      draw();
    } catch (err) { toastError(err); }
  }

  async function autoDownloadDialog() {
    const choice = await modal(html`<h3>${t('Auto-download')}</h3>
      <p>${t('Keep the newest episodes saved on the server, so they start instantly and keep playing if the podcast host is down.')}</p>
      <div class="chips fit">${[0, 1, 3, 5, 10].map((n) => html`<button class="chip ${p.autoDownload === n ? 'active' : ''}" data-n="${n}">${n ? t('Newest {n}', { n }) : t('Off')}</button>`)}</div>
      <div class="modal-actions"><button class="btn ghost" data-close>${t('Cancel')}</button></div>`, (b, close) => {
      b.querySelectorAll('[data-n]').forEach((c) => c.addEventListener('click', () => close(Number(c.dataset.n))));
    });
    if (choice == null) return;
    try { await api.put(`/podcasts/${p.id}/settings`, { autoDownload: choice }); p.autoDownload = choice; reload(); } catch (err) { toastError(err); }
  }
  return v;
}

async function unsubscribe(p) {
  const ok = await confirmDialog({ title: t('Unfollow “{title}”?', { title: p.title }), message: t('Your listening progress for this show is removed too.'), confirm: t('Unfollow'), danger: true });
  if (!ok) return;
  try { await api.del(`/podcasts/${p.id}`); toast(t('Unfollowed “{title}”', { title: p.title })); navigate('/podcasts'); } catch (err) { toastError(err); }
}
