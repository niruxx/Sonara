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
import { fmtBytes, art, plural } from '../util.js';
import { t } from '../i18n.js';

// ───────── Panels (markup) ─────────

export const accountExtras = () => html`
  <h3 style="margin-top:26px">${ic('shield')} ${t('Two-factor sign-in')}</h3>
  <p>${t('Ask for a code from an authenticator app (Aegis, Google Authenticator, 1Password…) when signing in with a password.')}</p>
  <div data-2fa></div>
  <h3 style="margin-top:26px">${ic('link')} ${t('Your share links')}</h3>
  <div data-my-shares><p class="muted">${t('Loading…')}</p></div>`;

export const adminPanels = (s) => html`
  <section class="panel wide" style="--i:3" data-panel="devices">
    <h3>${ic('cast')} ${t('Sharing and speakers')}</h3>
    <p>${t('Public links, playlist files, and playing music somewhere other than the browser.')}</p>
    <label class="check"><input type="checkbox" data-x="sharing" ${s.sharing ? 'checked' : ''}><span class="sw"></span>${t('Let people create public share links')}</label>
    <label class="check"><input type="checkbox" data-x="importPlaylists" ${s.importPlaylists ? 'checked' : ''}><span class="sw"></span>${t('Turn .m3u / .m3u8 / .xspf files in the music folders into playlists')}</label>
    <label class="check"><input type="checkbox" data-x="jukebox" ${s.jukebox ? 'checked' : ''}><span class="sw"></span>${t("Jukebox: play through this server's speakers")}
      <span class="muted">${s.jukeboxStatus.ready ? ` ${t('(ready, using {player})', { player: s.jukeboxStatus.player })}` : s.jukebox ? ` ${t('(needs mpv or ffplay)')}` : ''}</span></label>
    <label class="check"><input type="checkbox" data-x="dlna" ${s.dlna ? 'checked' : ''}><span class="sw"></span>${t('Find DLNA / UPnP speakers on the network')}
      <span class="muted">${s.dlna ? ` ${t('({n} found)', { n: s.dlnaStatus.renderers.length })}` : ''}</span></label>
    <div class="row-gap" style="margin-top:8px;flex-wrap:wrap">
      <select class="input sm" data-xs="dlnaFormat" aria-label="${t('Format for network speakers')}">
        <option value="mp3" ${s.dlnaFormat === 'mp3' ? 'selected' : ''}>${t('Network speakers get MP3 320 (plays everywhere)')}</option>
        <option value="original" ${s.dlnaFormat === 'original' ? 'selected' : ''}>${t('Network speakers get original files')}</option></select>
      ${s.dlna ? html`<button class="btn sm ghost" data-discover>${ic('refresh')} ${t('Look for speakers')}</button>` : ''}
    </div>
    <div style="margin-top:14px">
      <label class="muted">${t('Public address (for share links, sign-on and casting)')}</label>
      <input class="input sm" data-xs="publicUrl" value="${s.publicUrl}" placeholder="${t('e.g. https://music.example.com (empty = the address in the browser)')}" style="margin-top:6px;width:100%">
    </div>
    <p class="muted" style="font-size:12px">${t('Speakers and casting are used by admins and by users you allow to (Users → Access).')}</p>
  </section>

  <section class="panel wide" style="--i:3" data-panel="signin">
    <h3>${ic('lock')} ${t('Sign-in')}</h3>
    <p>${t('Sign in with your existing identity provider, or let a reverse proxy (Authelia, Authentik) vouch for users.')}</p>
    <h3 style="font-size:15px;margin-top:6px">${t('Single sign-on (OpenID Connect)')}</h3>
    <div class="form-grid">
      <input class="input sm" data-xs="oidcIssuer" value="${s.oidcIssuer}" placeholder="${t('Issuer URL')}" aria-label="${t('Issuer URL')}">
      <input class="input sm" data-xs="oidcClientId" value="${s.oidcClientId}" placeholder="${t('Client ID')}" aria-label="${t('Client ID')}" autocomplete="off">
      <input class="input sm" data-xs="oidcClientSecret" type="password" placeholder="${s.oidcClientSecretSet ? `${t('Client secret')} ${t('(saved)')}` : t('Client secret')}" aria-label="${t('Client secret')}" autocomplete="new-password">
      <input class="input sm" data-xs="oidcLabel" value="${s.oidcLabel}" placeholder="${t('Button label')}" aria-label="${t('Button label')}">
      <input class="input sm" data-xs="oidcUsernameClaim" value="${s.oidcUsernameClaim}" placeholder="${t('Username claim')}" aria-label="${t('Username claim')}">
      <input class="input sm" data-xs="oidcAdminGroup" value="${s.oidcAdminGroup}" placeholder="${t('Admin group (optional)')}" aria-label="${t('Admin group')}">
    </div>
    <div class="copy-row" style="margin-top:8px"><span class="muted">${t('Redirect URI')}</span><input class="input sm mono" readonly value="${s.oidcRedirectUri}"><button class="btn sm ghost" data-copy="${s.oidcRedirectUri}">${ic('copy')}</button></div>
    <label class="check"><input type="checkbox" data-x="oidcAutoCreate" ${s.oidcAutoCreate ? 'checked' : ''}><span class="sw"></span>${t('Create accounts for new people automatically')}</label>
    <h3 style="font-size:15px;margin-top:18px">${t('Reverse-proxy header')}</h3>
    <div class="form-grid">
      <input class="input sm" data-xs="proxyAuthHeader" value="${s.proxyAuthHeader}" placeholder="${t('Header, e.g. Remote-User (empty = off)')}" aria-label="${t('Header name')}">
      <input class="input sm" data-xs="proxyAuthTrusted" value="${s.proxyAuthTrusted}" placeholder="${t('Trusted proxy addresses')}" aria-label="${t('Trusted proxy addresses')}">
    </div>
    <p class="muted" style="font-size:12px">${t("Only requests coming from those addresses may use the header, so make sure Sonara isn't reachable around the proxy.")}</p>
    <label class="check"><input type="checkbox" data-x="proxyAuthAutoCreate" ${s.proxyAuthAutoCreate ? 'checked' : ''}><span class="sw"></span>${t('Create accounts for new proxy users automatically')}</label>
    <label class="check" style="margin-top:12px"><input type="checkbox" data-x="passwordLogin" ${s.passwordLogin ? 'checked' : ''}><span class="sw"></span>${t('Allow signing in with a password')}</label>
    <h3 style="font-size:15px;margin-top:18px">${t('Client apps (Subsonic API)')}</h3>
    <p class="muted" style="font-size:12px">${t('Apps such as Symfonium, Feishin and DSub connect at this server’s address. People create app passwords for them in Settings → Account.')}</p>
    <label class="check"><input type="checkbox" data-x="subsonic" ${s.subsonic ? 'checked' : ''}><span class="sw"></span>${t('Let client apps connect')}</label>
    <label class="check"><input type="checkbox" data-x="subsonicMainPassword" ${s.subsonicMainPassword ? 'checked' : ''}><span class="sw"></span>${t('Apps may also use account passwords (not only app passwords; never for accounts with two-factor sign-in)')}</label>
  </section>

  <section class="panel wide" style="--i:3" data-panel="ops">
    <h3>${ic('activity')} ${t('Operations')}</h3>
    <p>${t('Logs, monitoring and backups.')} <a href="/server">${t('The Server page')}</a> ${t('has logs, scan history, backups and reports.')}</p>
    <label class="check"><input type="checkbox" data-x="logRequests" ${s.logRequests ? 'checked' : ''}><span class="sw"></span>${t('Log every request')}</label>
    <label class="check"><input type="checkbox" data-x="metrics" ${s.metrics ? 'checked' : ''}><span class="sw"></span>${t('Prometheus metrics at')} <code>/metrics</code></label>
    <div class="form-grid" style="margin-top:8px">
      <select class="input sm" data-xs="logFormat" aria-label="${t('Log format')}"><option value="text" ${s.logFormat === 'text' ? 'selected' : ''}>${t('Text logs')}</option><option value="json" ${s.logFormat === 'json' ? 'selected' : ''}>${t('JSON logs (for log collectors)')}</option></select>
      <input class="input sm" data-xs="metricsToken" type="password" placeholder="${s.metricsTokenSet ? `${t('Metrics token')} ${t('(saved)')}` : `${t('Metrics token')} ${t('(optional)')}`}" aria-label="${t('Metrics token')}" autocomplete="new-password">
      <label class="row-gap"><span class="muted">${t('Back up every')}</span><input class="input sm" type="number" min="0" max="720" data-xs="backupIntervalHours" value="${s.backupIntervalHours}" style="width:80px"><span class="muted">${t('hours (0 = off), keep')}</span>
        <input class="input sm" type="number" min="1" max="500" data-xs="backupKeep" value="${s.backupKeep}" style="width:70px"></label>
    </div>
    <div class="row-gap" style="margin-top:12px"><a class="btn sm" href="/server?tab=backups">${ic('database')} ${t('Backups')}</a><button class="btn sm ghost" data-restart>${ic('refresh')} ${t('Restart Sonara')}</button></div>
  </section>`;

