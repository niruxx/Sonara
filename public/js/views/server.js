// Server page (admins): health, logs, scan history, backups and restore,
// library reports (duplicates, missing metadata) and everyone's share links.
import { api } from '../api.js';
import { html, ic, el, art, fmtBytes, fmtTime, plural } from '../util.js';
import { t } from '../i18n.js';
import { toast, toastError, confirmDialog, modal } from '../ui.js';
import { emptyState, copyText } from '../components.js';
import { state } from '../state.js';

const TABS = [['overview', 'activity', 'Overview'], ['logs', 'list', 'Logs'], ['backups', 'database', 'Backups'], ['reports', 'filter', 'Reports'], ['shares', 'link', 'Share links']];
const ago = (when) => {
  if (!when) return '—';
  const s = Math.round((Date.now() - when) / 1000);
  if (s < 60) return t('just now');
  if (s < 3600) return t('{n} min ago', { n: Math.round(s / 60) });
  if (s < 86400) return t('{n} h ago', { n: Math.round(s / 3600) });
  return new Date(when).toLocaleDateString();
};
const uptime = (s) => (s < 3600 ? `${Math.floor(s / 60)} min` : s < 86400 ? `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min` : `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h`);
const dur = (ms) => (ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60000)} min`);

export async function serverView({ query }) {
  if (!state.user.isAdmin) return el(html`<div>${emptyState('lock', t('Admins only'), t('Ask an admin if you need something here.'))}</div>`);
  const tab = TABS.some(([k]) => k === query.get('tab')) ? query.get('tab') : 'overview';
  const v = el(html`<div>
    <h1 class="page-title">${t('Server')}</h1>
    <p class="page-sub">${t('Keep an eye on Sonara and keep your data safe.')}</p>
    <div class="chips" style="margin-bottom:20px">${TABS.map(([k, i, l]) => html`<a class="chip ${k === tab ? 'on' : ''}" href="/server?tab=${k}">${ic(i)} ${t(l)}</a>`)}</div>
    <div class="server-body"></div>
  </div>`);
  const body = v.querySelector('.server-body');
  const timers = [];
  v._destroy = () => timers.forEach(clearInterval);
  await ({ overview, logs, backups, reports, shares })[tab](body, timers);
  return v;
}

// ───────── Overview ─────────

async function overview(body) {
  const [h, history, settings] = await Promise.all([fetch('/api/health').then((r) => r.json()), api.get('/admin/scan/history'), api.get('/admin/settings')]);
  body.append(el(html`<div class="panels">
    <section class="panel" style="--i:0">
      <h3>${ic('activity')} ${t('Health')}</h3>
      <div class="stats">
        <div class="stat"><b class="${h.status === 'ok' ? 'ok-text' : 'bad-text'}">${h.status === 'ok' ? t('Healthy') : t('Problem')}</b><span>${t('Status')}</span></div>
        <div class="stat"><b>${uptime(h.uptime)}</b><span>${t('Running for')}</span></div>
        <div class="stat"><b>${h.version}</b><span>${t('Version')}</span></div>
      </div>
      <p class="muted" style="margin-top:12px">${t('Monitors can check')} <code>/api/health</code>. ${settings.metrics ? html`${t('Prometheus metrics are at')} <code>/metrics</code>${settings.metricsTokenSet ? ` ${t('(with your token)')}` : ''}.` : t('Turn on Prometheus metrics in Settings → Operations.')}</p>
    </section>
    <section class="panel" style="--i:1">
      <h3>${ic('folder')} ${t('Where things are')}</h3>
      <div class="kv"><span>${t('Data folder')}</span><code>${settings.dataDir}</code></div>
      <div class="kv"><span>${t('Running on')}</span><span>${settings.platform}, Node ${settings.node}${settings.docker ? `, ${t('in Docker')}` : ''}</span></div>
      <div class="kv"><span>${t('Log format')}</span><span>${settings.logFormat === 'json' ? t('JSON lines') : t('Text')}</span></div>
    </section>
    <section class="panel wide" style="--i:2">
      <h3>${ic('refresh')} ${t('Scan history')}</h3>
      ${history.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr>${['When', 'Took', 'Files', 'New', 'Changed', 'Removed', 'Playlists', 'Problems'].map((h) => html`<th>${t(h)}</th>`)}</tr></thead>
        <tbody>${history.map((r) => html`<tr>
          <td title="${new Date(r.startedAt).toLocaleString()}">${ago(r.finishedAt)}${r.full ? html` <span class="tag">${t('full')}</span>` : ''}</td>
          <td>${dur(r.finishedAt - r.startedAt)}</td><td>${r.found.toLocaleString()}</td>
          <td>${r.added ? html`<b class="ok-text">+${r.added}</b>` : '0'}</td><td>${r.updated}</td><td>${r.removed ? `−${r.removed}` : '0'}</td><td>${r.playlists}</td>
          <td>${r.errors || r.skipped ? html`<span class="${r.errors ? 'bad-text' : ''}">${t('{errors} errors, {skipped} skipped', { errors: r.errors, skipped: r.skipped })}</span>` : '—'}${r.error ? html`<div class="bad-text" style="font-size:12px">${r.error}</div>` : ''}</td>
        </tr>`)}</tbody></table></div>` : html`<p class="muted">${t('No scans recorded yet.')}</p>`}
    </section>
  </div>`));
}

