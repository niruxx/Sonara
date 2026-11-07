// Settings → Account → Apps: app passwords for Subsonic / OpenSubsonic apps
// (Symfonium, DSub, Ultrasonic, Substreamer, play:Sub, Tempo, Feishin, Supersonic…).
import { api } from '../api.js';
import { html, ic } from '../util.js';
import { state } from '../state.js';
import { toast, toastError, confirmDialog, modal } from '../ui.js';
import { t } from '../i18n.js';

export const appsPanel = () => html`
  <h3 style="margin-top:26px">${ic('phone')} ${t('Apps')}</h3>
  <p>${t('Listen with apps such as Symfonium, Feishin, DSub or Substreamer. Add a Subsonic (or OpenSubsonic) server in the app with these details, and an app password instead of your own password.')}</p>
  <div class="kv"><span>${t('Server address')}</span><code data-app-url></code></div>
  <div class="kv"><span>${t('Username')}</span><code>${state.user.username}</code></div>
  <div data-app-passwords style="margin-top:10px"><p class="muted">${t('Loading…')}</p></div>
  <button class="btn sm" data-app-new style="margin-top:8px">${ic('plus')} ${t('Create an app password')}</button>`;

const when = (ms) => (ms ? new Date(ms).toLocaleString() : null);

async function draw(box) {
  let list;
  try { list = await api.get('/me/app-passwords'); } catch (err) { box.innerHTML = ''; toastError(err); return; }
  box.innerHTML = String(list.length ? html`${list.map((p) => html`<div class="list-row" style="animation:none">${ic('key')}
      <span class="grow"><b>${p.name}</b><br><span class="muted">${p.lastUsedAt
        ? t('Last used {when}{client}', { when: when(p.lastUsedAt), client: p.lastClient ? ` · ${p.lastClient}` : '' })
        : t('Created {when}, not used yet', { when: when(p.createdAt) })}</span></span>
      <button class="icon-btn sm" data-app-del="${p.id}" data-name="${p.name}" aria-label="${t('Revoke')}">${ic('trash')}</button></div>`)}`
    : html`<p class="muted">${t('No app passwords yet.')}</p>`);
}

export function bindApps(v) {
  const box = v.querySelector('[data-app-passwords]');
  if (!box) return;
  v.querySelector('[data-app-url]').textContent = location.origin;
  draw(box);
  box.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-app-del]');
    if (!b) return;
    if (!(await confirmDialog({ title: t('Revoke this app password?'), message: t('“{name}” stops working right away. Other apps keep working.', { name: b.dataset.name }), confirm: t('Revoke'), danger: true }))) return;
    try { await api.del(`/me/app-passwords/${b.dataset.appDel}`); draw(box); } catch (err) { toastError(err); }
  });
  v.querySelector('[data-app-new]').addEventListener('click', async () => {
    let created = null;
    await modal(html`
      <h3>${ic('key')} ${t('Create an app password')}</h3>
      <p>${t('Name it after the app or device, so you know which one to revoke later.')}</p>
      <div class="field"><input name="name" placeholder=" " autocomplete="off" maxlength="80"><label>${t('Name, such as “Symfonium on my phone”')}</label></div>
      <div data-result hidden>
        <p>${t('Enter this password in the app. It is shown only once.')}</p>
        <div class="copy-row"><input class="input mono" readonly data-pw><button class="btn sm primary" data-copy-pw>${ic('copy')} ${t('Copy')}</button></div>
      </div>
      <div class="form-error"></div>
      <div class="modal-actions"><button class="btn ghost" data-close>${t('Close')}</button><button class="btn primary" data-create>${t('Create')}</button></div>`, (m) => {
      const name = m.querySelector('[name=name]');
      const go = async () => {
        try {
          created = await api.post('/me/app-passwords', { name: name.value });
          m.querySelector('[data-pw]').value = created.password;
          m.querySelector('[data-result]').hidden = false;
          m.querySelector('[data-create]').hidden = true;
          name.disabled = true;
          m.querySelector('.form-error').textContent = '';
          m.querySelector('[data-pw]').select();
        } catch (err) { m.querySelector('.form-error').textContent = err.message; }
      };
      m.querySelector('[data-create]').addEventListener('click', go);
      name.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      m.querySelector('[data-copy-pw]').addEventListener('click', async () => {
        const input = m.querySelector('[data-pw]');
        try { await navigator.clipboard.writeText(input.value); toast(t('Copied'), { type: 'success', ms: 1500 }); } catch { input.select(); document.execCommand('copy'); toast(t('Copied'), { ms: 1500 }); }
      });
      setTimeout(() => name.focus(), 50);
    });
    if (created) draw(box);
  });
}
