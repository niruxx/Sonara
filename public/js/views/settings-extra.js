// Settings panels added for multi-device, sharing, security and operations:
// two-factor sign-in, your share links, and (admins) sharing & speakers,
// sign-in methods, operations, and per-user permissions / library access.
import { api } from '../api.js';
import { html, ic, el } from '../util.js';
import { state } from '../state.js';
import { toast, toastError, confirmDialog, modal, formDialog } from '../ui.js';
import { copyText } from '../components.js';
import { restartServer } from './server.js';
import { offlineSupported, offlineList, removeOffline, clearOffline, storageInfo, offline } from '../offline.js';
import { fmtBytes, art } from '../util.js';

// ───────── Panels (markup) ─────────

export const accountExtras = () => html`
  <h3 style="margin-top:26px">${ic('shield')} Two-factor sign-in</h3>
  <p>Ask for a code from an authenticator app (Aegis, Google Authenticator, 1Password…) when signing in with a password.</p>
  <div data-2fa></div>
  <h3 style="margin-top:26px">${ic('link')} Your share links</h3>
  <div data-my-shares><p class="muted">Loading…</p></div>`;

export const adminPanels = (s) => html`
  <section class="panel wide" style="--i:3" data-panel="devices">
    <h3>${ic('cast')} Sharing &amp; speakers</h3>
    <p>Public links, playlist files, and playing music somewhere other than the browser.</p>
    <label class="check"><input type="checkbox" data-x="sharing" ${s.sharing ? 'checked' : ''}><span class="sw"></span>Let people create public share links</label>
    <label class="check"><input type="checkbox" data-x="importPlaylists" ${s.importPlaylists ? 'checked' : ''}><span class="sw"></span>Turn .m3u / .m3u8 / .xspf files in the music folders into playlists</label>
    <label class="check"><input type="checkbox" data-x="jukebox" ${s.jukebox ? 'checked' : ''}><span class="sw"></span>Jukebox: play through this server's speakers
      <span class="muted">${s.jukeboxStatus.ready ? ` (ready, using ${s.jukeboxStatus.player})` : s.jukebox ? ' (needs mpv or ffplay)' : ''}</span></label>
    <label class="check"><input type="checkbox" data-x="dlna" ${s.dlna ? 'checked' : ''}><span class="sw"></span>Find DLNA / UPnP speakers on the network
      <span class="muted">${s.dlna ? ` (${s.dlnaStatus.renderers.length} found)` : ''}</span></label>
    <div class="row-gap" style="margin-top:8px;flex-wrap:wrap">
      <select class="input sm" data-xs="dlnaFormat" aria-label="Format for network speakers">
        <option value="mp3" ${s.dlnaFormat === 'mp3' ? 'selected' : ''}>Network speakers get MP3 320 (plays everywhere)</option>
        <option value="original" ${s.dlnaFormat === 'original' ? 'selected' : ''}>Network speakers get original files</option></select>
      ${s.dlna ? html`<button class="btn sm ghost" data-discover>${ic('refresh')} Look for speakers</button>` : ''}
    </div>
    <div style="margin-top:14px">
      <label class="muted">Public address (for share links, sign-on and casting)</label>
      <input class="input sm" data-xs="publicUrl" value="${s.publicUrl}" placeholder="e.g. https://music.example.com (empty = the address in the browser)" style="margin-top:6px;width:100%">
    </div>
    <p class="muted" style="font-size:12px">Speakers and casting are used by admins and by users you allow to (Users → Access).</p>
  </section>

  <section class="panel wide" style="--i:3" data-panel="signin">
    <h3>${ic('lock')} Sign-in</h3>
    <p>Sign in with your existing identity provider, or let a reverse proxy (Authelia, Authentik) vouch for users.</p>
    <h3 style="font-size:15px;margin-top:6px">Single sign-on (OpenID Connect)</h3>
    <div class="form-grid">
      <input class="input sm" data-xs="oidcIssuer" value="${s.oidcIssuer}" placeholder="Issuer URL" aria-label="Issuer URL">
      <input class="input sm" data-xs="oidcClientId" value="${s.oidcClientId}" placeholder="Client ID" aria-label="Client ID" autocomplete="off">
      <input class="input sm" data-xs="oidcClientSecret" type="password" placeholder="${s.oidcClientSecretSet ? 'Client secret (saved)' : 'Client secret'}" aria-label="Client secret" autocomplete="new-password">
      <input class="input sm" data-xs="oidcLabel" value="${s.oidcLabel}" placeholder="Button label" aria-label="Button label">
      <input class="input sm" data-xs="oidcUsernameClaim" value="${s.oidcUsernameClaim}" placeholder="Username claim" aria-label="Username claim">
      <input class="input sm" data-xs="oidcAdminGroup" value="${s.oidcAdminGroup}" placeholder="Admin group (optional)" aria-label="Admin group">
    </div>
    <div class="copy-row" style="margin-top:8px"><span class="muted">Redirect URI</span><input class="input sm mono" readonly value="${s.oidcRedirectUri}"><button class="btn sm ghost" data-copy="${s.oidcRedirectUri}">${ic('copy')}</button></div>
    <label class="check"><input type="checkbox" data-x="oidcAutoCreate" ${s.oidcAutoCreate ? 'checked' : ''}><span class="sw"></span>Create accounts for new people automatically</label>
    <h3 style="font-size:15px;margin-top:18px">Reverse-proxy header</h3>
    <div class="form-grid">
      <input class="input sm" data-xs="proxyAuthHeader" value="${s.proxyAuthHeader}" placeholder="Header, e.g. Remote-User (empty = off)" aria-label="Header name">
      <input class="input sm" data-xs="proxyAuthTrusted" value="${s.proxyAuthTrusted}" placeholder="Trusted proxy addresses" aria-label="Trusted proxy addresses">
    </div>
    <p class="muted" style="font-size:12px">Only requests coming from those addresses may use the header, so make sure Sonara isn't reachable around the proxy.</p>
    <label class="check"><input type="checkbox" data-x="proxyAuthAutoCreate" ${s.proxyAuthAutoCreate ? 'checked' : ''}><span class="sw"></span>Create accounts for new proxy users automatically</label>
    <label class="check" style="margin-top:12px"><input type="checkbox" data-x="passwordLogin" ${s.passwordLogin ? 'checked' : ''}><span class="sw"></span>Allow signing in with a password</label>
  </section>

  <section class="panel wide" style="--i:3" data-panel="ops">
    <h3>${ic('activity')} Operations</h3>
    <p>Logs, monitoring and backups. See the <a href="/server">Server page</a> for logs, scan history, backups and reports.</p>
    <label class="check"><input type="checkbox" data-x="logRequests" ${s.logRequests ? 'checked' : ''}><span class="sw"></span>Log every request</label>
    <label class="check"><input type="checkbox" data-x="metrics" ${s.metrics ? 'checked' : ''}><span class="sw"></span>Prometheus metrics at <code>/metrics</code></label>
    <div class="form-grid" style="margin-top:8px">
      <select class="input sm" data-xs="logFormat" aria-label="Log format"><option value="text" ${s.logFormat === 'text' ? 'selected' : ''}>Text logs</option><option value="json" ${s.logFormat === 'json' ? 'selected' : ''}>JSON logs (for log collectors)</option></select>
      <input class="input sm" data-xs="metricsToken" type="password" placeholder="${s.metricsTokenSet ? 'Metrics token (saved)' : 'Metrics token (optional)'}" aria-label="Metrics token" autocomplete="new-password">
      <label class="row-gap"><span class="muted">Back up every</span><input class="input sm" type="number" min="0" max="720" data-xs="backupIntervalHours" value="${s.backupIntervalHours}" style="width:80px"><span class="muted">hours (0 = off), keep</span>
        <input class="input sm" type="number" min="1" max="500" data-xs="backupKeep" value="${s.backupKeep}" style="width:70px"></label>
    </div>
    <div class="row-gap" style="margin-top:12px"><a class="btn sm" href="/server?tab=backups">${ic('database')} Backups</a><button class="btn sm ghost" data-restart>${ic('refresh')} Restart Sonara</button></div>
  </section>`;

