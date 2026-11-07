// Settings panels for audio analysis, Snapcast / MQTT (admins) and webhooks (everyone).
import { api } from '../api.js';
import { html, ic } from '../util.js';
import { toast, toastError, formDialog, confirmDialog } from '../ui.js';
import { analyseInBrowser } from '../analysis.js';
import { copyText } from '../components.js';
import { t } from '../i18n.js';

export const analysisPanel = (settings) => html`
  <section class="panel" style="--i:4" data-panel="analysis">
    <h3>${ic('waves')} ${t('Audio analysis')}</h3>
    <p>${t('Measures every song for the waveform seek bar, loudness levelling of untagged files, tempo, key, “Sounds like this” and the mood mixes.')}</p>
    <div data-an-status class="muted">…</div>
    <div class="progress" style="--p:0%" data-an-bar><i></i></div>
    ${settings ? html`<label class="check"><input type="checkbox" data-an-server ${settings.analysis ? 'checked' : ''}><span class="sw"></span>${t('Analyse the library on the server in the background (needs ffmpeg)')}</label>` : ''}
    <div class="row-gap" style="margin-top:10px"><button class="btn sm" data-an-browser>${ic('waves')} ${t('Analyse in this browser now')}</button><span class="muted" data-an-browser-status></span></div>
  </section>`;

export const integrationsPanel = (s) => html`
  <section class="panel" style="--i:4" data-panel="integrations">
    <h3>${ic('speaker')} ${t('Multi-room and home automation')}</h3>
    <p>${t('Play in sync in every room with Snapcast, and let Home Assistant see and control playback over MQTT.')}</p>
    <label class="check"><input type="checkbox" data-int="snapcast" ${s.snapcast ? 'checked' : ''}><span class="sw"></span>${t('Snapcast (appears as “All rooms” in the devices menu; needs ffmpeg)')}</label>
    <div class="org-grid">
      <label class="muted">${t('Snapcast server')}</label>
      <div class="row-gap"><input class="input sm" data-int-text="snapcastHost" value="${s.snapcastHost}" style="width:160px" aria-label="${t('Snapcast server')}"><input class="input sm" type="number" data-int-text="snapcastPort" value="${s.snapcastPort}" style="width:90px" aria-label="${t('TCP source port')}"></div>
      <label class="muted">MQTT</label>
      <input class="input sm mono" data-int-text="mqttUrl" value="${s.mqttUrl}" placeholder="mqtt://user:password@homeassistant.local:1883" autocomplete="off" spellcheck="false">
      <label class="muted">${t('Topic prefix')}</label>
      <input class="input sm mono" data-int-text="mqttPrefix" value="${s.mqttPrefix}" style="width:160px">
    </div>
    <p class="muted" style="font-size:12px">${s.snapcast ? (s.snapcastStatus?.ready ? t('Snapcast: ready.') : t('Snapcast: not running (is ffmpeg installed?).')) : ''}
      ${s.mqttUrl ? (s.mqttStatus?.connected ? t('MQTT: connected.') : t('MQTT: not connected yet.')) : ''}
      ${t('In snapserver.conf add: source = tcp://0.0.0.0:4953?name=Sonara&mode=server. Home Assistant finds Sonara automatically (MQTT discovery) for people who share their listening activity.')}</p>
    ${s.snapcast ? html`<button class="btn sm ghost" data-rooms>${ic('speaker')} ${t('Show rooms')}</button><div data-rooms-list></div>` : ''}
  </section>`;

export const webhooksPanel = () => html`
  <section class="panel" style="--i:6" data-panel="webhooks">
    <h3>${ic('link')} ${t('Webhooks')}</h3>
    <p>${t('Sonara sends a POST request to your address when a song starts, pauses or resumes. Each request is signed (X-Sonara-Signature: sha256 HMAC of the body with the secret).')}</p>
    <div data-hooks></div>
    <button class="btn sm" data-hook-add>${ic('plus')} ${t('Add webhook')}</button>
  </section>`;

