// Listening party invitation page: /party/:id
import { api } from '../api.js';
import { html, ic, el, art } from '../util.js';
import { emptyState } from '../components.js';
import { connect, joinParty, clientId } from '../connect.js';
import { navigate } from '../router.js';

export async function partyView({ params }) {
  let p;
  try { p = await api.get(`/party/${params.id}`); } catch (err) {
    return el(html`<div>${emptyState('party', 'This listening party has ended', err.message, html`<a class="btn primary" href="/">Go home</a>`)}</div>`);
  }
  const t = p.state?.track;
  const mine = p.hostClient === clientId;
  const joined = connect.party?.id === p.id;
  const v = el(html`<div class="party-page">
    <div class="party-card">
      <div class="party-art">${art(t?.cover, t?.album || '', 'disc', 400)}</div>
      <div class="eyebrow">${ic('party')} Listening party</div>
      <h1 class="hero-title" style="font-size:clamp(28px,4vw,44px)">${mine ? 'Your listening party' : `${p.host} invites you to listen along`}</h1>
      <p class="muted">${t ? html`${p.state.playing ? 'Now playing' : 'Paused on'} <b>${t.title}</b> · ${t.artist}` : 'Nothing is playing yet.'}</p>
      <p class="muted">${p.members.length ? `${p.members.map((m) => m.username).join(', ')} ${p.members.length === 1 ? 'is' : 'are'} listening.` : 'Nobody has joined yet.'}</p>
      <p class="muted" style="font-size:13px">Everyone hears the same song at the same moment. The host controls the music, and songs play from this server, so you need an account here.</p>
      <div class="row-gap" style="justify-content:center;margin-top:18px">
        ${mine || joined ? html`<a class="btn primary" href="/">${ic('check')} ${mine ? "You're the host" : "You're in"}</a>`
          : html`<button class="btn primary" data-join>${ic('party')} Join and listen</button>`}
      </div>
    </div>
  </div>`);
  v.querySelector('[data-join]')?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    await joinParty(p.id);
    navigate('/');
  });
  return v;
}