export const offlinePanel = () => html`
  <section class="panel" style="--i:5" data-panel="offline">
    <h3>${ic('download')} Offline music</h3>
    <p>Albums and playlists saved on this device play without a connection. Use “Make available offline” in their ⋯ menu.</p>
    <div data-offline><p class="muted">Loading…</p></div>
  </section>`;

async function drawOffline(box) {
  if (!box) return;
  if (!offlineSupported()) {
    box.innerHTML = String(html`<p class="muted">This needs Sonara to be opened over HTTPS (or on localhost), because browsers only allow offline storage on secure pages.</p>`);
    return;
  }
  const list = offlineList();
  const info = await storageInfo();
  box.innerHTML = String(html`
    ${list.length ? list.map((x) => html`<div class="list-row" style="animation:none">
      <div class="tl-cover">${art(x.cover, x.name, x.kind === 'playlist' ? 'playlist' : 'disc', 80)}</div>
      <a class="grow" href="/${x.kind}/${encodeURIComponent(x.id)}"><b>${x.name}</b><br><span class="muted">${x.trackIds.length} songs · ${fmtBytes(x.bytes)}</span></a>
      <button class="icon-btn sm" data-off-rm="${x.kind}|${x.id}" aria-label="Remove">${ic('trash')}</button></div>`)
      : html`<p class="muted">Nothing saved yet.</p>`}
    <p class="muted" style="font-size:12px;margin-top:8px">Using ${fmtBytes(info.usage)}${info.quota ? ` of about ${fmtBytes(info.quota)} available` : ''}${info.persisted ? ' · protected from automatic clean-up' : ''}.</p>
    ${list.length ? html`<button class="btn sm ghost" data-off-clear>Remove everything</button>` : ''}`);
  box.onclick = async (e) => {
    const rm = e.target.closest('[data-off-rm]');
    if (rm) { const [kind, ...id] = rm.dataset.offRm.split('|'); await removeOffline(kind, id.join('|')); }
    if (e.target.closest('[data-off-clear]')) {
      if (!(await confirmDialog({ title: 'Remove all offline music?', message: 'Saved songs are deleted from this device. Nothing changes on the server.', confirm: 'Remove', danger: true }))) return;
      await clearOffline();
    }
  };
}