export const offlinePanel = () => html`
  <section class="panel" style="--i:5" data-panel="offline">
    <h3>${ic('download')} ${t('Offline music')}</h3>
    <p>${t('Albums and playlists saved on this device play without a connection. Use “Make available offline” in their ⋯ menu.')}</p>
    <div data-offline><p class="muted">${t('Loading…')}</p></div>
  </section>`;

async function drawOffline(box) {
  if (!box) return;
  if (!offlineSupported()) {
    box.innerHTML = String(html`<p class="muted">${t('This needs Sonara to be opened over HTTPS (or on localhost), because browsers only allow offline storage on secure pages.')}</p>`);
    return;
  }
  const list = offlineList();
  const info = await storageInfo();
  box.innerHTML = String(html`
    ${list.length ? list.map((x) => html`<div class="list-row" style="animation:none">
      <div class="tl-cover">${art(x.cover, x.name, x.kind === 'playlist' ? 'playlist' : 'disc', 80)}</div>
      <a class="grow" href="/${x.kind}/${encodeURIComponent(x.id)}"><b>${x.name}</b><br><span class="muted">${plural(x.trackIds.length, 'song')} · ${fmtBytes(x.bytes)}</span></a>
      <button class="icon-btn sm" data-off-rm="${x.kind}|${x.id}" aria-label="${t('Remove')}">${ic('trash')}</button></div>`)
      : html`<p class="muted">${t('Nothing saved yet.')}</p>`}
    <p class="muted" style="font-size:12px;margin-top:8px">${info.quota ? t('Using {used} of about {quota} available', { used: fmtBytes(info.usage), quota: fmtBytes(info.quota) }) : t('Using {used}', { used: fmtBytes(info.usage) })}${info.persisted ? ` · ${t('protected from automatic clean-up')}` : ''}.</p>
    ${list.length ? html`<button class="btn sm ghost" data-off-clear>${t('Remove everything')}</button>` : ''}`);
  box.onclick = async (e) => {
    const rm = e.target.closest('[data-off-rm]');
    if (rm) { const [kind, ...id] = rm.dataset.offRm.split('|'); await removeOffline(kind, id.join('|')); }
    if (e.target.closest('[data-off-clear]')) {
      if (!(await confirmDialog({ title: t('Remove all offline music?'), message: t('Saved songs are deleted from this device. Nothing changes on the server.'), confirm: t('Remove'), danger: true }))) return;
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
      toast(input.checked ? t('Turned on') : t('Turned off'), { type: 'success', ms: 1200 });
      if (input.dataset.x === 'sharing') state.sharing = input.checked;
    } catch (err) { input.checked = !input.checked; toastError(err); }
  }));
  v.querySelectorAll('[data-xs]').forEach((input) => input.addEventListener('change', async () => {
    try {
      await api.put('/admin/settings', { [input.dataset.xs]: input.type === 'number' ? Number(input.value) : input.value });
      if (input.type === 'password') { input.value = ''; input.placeholder = `${input.getAttribute('aria-label')} ${t('(saved)')}`; }
      toast(t('Saved'), { type: 'success', ms: 1200 });
    } catch (err) { toastError(err); }
  }));
  v.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => copyText(b.dataset.copy)));
  v.querySelector('[data-discover]')?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try { const r = await api.post('/admin/speakers/discover'); toast(t('{speakers} found', { speakers: plural(r.dlna.renderers.length, 'speaker') }), { type: 'success' }); } catch (err) { toastError(err); }
    e.currentTarget.disabled = false;
  });
  v.querySelector('[data-restart]')?.addEventListener('click', () => restartServer(settings).catch(toastError));
}

