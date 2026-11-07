// Wake-up alarm: at a set time, start a playlist, mix, station or the library
// on shuffle, fading the volume in. Runs in this browser tab (keep it open).
import { api } from './api.js';
import { html, ic, prefs } from './util.js';
import { player } from './player.js';
import { state } from './state.js';
import { toast, modal } from './ui.js';
import { stationItem } from './media.js';
import { t } from './i18n.js';

const DAYS = [1, 2, 3, 4, 5, 6, 0];
const dayName = (d) => new Date(2024, 0, 7 + d).toLocaleDateString(document.documentElement.lang, { weekday: 'short' });

export const alarms = () => prefs.get('alarms', []);
const saveAlarms = (list) => { prefs.set('alarms', list); schedule(); };

async function tracksFor(src) {
  if (src.type === 'playlist') return (await api.get(`/playlists/${src.id}`)).tracks;
  if (src.type === 'smart') return (await api.get(`/smart-playlists/${src.id}`)).tracks;
  if (src.type === 'mix') return api.get(`/mixes/${src.id}`);
  if (src.type === 'station') {
    const { stations } = await api.get('/stations');
    const s = stations.find((x) => x.id === Number(src.id));
    return s ? [stationItem(s)] : [];
  }
  return api.get('/tracks/random', { limit: 200 });
}

let fadeTimer = null;
async function ring(a) {
  const list = await tracksFor(a.source).catch(() => []);
  if (!list.length) return toast(t('Alarm: nothing to play from {name}', { name: a.source.name }), { type: 'error' });
  const target = Math.min(1, Math.max(0.05, a.volume ?? 0.6));
  player.setVolume(0);
  player.playList(list, 0, { shuffle: a.source.type !== 'station' });
  toast(t('Good morning! Alarm: {name}', { name: a.source.name }), { type: 'success', ms: 6000 });
  // Fade in over a few minutes.
  clearInterval(fadeTimer);
  const start = Date.now();
  const ms = Math.max(1, a.fade ?? 3) * 60000;
  fadeTimer = setInterval(() => {
    const p = Math.min(1, (Date.now() - start) / ms);
    player.setVolume(target * p);
    if (p >= 1) clearInterval(fadeTimer);
  }, 1000);
  // A browser may refuse to start audio in a tab nobody touched; tell the user.
  setTimeout(() => { if (!player.playing) toast(t('The browser blocked the alarm sound. Click anywhere in Sonara once after opening it so alarms can play.'), { type: 'error', ms: 10000 }); }, 4000);
}

let timer = null;
function schedule() {
  clearInterval(timer);
  if (!alarms().some((a) => a.on)) return;
  timer = setInterval(check, 15000);
  check();
}

function check() {
  const now = new Date();
  const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const today = now.toDateString();
  let changed = false;
  const list = alarms().map((a) => {
    if (!a.on || a.time !== hm || a.lastRang === today) return a;
    if (a.days?.length && !a.days.includes(now.getDay())) return a;
    changed = true;
    ring(a);
    // One-off alarms switch themselves off after ringing.
    return { ...a, lastRang: today, on: a.days?.length ? a.on : false };
  });
  if (changed) prefs.set('alarms', list);
}

export function startAlarms() { schedule(); }

/** Next ring as a Date, or null. */
export function nextAlarm() {
  let best = null;
  const now = new Date();
  for (const a of alarms().filter((x) => x.on)) {
    const [h, m] = a.time.split(':').map(Number);
    for (let d = 0; d < 8; d++) {
      const when = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d, h, m);
      if (when <= now || (a.days?.length && !a.days.includes(when.getDay()))) continue;
      if (!best || when < best) best = when;
      break;
    }
  }
  return best;
}