// ───────── Logs ─────────

async function logs(body, timers) {
  body.append(el(html`<div class="panel wide log-panel" style="--i:0">
    <div class="row-gap" style="flex-wrap:wrap">
      <select class="input sm" data-level aria-label="${t('Level')}"><option value="">${t('All messages')}</option><option value="warn">${t('Warnings and errors')}</option><option value="error">${t('Errors only')}</option></select>
      <input class="input sm" data-q placeholder="${t('Filter…')}" style="flex:1;min-width:160px" aria-label="${t('Filter')}">
      <label class="check" style="margin:0"><input type="checkbox" data-live checked><span class="sw"></span>${t('Live')}</label>
      <a class="btn sm ghost" href="/server?tab=logs" data-refresh>${ic('refresh')} ${t('Refresh')}</a>
    </div>
    <div class="log-view mono"></div>
  </div>`));
  const view = body.querySelector('.log-view');
  const level = body.querySelector('[data-level]');
  const qIn = body.querySelector('[data-q]');
  const live = body.querySelector('[data-live]');
  let last = '';
  const load = async () => {
    try {
      const rows = await api.get('/admin/logs', { level: level.value, q: qIn.value, limit: 1000 });
      const key = rows.length + (rows.at(-1)?.time || '');
      if (key === last) return;
      last = key;
      const atBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 40;
      view.innerHTML = String(html`${rows.length ? rows.map((r) => html`<div class="log-line ${r.level.toLowerCase()}"><span class="log-time">${new Date(r.time).toLocaleString()}</span><span class="log-level">${r.level}</span><span class="log-msg">${r.msg}</span></div>`)
        : html`<p class="muted" style="padding:12px">${t('No matching messages.')}</p>`}`);
      if (atBottom || !view.dataset.loaded) view.scrollTop = view.scrollHeight;
      view.dataset.loaded = '1';
    } catch (err) { toastError(err); }
  };
  level.addEventListener('change', () => { last = ''; load(); });
  let typing;
  qIn.addEventListener('input', () => { clearTimeout(typing); typing = setTimeout(() => { last = ''; load(); }, 300); });
  body.querySelector('[data-refresh]').addEventListener('click', (e) => { e.preventDefault(); last = ''; load(); });
  timers.push(setInterval(() => { if (live.checked && !document.hidden) load(); }, 3000));
  await load();
}

// ───────── Backups ─────────