// ───────── Behaviour ─────────

export function bindExtras(v, settings) {
  draw2fa(v.querySelector('[data-2fa]'));
  drawMyShares(v.querySelector('[data-my-shares]'));
  const offBox = v.querySelector('[data-offline]');
  drawOffline(offBox);
  const unsub = offline.on('change', () => (offBox.isConnected ? drawOffline(offBox) : unsub()));
  if (!settings) return;
  v.querySelectorAll('[data-x]').forEach((input) => input.addEventListener('change', async () => {
    try {
      await api.put('/admin/settings', { [input.dataset.x]: input.checked });
      toast(input.checked ? 'Turned on' : 'Turned off', { type: 'success', ms: 1200 });
      if (input.dataset.x === 'sharing') state.sharing = input.checked;
    } catch (err) { input.checked = !input.checked; toastError(err); }
  }));
  v.querySelectorAll('[data-xs]').forEach((input) => input.addEventListener('change', async () => {
    try {
      await api.put('/admin/settings', { [input.dataset.xs]: input.type === 'number' ? Number(input.value) : input.value });
      if (input.type === 'password') { input.value = ''; input.placeholder = input.placeholder.replace(/\(optional\)|$/, '').trim() + ' (saved)'; }
      toast('Saved', { type: 'success', ms: 1200 });
    } catch (err) { toastError(err); }
  }));
  v.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => copyText(b.dataset.copy)));
  v.querySelector('[data-discover]')?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try { const r = await api.post('/admin/speakers/discover'); toast(`${r.dlna.renderers.length} speaker${r.dlna.renderers.length === 1 ? '' : 's'} found`, { type: 'success' }); } catch (err) { toastError(err); }
    e.currentTarget.disabled = false;
  });
  v.querySelector('[data-restart]')?.addEventListener('click', () => restartServer(settings).catch(toastError));
}

async function draw2fa(box) {
  if (!box) return;
  const me = (await api.get('/auth/status')).user;
  box.innerHTML = String(me.twoFactor
    ? html`<div class="row-gap"><span class="tag ok">${ic('check')} On</span><button class="btn sm ghost" data-off>Turn off…</button></div>`
    : html`<button class="btn sm" data-on>${ic('shield')} Turn on…</button>${!me.hasPassword ? html`<p class="muted" style="font-size:12px">You sign in through single sign-on; set a password first to use this.</p>` : ''}`);
  box.querySelector('[data-off]')?.addEventListener('click', async () => {
    const val = await formDialog({
      title: 'Turn off two-factor sign-in', confirm: 'Turn off', fields: [{ name: 'code', label: 'Current 6-digit code' }],
      validate: async (x) => { try { await api.post('/me/2fa/disable', { code: x.code }); return null; } catch (err) { return err.message; } },
    });
    if (val) { toast('Two-factor sign-in is off'); draw2fa(box); }
  });
  box.querySelector('[data-on]')?.addEventListener('click', async () => {
    let s;
    try { s = await api.post('/me/2fa/setup'); } catch (err) { return toastError(err); }
    const ok = await modal(html`
      <h3>${ic('shield')} Set up two-factor sign-in</h3>
      <p>In your authenticator app, add an account and enter this key (or open the link on your phone):</p>
      <div class="copy-row"><input class="input mono" readonly value="${s.secret.replace(/(.{4})/g, '$1 ').trim()}"><button class="btn sm" data-copy-key>${ic('copy')}</button></div>
      <p style="margin-top:8px"><a href="${s.uri}">Open in authenticator app</a></p>
      <div class="field" style="margin-top:14px"><input name="code" inputmode="numeric" maxlength="6" placeholder=" " autocomplete="one-time-code"><label>Then enter the 6-digit code it shows</label></div>
      <div class="form-error"></div>
      <div class="modal-actions"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" data-ok>Turn on</button></div>`, (m, close) => {
      m.querySelector('[data-copy-key]').addEventListener('click', () => copyText(s.secret));
      const go = async () => {
        try { await api.post('/me/2fa/enable', { code: m.querySelector('[name=code]').value }); close(true); } catch (err) { m.querySelector('.form-error').textContent = err.message; }
      };
      m.querySelector('[data-ok]').addEventListener('click', go);
      m.querySelector('[name=code]').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    });
    if (ok) { toast('Two-factor sign-in is on. Other devices were signed out.', { type: 'success' }); draw2fa(box); }
  });
}