export function bindStage8(v) {
  // ── Analysis
  const an = v.querySelector('[data-panel="analysis"]');
  if (an) {
    const draw = async () => {
      const s = await api.get('/analysis/status').catch(() => null);
      if (!s || !an.isConnected) return;
      const pct = s.total ? Math.round((s.analyzed / s.total) * 100) : 0;
      an.querySelector('[data-an-bar]').style.setProperty('--p', `${pct}%`);
      an.querySelector('[data-an-status]').textContent = `${t('{done} of {total} songs analysed ({pct}%)', { done: s.analyzed, total: s.total, pct })}${s.failed ? ` · ${t('{n} could not be read', { n: s.failed })}` : ''} · ${s.ffmpeg ? (s.running ? t('the server is working on it') : t('ffmpeg found')) : t('no ffmpeg on the server: songs are analysed in the browser as they play')}`;
    };
    draw();
    const timer = setInterval(() => (an.isConnected ? draw() : clearInterval(timer)), 5000);
    an.querySelector('[data-an-server]')?.addEventListener('change', async (e) => {
      try { await api.put('/admin/settings', { analysis: e.target.checked }); toast(t('Saved'), { type: 'success', ms: 1200 }); draw(); } catch (err) { toastError(err); }
    });
    let stop = false;
    an.querySelector('[data-an-browser]').addEventListener('click', async (e) => {
      const b = e.currentTarget;
      const st = an.querySelector('[data-an-browser-status]');
      if (b.dataset.running) { stop = true; return; }
      b.dataset.running = '1';
      stop = false;
      b.textContent = t('Stop');
      let done = 0;
      try {
        for (;;) {
          const batch = await api.get('/analysis/pending', { limit: 20 });
          if (!batch.length || stop) break;
          let progressed = false;
          for (const tr of batch) {
            if (stop || !an.isConnected) break;
            st.textContent = t('Analysing… {n} done', { n: done });
            if (await analyseInBrowser({ id: tr.id, duration: tr.duration, title: `#${tr.id}` })) { done++; progressed = true; }
          }
          if (!progressed) break; // nothing more this browser can do (long files, unsupported formats)
          draw();
        }
      } finally {
        delete b.dataset.running;
        b.innerHTML = String(html`${ic('waves')} ${t('Analyse in this browser now')}`);
        st.textContent = t('{n} songs analysed', { n: done });
        draw();
      }
    });
  }

  // ── Snapcast and MQTT
  const int = v.querySelector('[data-panel="integrations"]');
  if (int) {
    int.querySelectorAll('[data-int]').forEach((c) => c.addEventListener('change', async () => {
      try { await api.put('/admin/settings', { [c.dataset.int]: c.checked }); toast(t('Saved'), { type: 'success', ms: 1200 }); } catch (err) { toastError(err); }
    }));
    int.querySelectorAll('[data-int-text]').forEach((i) => i.addEventListener('change', async () => {
      try { await api.put('/admin/settings', { [i.dataset.intText]: i.value }); toast(t('Saved'), { type: 'success', ms: 1200 }); } catch (err) { toastError(err); }
    }));
    int.querySelector('[data-rooms]')?.addEventListener('click', async () => {
      const box = int.querySelector('[data-rooms-list]');
      const r = await api.get('/admin/snapcast/rooms').catch(() => ({ rooms: null }));
      box.innerHTML = r.rooms ? String(html`${r.rooms.map((x) => html`<div class="list-row">${ic('speaker')}<span class="grow">${x.name}</span><span class="muted">${x.connected ? `${x.volume ?? '?'}%` : t('offline')}</span></div>`)}`)
        : String(html`<p class="muted">${t('Could not reach the Snapcast control port (1705).')}</p>`);
    });
  }

  // ── Webhooks
  const wh = v.querySelector('[data-panel="webhooks"]');
  if (wh) {
    const list = wh.querySelector('[data-hooks]');
    const draw = async () => {
      const hooks = await api.get('/me/webhooks').catch(() => []);
      list.innerHTML = String(html`${hooks.map((h) => html`<div class="list-row">${ic('link')}
        <span class="grow"><span class="mono">${h.url}</span><br><span class="muted">${h.events.join(', ')}${h.lastAt ? ` · ${t('last answer {status}', { status: h.lastStatus || t('none') })}` : ''}</span></span>
        <button class="btn sm ghost" data-hook-secret="${h.secret}">${t('Copy secret')}</button>
        <button class="btn sm ghost" data-hook-test="${h.id}">${t('Test')}</button>
        <button class="icon-btn sm" data-hook-del="${h.id}" aria-label="${t('Delete webhook')}">${ic('trash')}</button></div>`)}`);
    };
    draw();
    list.addEventListener('click', async (e) => {
      const s = e.target.closest('[data-hook-secret]');
      if (s) return copyText(s.dataset.hookSecret);
      const tst = e.target.closest('[data-hook-test]');
      if (tst) {
        const r = await api.post(`/me/webhooks/${tst.dataset.hookTest}/test`).catch((err) => ({ error: err.message }));
        toast(r.status ? t('Your server answered {status}', { status: r.status }) : t('No answer from that address'), { type: r.status >= 200 && r.status < 300 ? 'success' : 'error' });
        return draw();
      }
      const d = e.target.closest('[data-hook-del]');
      if (d && await confirmDialog({ title: t('Delete this webhook?'), message: '', confirm: t('Delete'), danger: true })) { await api.del(`/me/webhooks/${d.dataset.hookDel}`); draw(); }
    });
    wh.querySelector('[data-hook-add]').addEventListener('click', async () => {
      const val = await formDialog({
        title: t('Add a webhook'), fields: [{ name: 'url', label: t('Address (https://…)'), type: 'url' }], confirm: t('Add'),
        validate: async (x) => { try { await api.post('/me/webhooks', { url: x.url }); return null; } catch (err) { return err.message; } },
      });
      if (val) draw();
    });
  }
}