async function backups(body) {
  const draw = async () => {
    const [b, s] = await Promise.all([api.get('/admin/backups'), api.get('/admin/settings')]);
    body.replaceChildren(el(html`<div class="panels">
      ${b.restorePending ? html`<section class="panel wide notice" style="--i:0">
        <h3>${ic('alert')} ${t('A restore is waiting')}</h3>
        <p>${t('The backup replaces the current database when Sonara restarts. Your current database is saved to the backups first.')}</p>
        <div class="row-gap"><button class="btn sm primary" data-restart>${ic('refresh')} ${t('Restart Sonara now')}</button><button class="btn sm ghost" data-cancel-restore>${t('Cancel the restore')}</button></div>
      </section>` : ''}
      <section class="panel wide" style="--i:1">
        <h3>${ic('database')} ${t('Database backups')}</h3>
        <p>${t('Backups hold users, playlists, favorites, ratings, play history and settings for the library. Your music files are not included and never touched.')}</p>
        <div class="row-gap" style="margin-bottom:14px;flex-wrap:wrap">
          <button class="btn sm primary" data-create>${ic('plus')} ${t('Back up now')}</button>
          <button class="btn sm" data-upload>${ic('upload')} ${t('Restore from a file…')}</button>
          <span class="muted" style="margin-left:auto">${s.backupIntervalHours ? t('Automatic: every {hours} h, keeping {keep}', { hours: s.backupIntervalHours, keep: s.backupKeep }) : t('Automatic: off (change in Settings → Operations)')}</span>
        </div>
        ${b.backups.length ? b.backups.map((x, i) => html`<div class="list-row" style="animation-delay:${i * 30}ms">${ic('database')}
          <span class="grow"><b class="mono">${x.name}</b><br><span class="muted">${new Date(x.createdAt).toLocaleString()} · ${fmtBytes(x.size)}</span></span>
          <a class="btn sm ghost" href="/api/admin/backups/${encodeURIComponent(x.name)}" download>${ic('download')} ${t('Download')}</a>
          <button class="btn sm ghost" data-restore="${x.name}">${t('Restore…')}</button>
          <button class="icon-btn sm" data-del="${x.name}" aria-label="${t('Delete')}">${ic('trash')}</button></div>`)
          : html`<p class="muted">${t('No backups yet.')}</p>`}
      </section>
    </div>`));
    const root = body.firstElementChild;
    root.querySelector('[data-create]').addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      try { await api.post('/admin/backups'); toast(t('Backup saved'), { type: 'success' }); } catch (err) { toastError(err); }
      draw();
    });
    root.querySelector('[data-upload]').addEventListener('click', () => {
      const input = el('<input type="file" accept=".db,.sqlite,application/x-sqlite3,application/octet-stream" hidden>');
      document.body.append(input);
      input.addEventListener('change', async () => {
        const f = input.files[0];
        input.remove();
        if (!f) return;
        if (!(await confirmDialog({ title: t('Restore this backup?'), message: t('“{name}” will replace everything in Sonara (users, playlists, history) when it restarts. Your current database is backed up first.', { name: f.name }), confirm: t('Upload and restore'), danger: true }))) return;
        try {
          const res = await fetch('/api/admin/restore/upload', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' }, body: f });
          const r = await res.json();
          if (!res.ok) throw new Error(r.error);
          toast(t('Backup checked: {songs}, {users}. Restart to finish.', { songs: plural(r.tracks, 'song'), users: plural(r.users, 'user') }), { type: 'success', ms: 5000 });
        } catch (err) { toastError(err); }
        draw();
      });
      input.click();
    });
    root.addEventListener('click', async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      try {
        if (b.dataset.restore) {
          if (!(await confirmDialog({ title: t('Restore this backup?'), message: t('Everything in Sonara (users, playlists, history) goes back to {name} when it restarts. Your current database is backed up first.', { name: b.dataset.restore }), confirm: t('Restore'), danger: true }))) return;
          await api.post(`/admin/backups/${encodeURIComponent(b.dataset.restore)}/restore`);
          toast(t('Restore ready. Restart Sonara to apply it.'), { type: 'success' });
          draw();
        } else if (b.dataset.del) {
          if (!(await confirmDialog({ title: t('Delete backup?'), message: b.dataset.del, confirm: t('Delete'), danger: true }))) return;
          await api.del(`/admin/backups/${encodeURIComponent(b.dataset.del)}`);
          draw();
        } else if ('cancelRestore' in b.dataset) {
          await api.del('/admin/restore');
          draw();
        } else if ('restart' in b.dataset) {
          await restartServer(s);
        }
      } catch (err) { toastError(err); }
    });
  };
  await draw();
}

export async function restartServer(settings) {
  const win = settings?.platform === 'win32';
  if (!(await confirmDialog({
    title: t('Restart Sonara?'), confirm: t('Restart'),
    message: t('Playback stops for everyone for a few seconds.') + (win ? ` ${t('On Windows, Sonara only comes back by itself if its Scheduled Task is set to restart on failure; otherwise start it again by hand.')}` : ''),
  }))) return;
  await api.post('/admin/restart');
  toast(t('Restarting…'), { ms: 8000 });
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try { const r = await fetch('/api/health', { cache: 'no-store' }); if (r.ok && i > 1) { location.reload(); return; } } catch { /* still down */ }
  }
  toast(t("Sonara hasn't come back yet. Check that its service is running."), { type: 'error', ms: 8000 });
}

// ───────── Reports ─────────