export async function alarmDialog() {
  const [playlists, mixes, stations] = await Promise.all([
    Promise.resolve(state.playlists || []), api.get('/mixes').catch(() => []), api.get('/stations').then((r) => r.stations).catch(() => []),
  ]);
  const sources = [
    { type: 'library', id: '', name: t('Whole library (shuffle)') },
    ...mixes.map((m) => ({ type: 'mix', id: m.id, name: t(m.name) })),
    ...playlists.map((p) => ({ type: 'playlist', id: p.id, name: p.name })),
    ...(state.smartPlaylists || []).map((p) => ({ type: 'smart', id: p.id, name: p.name })),
    ...stations.map((s) => ({ type: 'station', id: s.id, name: s.name })),
  ];
  return modal(html`<h3>${ic('clock')} ${t('Wake-up alarm')}</h3>
    <p>${t('Starts playing at the time you choose and fades in. Keep this tab open (and the computer awake).')}</p>
    <div data-list></div>
    <form class="alarm-form" data-form>
      <div class="row-gap">
        <input class="input sm" type="time" name="time" required value="07:30" aria-label="${t('Time')}" style="width:120px">
        <select class="input sm" name="source" aria-label="${t('Play')}">${sources.map((s, i) => html`<option value="${i}">${s.name}</option>`)}</select>
      </div>
      <div class="chips fit" role="group" aria-label="${t('Repeat on')}">${DAYS.map((d) => html`<button type="button" class="chip" data-day="${d}" aria-pressed="false">${dayName(d)}</button>`)}</div>
      <div class="row-gap">
        <label class="muted">${t('Fade in over')} <input class="input sm" type="number" name="fade" min="0" max="30" value="3" style="width:70px"> ${t('minutes, up to')}</label>
        <input class="range" type="range" name="volume" min="10" max="100" value="60" style="width:140px;--pct:60%" aria-label="${t('Alarm volume')}">
      </div>
      <button class="btn sm primary" type="submit">${ic('plus')} ${t('Add alarm')}</button>
    </form>
    <div class="modal-actions"><button class="btn ghost" data-close>${t('Done')}</button></div>`, (box) => {
    const list = box.querySelector('[data-list]');
    const draw = () => {
      const next = nextAlarm();
      list.innerHTML = alarms().length ? String(html`${alarms().map((a) => html`<div class="list-row">
        <label class="check" style="margin:0"><input type="checkbox" data-on="${a.id}" ${a.on ? 'checked' : ''}><span class="sw"></span></label>
        <b class="mono" style="font-size:16px">${a.time}</b>
        <span class="grow">${a.source.name}<br><span class="muted">${a.days?.length ? a.days.map(dayName).join(' ') : t('Once')}</span></span>
        <button class="icon-btn sm" data-del="${a.id}" aria-label="${t('Delete alarm')}">${ic('trash')}</button></div>`)}
        ${next ? html`<p class="muted">${t('Next alarm: {when}', { when: next.toLocaleString(document.documentElement.lang, { weekday: 'long', hour: '2-digit', minute: '2-digit' }) })}</p>` : ''}`) : '';
    };
    draw();
    list.addEventListener('change', (e) => {
      const c = e.target.closest('[data-on]');
      if (c) { saveAlarms(alarms().map((a) => (a.id === c.dataset.on ? { ...a, on: c.checked, lastRang: null } : a))); draw(); }
    });
    list.addEventListener('click', (e) => {
      const d = e.target.closest('[data-del]');
      if (d) { saveAlarms(alarms().filter((a) => a.id !== d.dataset.del)); draw(); }
    });
    const form = box.querySelector('[data-form]');
    form.querySelectorAll('[data-day]').forEach((c) => c.addEventListener('click', () => { c.classList.toggle('active'); c.setAttribute('aria-pressed', String(c.classList.contains('active'))); }));
    const vol = form.querySelector('[name=volume]');
    vol.addEventListener('input', () => vol.style.setProperty('--pct', `${(vol.value - 10) / 0.9}%`));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = new FormData(form);
      const days = [...form.querySelectorAll('[data-day].active')].map((c) => Number(c.dataset.day));
      saveAlarms([...alarms(), { id: Math.random().toString(36).slice(2, 8), on: true, time: f.get('time'), days, source: sources[Number(f.get('source'))], fade: Number(f.get('fade')) || 0, volume: Number(f.get('volume')) / 100 }]);
      draw();
      toast(t('Alarm set for {time}', { time: f.get('time') }), { type: 'success' });
    });
  });
}

/** Short label for the next alarm, e.g. "Alarm 07:30", or null. */
export const alarmLabel = () => { const n = nextAlarm(); return n ? t('Alarm {time}', { time: n.toLocaleTimeString(document.documentElement.lang, { hour: '2-digit', minute: '2-digit' }) }) : null; };
