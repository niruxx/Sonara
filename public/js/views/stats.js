// "Your stats": listening totals, top artists/albums/songs/genres, and when you listen.
import { api } from '../api.js';
import { html, ic, el, art, plural } from '../util.js';
import { player } from '../player.js';
import { trackList, emptyState } from '../components.js';

const PERIODS = [['week', 'Last 7 days'], ['month', 'Last 30 days'], ['year', 'Last 12 months'], ['all', 'All time']];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const fmtMinutes = (min) => {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return h >= 100 ? `${h.toLocaleString()} hr` : `${h} hr ${min % 60} min`;
};

/**
 * Single-series bar chart (one accent hue, so no legend), with a hover tooltip
 * per bar and a hidden data table for screen readers.
 * items: [{ label, value, tip }]
 */
function barChart(title, items, { unit = 'min', every = 1 } = {}) {
  const max = Math.max(1, ...items.map((d) => d.value));
  return html`<figure class="bars-chart">
    <figcaption>${title}</figcaption>
    <div class="bars" role="img" aria-label="${title}">
      ${items.map((d, i) => html`<div class="bar-col" tabindex="0" data-tip="${d.tip || `${d.label}: ${d.value.toLocaleString()} ${unit}`}">
        <div class="bar" style="height:${d.value ? Math.max(2, (d.value / max) * 100) : 0}%"></div>
        <span class="bar-label">${i % every === 0 ? d.label : ''}</span>
      </div>`)}
    </div>
    <table class="sr-only"><caption>${title}</caption><tbody>${items.map((d) => html`<tr><th>${d.label}</th><td>${d.value} ${unit}</td></tr>`)}</tbody></table>
  </figure>`;
}

function rankList(items, kind) {
  const max = Math.max(1, ...items.map((x) => x.plays));
  return html`<ol class="rank">${items.map((x, i) => html`<li>
    <span class="rank-n">${i + 1}</span>
    <a class="rank-art ${kind === 'artist' ? 'round' : ''}" href="/${kind}/${x.id}">${art(x.cover, x.name, kind === 'artist' ? 'artist' : 'disc', 96)}</a>
    <div class="rank-main"><a href="/${kind}/${x.id}" class="rank-name">${x.name}</a>
      ${x.artist ? html`<a class="muted rank-sub" href="/artist/${x.artistId}">${x.artist}</a>` : ''}
      <div class="rank-bar"><i style="width:${(x.plays / max) * 100}%"></i></div></div>
    <span class="muted rank-plays">${plural(x.plays, 'play')}</span>
  </li>`)}</ol>`;
}

export async function statsView({ query }) {
  const period = query.get('period') || 'month';
  const s = await api.get('/stats/listening', { period });
  const v = el(html`<div>
    <h1 class="page-title">Your stats</h1>
    <p class="page-sub">What you've been listening to${/^\d{4}$/.test(period) ? ` in ${period}` : ''}.</p>
    <div class="toolbar"><div class="chips">
      ${PERIODS.map(([k, l]) => html`<a class="chip ${k === period ? 'active' : ''}" href="/stats?period=${k}">${l}</a>`)}
      ${s.years.map((y) => html`<a class="chip ${String(y) === period ? 'active' : ''}" href="/stats?period=${y}">${y} in review</a>`)}
    </div></div>
    <div class="stats-body"></div>
  </div>`);
  const body = v.querySelector('.stats-body');
  if (!s.totals.plays) {
    body.replaceWith(el(emptyState('chart', 'Nothing here yet', 'Play some music and your listening stats will show up here.')));
    return v;
  }
  const t = s.totals;
  const minutes = Math.round(t.seconds / 60);
  const timeline = s.timeline.map((d) => {
    const [y, m, day] = d.bucket.split('-').map(Number);
    const label = s.daily ? `${MONTHS[m - 1]} ${day}` : `${MONTHS[m - 1]} ’${String(y).slice(2)}`;
    return { label, value: d.minutes, tip: `${s.daily ? `${MONTHS[m - 1]} ${day}, ${y}` : `${MONTHS[m - 1]} ${y}`}: ${fmtMinutes(d.minutes)}, ${plural(d.plays, 'play')}` };
  });
  const peakHour = s.byHour.indexOf(Math.max(...s.byHour));
  const hourLabel = (h) => new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' });
  body.innerHTML = String(html`
    <div class="stat-tiles">
      <div class="stat-tile"><b>${fmtMinutes(minutes)}</b><span>listening time</span></div>
      <div class="stat-tile"><b>${t.plays.toLocaleString()}</b><span>plays</span></div>
      <div class="stat-tile"><b>${t.tracks.toLocaleString()}</b><span>different songs</span></div>
      <div class="stat-tile"><b>${t.artists.toLocaleString()}</b><span>artists</span></div>
      <div class="stat-tile"><b>${hourLabel(peakHour)}</b><span>your favorite hour</span></div>
    </div>

    <div class="stats-grid">
      <section class="panel"><h3>${ic('mic')} Top artists</h3>${rankList(s.topArtists, 'artist')}</section>
      <section class="panel"><h3>${ic('disc')} Top albums</h3>${rankList(s.topAlbums, 'album')}</section>
    </div>

    <section class="section"><div class="section-head"><h2>Top songs</h2><button class="btn sm" data-play-top>${ic('play')} Play these</button></div><div class="top-songs"></div></section>

    ${timeline.length > 1 ? html`<section class="panel chart-panel">${barChart(s.daily ? 'Minutes listened per day' : 'Minutes listened per month', timeline, { every: Math.ceil(timeline.length / 12) })}</section>` : ''}
    <div class="stats-grid">
      <section class="panel chart-panel">${barChart('When you listen (minutes by hour)', s.byHour.map((m, h) => ({ label: h % 3 === 0 ? hourLabel(h) : '', value: m, tip: `${hourLabel(h)}: ${fmtMinutes(m)}` })))}</section>
      <section class="panel chart-panel">${barChart('Minutes by day of the week', [1, 2, 3, 4, 5, 6, 0].map((d) => ({ label: WEEKDAYS[d], value: s.byWeekday[d], tip: `${WEEKDAYS[d]}: ${fmtMinutes(s.byWeekday[d])}` })))}</section>
    </div>

    ${s.topGenres.length ? html`<section class="panel"><h3>${ic('tag')} Top genres</h3>
      <div class="genre-pills">${s.topGenres.map((g) => html`<a class="chip" href="/genre/${encodeURIComponent(g.name)}">${g.name} <span class="muted">${g.plays}</span></a>`)}</div></section>` : ''}
  `);
  body.querySelector('.top-songs').replaceWith(trackList(s.topTracks, { head: false }).el);
  body.querySelector('[data-play-top]').addEventListener('click', () => player.playList(s.topTracks, 0));

  // Hover/focus tooltip for bars.
  const tip = el('<div class="chart-tip" role="tooltip" hidden></div>');
  v.append(tip);
  const show = (e) => {
    const col = e.target.closest('.bar-col');
    if (!col) { tip.hidden = true; return; }
    tip.textContent = col.dataset.tip;
    tip.hidden = false;
    const r = col.getBoundingClientRect();
    tip.style.left = `${r.left + r.width / 2}px`;
    tip.style.top = `${r.top - 8}px`;
  };
  v.addEventListener('pointerover', show);
  v.addEventListener('focusin', show);
  v.addEventListener('pointerleave', () => { tip.hidden = true; });
  v.addEventListener('focusout', () => { tip.hidden = true; });
  return v;
}