async function draw2fa(box) {
  if (!box) return;
  const me = (await api.get('/auth/status')).user;
  box.innerHTML = String(me.twoFactor
    ? html`<div class="row-gap"><span class="tag ok">${ic('check')} ${t('On')}</span><button class="btn sm ghost" data-off>${t('Turn off…')}</button></div>`
    : html`<button class="btn sm" data-on>${ic('shield')} ${t('Turn on…')}</button>${!me.hasPassword ? html`<p class="muted" style="font-size:12px">${t('You sign in through single sign-on; set a password first to use this.')}</p>` : ''}`);
  box.querySelector('[data-off]')?.addEventListener('click', async () => {
    const val = await formDialog({
      title: t('Turn off two-factor sign-in'), confirm: t('Turn off'), fields: [{ name: 'code', label: t('Current 6-digit code') }],
      validate: async (x) => { try { await api.post('/me/2fa/disable', { code: x.code }); return null; } catch (err) { return err.message; } },
    });
    if (val) { toast(t('Two-factor sign-in is off')); draw2fa(box); }
  });
  box.querySelector('[data-on]')?.addEventListener('click', async () => {
    let s;
    try { s = await api.post('/me/2fa/setup'); } catch (err) { return toastError(err); }
    const ok = await modal(html`
      <h3>${ic('shield')} ${t('Set up two-factor sign-in')}</h3>
      <p>${t('In your authenticator app, add an account and enter this key (or open the link on your phone):')}</p>
      <div class="copy-row"><input class="input mono" readonly value="${s.secret.replace(/(.{4})/g, '$1 ').trim()}"><button class="btn sm" data-copy-key>${ic('copy')}</button></div>
      <p style="margin-top:8px"><a href="${s.uri}">${t('Open in authenticator app')}</a></p>
      <div class="field" style="margin-top:14px"><input name="code" inputmode="numeric" maxlength="6" placeholder=" " autocomplete="one-time-code"><label>${t('Then enter the 6-digit code it shows')}</label></div>
      <div class="form-error"></div>
      <div class="modal-actions"><button class="btn ghost" data-close>${t('Cancel')}</button><button class="btn primary" data-ok>${t('Turn on')}</button></div>`, (m, close) => {
      m.querySelector('[data-copy-key]').addEventListener('click', () => copyText(s.secret));
      const go = async () => {
        try { await api.post('/me/2fa/enable', { code: m.querySelector('[name=code]').value }); close(true); } catch (err) { m.querySelector('.form-error').textContent = err.message; }
      };
      m.querySelector('[data-ok]').addEventListener('click', go);
      m.querySelector('[name=code]').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    });
    if (ok) { toast(t('Two-factor sign-in is on. Other devices were signed out.'), { type: 'success' }); draw2fa(box); }
  });
}