async function drawMyShares(box) {
  if (!box) return;
  const list = await api.get('/shares').catch(() => []);
  const live = list.filter((s) => !s.expired);
  box.innerHTML = String(live.length ? html`${live.map((s) => html`<div class="list-row" style="animation:none">${ic(s.kind === 'playlist' ? 'listMusic' : s.kind === 'album' ? 'disc' : 'music')}
      <span class="grow"><b>${s.title}</b><br><span class="muted">${s.views} views · ${s.expiresAt ? `until ${new Date(s.expiresAt).toLocaleDateString()}` : 'never expires'}</span></span>
      <button class="icon-btn sm" data-copy="${s.url}" aria-label="Copy link">${ic('copy')}</button>
      <button class="icon-btn sm" data-revoke="${s.id}" aria-label="Revoke">${ic('trash')}</button></div>`)}`
    : html`<p class="muted">None yet. Use “Share…” on a song, album or playlist.</p>`);
  box.onclick = async (e) => {
    const t = e.target.closest('button');
    if (t?.dataset.copy) copyText(t.dataset.copy);
    if (t?.dataset.revoke) { await api.del(`/shares/${t.dataset.revoke}`).catch(toastError); drawMyShares(box); }
  };
}

/** Permissions and library access for one user. */
export async function userAccessDialog(user, musicDirs) {
  const PERMS = [['download', 'Download music'], ['share', 'Create public share links'], ['playlists', 'Create and edit playlists'], ['jukebox', 'Use the server speakers and network speakers']];
  const dirs = user.libraryDirs || [];
  const saved = await modal(html`
    <h3>${ic('shield')} Access for ${user.username}</h3>
    ${user.isAdmin ? html`<p>Admins can always do everything and see the whole library.</p>` : html`
    <h3 style="font-size:15px">Allowed to</h3>
    ${PERMS.map(([k, l]) => html`<label class="check"><input type="checkbox" data-perm="${k}" ${user.permissions[k] ? 'checked' : ''}><span class="sw"></span>${l}</label>`)}
    <h3 style="font-size:15px;margin-top:16px">Library</h3>
    <label class="check"><input type="radio" name="lib" value="all" ${dirs.length ? '' : 'checked'}><span class="sw"></span>The whole library</label>
    <label class="check"><input type="radio" name="lib" value="some" ${dirs.length ? 'checked' : ''}><span class="sw"></span>Only these folders:</label>
    <textarea class="input mono" data-dirs rows="4" placeholder="One folder per line, inside your music folders" style="width:100%">${dirs.join('\n')}</textarea>
    <p class="muted" style="font-size:12px">Music folders: ${musicDirs.join(', ') || 'none yet'}</p>`}
    ${user.twoFactor ? html`<button class="btn sm ghost" data-reset2fa style="margin-top:10px">Turn off their two-factor sign-in</button>` : ''}
    <div class="form-error"></div>
    <div class="modal-actions"><button class="btn ghost" data-close>Cancel</button>${user.isAdmin ? '' : html`<button class="btn primary" data-ok>Save</button>`}</div>`, (m, close) => {
    m.querySelector('[data-reset2fa]')?.addEventListener('click', async () => {
      if (!(await confirmDialog({ title: 'Turn off two-factor sign-in?', message: `${user.username} will only need their password to sign in.`, confirm: 'Turn off', danger: true }))) return;
      try { await api.put(`/admin/users/${user.id}`, { resetTwoFactor: true }); toast('Two-factor sign-in turned off'); close(true); } catch (err) { toastError(err); }
    });
    m.querySelector('[data-ok]')?.addEventListener('click', async () => {
      const permissions = Object.fromEntries([...m.querySelectorAll('[data-perm]')].map((c) => [c.dataset.perm, c.checked]));
      const some = m.querySelector('[name=lib]:checked').value === 'some';
      const libraryDirs = some ? m.querySelector('[data-dirs]').value.split('\n').map((x) => x.trim()).filter(Boolean) : null;
      try { await api.put(`/admin/users/${user.id}`, { permissions, libraryDirs }); close(true); } catch (err) { m.querySelector('.form-error').textContent = err.message; }
    });
  });
  if (saved) toast('Saved', { type: 'success', ms: 1200 });
  return saved;
}

export { el };
