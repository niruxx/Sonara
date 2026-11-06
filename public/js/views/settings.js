// Settings: account, appearance, and (for admins) library folders, scanning and users.
import { api } from '../api.js';
import { html, ic, el, plural, fmtBytes, fmtLong, prefs } from '../util.js';
import { state } from '../state.js';
import { toast, toastError, confirmDialog, formDialog, modal } from '../ui.js';
import { refreshTheme } from '../theme.js';

export async function settingsView() {
  const admin = state.user.isAdmin;
  const [stats, settings, users, scan] = await Promise.all([
    api.get('/stats'),
    admin ? api.get('/admin/settings') : null,
    admin ? api.get('/admin/users') : null,
    admin ? api.get('/admin/scan') : null,
  ]);

  const v = el(html`<div>
    <h1 class="page-title">Settings</h1>
    <p class="page-sub">Signed in as <b>${state.user.username}</b>${admin ? ' · Administrator' : ''}</p>
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
        </div>
      </section>

      <section class="panel wide" style="--i:3" data-panel="users">
        <h3>${ic('users')} Users</h3><p>Everyone gets their own favorites, playlists and history.</p>
        <div class="users"></div>
        <button class="btn sm primary" data-add-user style="margin-top:8px">${ic('plus')} Add user</button>
      </section>` : ''}

      <section class="panel" style="--i:4">
        <h3>${ic('palette')} Appearance</h3><p>Make it yours. Stored in this browser.</p>
        <label class="check"><input type="checkbox" data-pref="dynamicColor" ${prefs.get('dynamicColor', true) ? 'checked' : ''}><span class="sw"></span>Colours follow album art</label>
        <label class="check"><input type="checkbox" data-pref="ambient" ${prefs.get('ambient', true) ? 'checked' : ''}><span class="sw"></span>Animated ambient background</label>
        <label class="check"><input type="checkbox" data-pref="visualizer" ${prefs.get('visualizer', true) ? 'checked' : ''}><span class="sw"></span>Audio visualizer &amp; beat-reactive glow</label>
        <label class="check"><input type="checkbox" data-pref="reduceMotion" ${prefs.get('reduceMotion', false) ? 'checked' : ''}><span class="sw"></span>Reduce motion</label>
      </section>

      <section class="panel" style="--i:5">
        <h3>${ic('key')} Account</h3><p>Change your password. Other sessions will be signed out.</p>
        <button class="btn sm" data-password>${ic('key')} Change password</button>
        <h3 style="margin-top:26px">${ic('keyboard')} Keyboard shortcuts</h3>
        <div class="kbd-list" style="margin-top:12px">
          <kbd class="k">Space</kbd><span>Play / pause</span>
          <kbd class="k">← →</kbd><span>Seek 5 seconds</span>
          <kbd class="k">Shift ← →</kbd><span>Previous / next track</span>
          <kbd class="k">↑ ↓</kbd><span>Volume</span>
          <kbd class="k">M</kbd><span>Mute</span>
          <kbd class="k">S</kbd><span>Shuffle</span>
          <kbd class="k">R</kbd><span>Repeat mode</span>
          <kbd class="k">F</kbd><span>Now playing view</span>
          <kbd class="k">Q</kbd><span>Queue</span>
          <kbd class="k">/</kbd><span>Search</span>
        </div>
      </section>
    </div>
  </div>`);

  // ── Appearance
  v.querySelectorAll('[data-pref]').forEach((input) => input.addEventListener('change', () => {
    prefs.set(input.dataset.pref, input.checked);
    applyPrefs();
    if (input.dataset.pref === 'dynamicColor') refreshTheme();
    if (input.dataset.pref === 'visualizer' && input.checked) toast('Visualizer starts with the next song you play');
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

  if (!admin) return v;

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
        ? `Last scan ${new Date(s.finishedAt).toLocaleString()} — ${plural(s.added, 'new song')}, ${s.updated} updated, ${s.removed} removed${s.errors ? `, ${s.errors} errors` : ''}`
        : 'No scan has run since Sonara started.'}</span></div>
        ${s.lastError ? html`<p class="muted" style="color:#fca5a5">${s.lastError}</p>` : ''}`);
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
        <button class="btn sm ghost" data-u-pw="${u.id}">Reset password</button>
        ${u.id !== state.user.id ? html`
          <button class="btn sm ghost" data-u-admin="${u.id}" data-val="${u.isAdmin ? 0 : 1}">${u.isAdmin ? 'Make listener' : 'Make admin'}</button>
          <button class="icon-btn sm" data-u-del="${u.id}" aria-label="Delete">${ic('trash')}</button>` : html`<span class="muted">(you)</span>`}
      </div>`)}`);
  };
  renderUsers(users);
  const reloadUsers = async () => renderUsers(await api.get('/admin/users'));
  usersBox.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    const user = (await api.get('/admin/users')).find((u) => String(u.id) === (t.dataset.uPw || t.dataset.uAdmin || t.dataset.uDel));
    if (!user) return;
    try {
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

/** Server-side folder browser. Resolves with an absolute path or null. */
function folderPicker() {
  return modal(html`
    <h3>Choose a music folder</h3>
    <p>Browse the server's file system, or paste a path.</p>
    <div class="field"><input name="path" placeholder=" " autocomplete="off"><label>Folder path</label></div>
    <div class="browser"></div>
    <div class="form-error"></div>
    <div class="modal-actions"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" data-ok>${ic('check')} Use this folder</button></div>
  `, (box, close) => {
    const input = box.querySelector('input');
    const list = box.querySelector('.browser');
    const err = box.querySelector('.form-error');
    const go = async (p) => {
      try {
        const r = await api.get('/admin/browse', { path: p });
        err.textContent = '';
        input.value = r.path;
        list.innerHTML = String(html`
          ${r.parent !== null ? html`<button class="menu-item" data-p="${r.parent}">${ic('chevronLeft')}<span>Up</span></button>` : ''}
          ${r.dirs.map((d) => html`<button class="menu-item" data-p="${d.path}">${ic('folder')}<span>${d.name}</span></button>`)}
          ${!r.dirs.length ? html`<p class="muted" style="padding:10px">No sub-folders</p>` : ''}`);
        list.scrollTop = 0;
      } catch (e) { err.textContent = e.message; }
    };
    list.addEventListener('click', (e) => { const b = e.target.closest('[data-p]'); if (b) go(b.dataset.p); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(input.value); } });
    box.querySelector('[data-ok]').addEventListener('click', () => {
      if (!input.value.trim()) { err.textContent = 'Pick a folder first'; return; }
      close(input.value.trim());
    });
    go('');
  });
}

export function applyPrefs() {
  document.body.classList.toggle('no-ambient', !prefs.get('ambient', true));
  document.body.classList.toggle('reduce-motion', !!prefs.get('reduceMotion', false));
}