async function drawMyShares(box) {
  if (!box) return;
  const list = await api.get('/shares').catch(() => []);
  const live = list.filter((s) => !s.expired);
  box.innerHTML = String(live.length ? html`${live.map((s) => html`<div class="list-row" style="animation:none">${ic(s.kind === 'playlist' ? 'listMusic' : s.kind === 'album' ? 'disc' : 'music')}
      <span class="grow"><b>${s.title}</b><br><span class="muted">${plural(s.views, 'view')} · ${s.expiresAt ? t('until {date}', { date: new Date(s.expiresAt).toLocaleDateString() }) : t('never expires')}</span></span>
      <button class="icon-btn sm" data-copy="${s.url}" aria-label="${t('Copy link')}">${ic('copy')}</button>
      <button class="icon-btn sm" data-revoke="${s.id}" aria-label="${t('Revoke')}">${ic('trash')}</button></div>`)}`
    : html`<p class="muted">${t('None yet. Use “Share…” on a song, album or playlist.')}</p>`);
  box.onclick = async (e) => {
    const b = e.target.closest('button');
    if (b?.dataset.copy) copyText(b.dataset.copy);
    if (b?.dataset.revoke) { await api.del(`/shares/${b.dataset.revoke}`).catch(toastError); drawMyShares(box); }
  };
}