async function reports(body) {
  const [dupes, missing] = await Promise.all([api.get('/admin/reports/duplicates'), api.get('/admin/reports/missing')]);
  const c = missing.checks;
  body.append(el(html`<div class="panels">
    <section class="panel wide" style="--i:0">
      <h3>${ic('tag')} ${t('Missing metadata')}</h3>
      <p>${t("Out of {songs}. Fix tags from an album's ⋯ menu (Edit tags) when file changes are allowed.", { songs: plural(missing.total, 'song') })}</p>
      <div class="report-grid">${Object.entries(c).map(([k, x]) => html`<button class="report-tile ${x.tracks ? '' : 'done'}" data-check="${k}">
        <b>${x.tracks.toLocaleString()}</b><span>${t(x.label)}</span><small class="muted">${x.tracks ? plural(x.albumCount, 'album') : t('All good')}</small></button>`)}</div>
    </section>
    <section class="panel wide" style="--i:1">
      <h3>${ic('copy')} ${t('Possible duplicates')}</h3>
      <p>${dupes.groups.length ? t('Found {songs} with more than one copy ({extra}). Same artist, title and length, or the same MusicBrainz recording.', { songs: plural(dupes.groups.length, 'song'), extra: plural(dupes.total, 'extra copy', 'extra copies') }) : t('No duplicates found.')}</p>
      <div class="dupes">${dupes.groups.map((g) => html`<div class="dupe">
        <div class="dupe-head"><b>${g.tracks[0].title}</b> <span class="muted">· ${g.tracks[0].artist} · ${t(g.reason)}</span></div>
        ${g.tracks.map((tr) => html`<div class="dupe-row">
          <a href="/album/${tr.albumId}">${tr.album}</a>
          <span class="muted">${[tr.codec, tr.bitrate && `${Math.round(tr.bitrate / 1000)} kbps`, fmtTime(tr.duration), fmtBytes(tr.size)].filter(Boolean).join(' · ')}</span>
          <span class="mono muted dupe-file" title="${tr.file}">${tr.file}</span></div>`)}
      </div>`)}</div>
    </section>
  </div>`));
  body.querySelectorAll('[data-check]').forEach((b) => b.addEventListener('click', () => {
    const x = c[b.dataset.check];
    if (!x.tracks) return;
    modal(html`<h3>${t(x.label)}</h3><p>${t('{songs} on {albums}', { songs: plural(x.tracks, 'song'), albums: plural(x.albumCount, 'album') })}${x.albumCount > 60 ? ` ${t('(showing the 60 with the most)')}` : ''}.</p>
      <div class="report-list">${x.albums.map((a) => html`<a class="list-row" href="/album/${a.id}" data-close>
        <div class="tl-cover">${art(a.cover, a.name, 'disc', 80)}</div><span class="grow"><b>${a.name}</b><br><span class="muted">${a.artist}</span></span><span class="muted">${plural(a.n, 'song')}</span></a>`)}</div>
      <div class="modal-actions"><button class="btn primary" data-close>${t('Close')}</button></div>`);
  }));
}

// ───────── Share links ─────────

async function shares(body) {
  const draw = async () => {
    const list = await api.get('/admin/shares');
    body.replaceChildren(el(html`<section class="panel wide" style="--i:0">
      <h3>${ic('link')} ${t("Everyone's share links")}</h3>
      <p>${t('Anyone with one of these links can listen without an account. Revoke a link to turn it off right away.')}</p>
      ${list.length ? list.map((s, i) => html`<div class="list-row ${s.expired ? 'faded' : ''}" style="animation-delay:${i * 30}ms">${ic(s.kind === 'playlist' ? 'listMusic' : s.kind === 'album' ? 'disc' : 'music')}
        <span class="grow"><b>${s.title}</b><br><span class="muted">${s.owner} · ${plural(s.views, 'view')}${s.lastViewedAt ? `, ${t('last {when}', { when: ago(s.lastViewedAt) })}` : ''} · ${s.expired ? t('expired') : s.expiresAt ? t('expires {date}', { date: new Date(s.expiresAt).toLocaleDateString() }) : t('never expires')}${s.allowDownload ? ` · ${t('downloads on')}` : ''}</span></span>
        <button class="btn sm ghost" data-copy="${s.url}">${ic('copy')} ${t('Copy')}</button>
        <button class="btn sm ghost danger-text" data-revoke="${s.id}">${t('Revoke')}</button></div>`)
        : html`<p class="muted">${t('No share links yet.')}</p>`}
    </section>`));
    body.firstElementChild.addEventListener('click', async (e) => {
      const b = e.target.closest('button');
      if (b?.dataset.copy) copyText(b.dataset.copy);
      if (b?.dataset.revoke) {
        try { await api.del(`/shares/${b.dataset.revoke}`); toast(t('Link revoked')); draw(); } catch (err) { toastError(err); }
      }
    });
  };
  await draw();
}
