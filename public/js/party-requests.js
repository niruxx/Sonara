// Song requests in listening parties: guests suggest songs and vote; the host
// sees the list (most votes first) and plays them next or declines them.
import { api } from './api.js';
import { html, ic, art, fmtTime } from './util.js';
import { player } from './player.js';
import { state } from './state.js';
import { connect, clientId } from './connect.js';
import { modal, toast, toastError } from './ui.js';
import { t } from './i18n.js';

export async function requestInParty(track) {
  const p = connect.party;
  if (!p) return;
  try {
    await api.post(`/party/${p.id}/requests`, { trackId: track.id });
    toast(t('Requested “{title}”', { title: track.title }), { type: 'success' });
  } catch (err) { toastError(err); }
}

export function requestsDialog() {
  return modal(html`<h3>${ic('party')} ${t('Song requests')}</h3>
    <p data-hint></p><div class="req-list" data-list aria-live="polite"></div>
    <div class="modal-actions"><button class="btn primary" data-close>${t('Done')}</button></div>`, (box) => {
    const list = box.querySelector('[data-list]');
    const draw = () => {
      const p = connect.party;
      if (!p) { list.innerHTML = String(html`<p class="muted">${t('The party has ended.')}</p>`); return; }
      const host = p.hostClient === clientId;
      box.querySelector('[data-hint]').textContent = host ? t('Your guests’ requests, most votes first. Play one next or decline it.') : t('Vote for songs you want to hear. Request more from any song’s menu.');
      const me = state.user.username;
      list.innerHTML = p.requests?.length ? String(html`${p.requests.map((r) => html`<div class="list-row req">
        <div class="tl-cover">${art(r.track.cover, r.track.album, 'disc', 80)}</div>
        <span class="grow"><b>${r.track.title}</b><br><span class="muted">${r.track.artist} · ${fmtTime(r.track.duration)} · ${t('asked by {name}', { name: r.by })}</span></span>
        <button class="btn sm ${r.voters.includes(me) ? 'primary' : ''}" data-vote="${r.id}" aria-pressed="${r.voters.includes(me)}" title="${r.voters.join(', ')}">${ic('arrowUp')} ${r.votes}</button>
        ${host ? html`<button class="btn sm" data-play="${r.id}">${ic('playNext')} ${t('Play next')}</button>` : ''}
        ${host || r.by === me ? html`<button class="icon-btn sm" data-del="${r.id}" aria-label="${t('Remove request')}">${ic('x')}</button>` : ''}
      </div>`)}`) : String(html`<p class="muted">${t('No requests yet.')}</p>`);
    };
    draw();
    const off = connect.on('party', draw);
    const obs = new MutationObserver(() => { if (!box.isConnected) { off(); obs.disconnect(); } });
    obs.observe(document.getElementById('overlays'), { childList: true });
    list.addEventListener('click', async (e) => {
      const p = connect.party;
      if (!p) return;
      const b = e.target.closest('[data-vote], [data-play], [data-del]');
      if (!b) return;
      const r = p.requests.find((x) => x.id === (b.dataset.vote || b.dataset.play || b.dataset.del));
      if (!r) return;
      try {
        if (b.dataset.vote) {
          connect.party = await api.post(`/party/${p.id}/requests/${r.id}/vote`, { up: !r.voters.includes(state.user.username) });
        } else if (b.dataset.play) {
          const [track] = await api.post('/tracks/lookup', { ids: [r.track.id] });
          if (!track) throw new Error(t('That song isn’t in your library'));
          player.playNext([track]);
          connect.party = await api.del(`/party/${p.id}/requests/${r.id}`);
        } else {
          connect.party = await api.del(`/party/${p.id}/requests/${r.id}`);
        }
        connect.emit('party', connect.party);
      } catch (err) { toastError(err); }
    });
  });
}