/** Permissions and library access for one user. */
export async function userAccessDialog(user, musicDirs) {
  const PERMS = [['download', 'Download music'], ['share', 'Create public share links'], ['playlists', 'Create and edit playlists'], ['jukebox', 'Use the server speakers and network speakers']];
  const dirs = user.libraryDirs || [];
  const saved = await modal(html`
    <h3>${ic('shield')} ${t('Access for {name}', { name: user.username })}</h3>
    ${user.isAdmin ? html`<p>${t('Admins can always do everything and see the whole library.')}</p>` : html`
    <h3 style="font-size:15px">${t('Allowed to')}</h3>
    ${PERMS.map(([k, l]) => html`<label class="check"><input type="checkbox" data-perm="${k}" ${user.permissions[k] ? 'checked' : ''}><span class="sw"></span>${t(l)}</label>`)}
    <h3 style="font-size:15px;margin-top:16px">${t('Library')}</h3>
    <label class="check"><input type="radio" name="lib" value="all" ${dirs.length ? '' : 'checked'}><span class="sw"></span>${t('The whole library')}</label>
    <label class="check"><input type="radio" name="lib" value="some" ${dirs.length ? 'checked' : ''}><span class="sw"></span>${t('Only these folders:')}</label>
    <textarea class="input mono" data-dirs rows="4" placeholder="${t('One folder per line, inside your music folders')}" style="width:100%">${dirs.join('\n')}</textarea>
    <p class="muted" style="font-size:12px">${t('Music folders:')} ${musicDirs.join(', ') || t('none yet')}</p>`}
    ${user.twoFactor ? html`<button class="btn sm ghost" data-reset2fa style="margin-top:10px">${t('Turn off their two-factor sign-in')}</button>` : ''}
    <div class="form-error"></div>
    <div class="modal-actions"><button class="btn ghost" data-close>${t('Cancel')}</button>${user.isAdmin ? '' : html`<button class="btn primary" data-ok>${t('Save')}</button>`}</div>`, (m, close) => {
    m.querySelector('[data-reset2fa]')?.addEventListener('click', async () => {
      if (!(await confirmDialog({ title: t('Turn off two-factor sign-in?'), message: t('{name} will only need their password to sign in.', { name: user.username }), confirm: t('Turn off'), danger: true }))) return;
      try { await api.put(`/admin/users/${user.id}`, { resetTwoFactor: true }); toast(t('Two-factor sign-in turned off')); close(true); } catch (err) { toastError(err); }
    });
    m.querySelector('[data-ok]')?.addEventListener('click', async () => {
      const permissions = Object.fromEntries([...m.querySelectorAll('[data-perm]')].map((c) => [c.dataset.perm, c.checked]));
      const some = m.querySelector('[name=lib]:checked').value === 'some';
      const libraryDirs = some ? m.querySelector('[data-dirs]').value.split('\n').map((x) => x.trim()).filter(Boolean) : null;
      try { await api.put(`/admin/users/${user.id}`, { permissions, libraryDirs }); close(true); } catch (err) { m.querySelector('.form-error').textContent = err.message; }
    });
  });
  if (saved) toast(t('Saved'), { type: 'success', ms: 1200 });
  return saved;
}

export { el };
