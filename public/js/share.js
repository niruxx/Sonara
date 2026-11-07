// Public share page (/s/:id): a small standalone player, no account needed.
const id = location.pathname.split('/')[2] || '';
const root = document.querySelector('.sh');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (s) => { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const base = `/api/public/shares/${encodeURIComponent(id)}`;
const probe = new Audio();
const codec = probe.canPlayType('audio/ogg; codecs="opus"') ? 'opus' : probe.canPlayType('audio/aac') ? 'aac' : 'mp3';

async function start() {
  let s;
  try {
    const r = await fetch(base);
    s = await r.json();
    if (!r.ok) throw new Error(s.error);
  } catch (err) {
    root.innerHTML = `<div class="sh-card"><h1>Link unavailable</h1><p>${esc(err.message || 'This link has expired or was removed.')}</p></div>`;
    return;
  }
  document.title = `${s.title} · Sonara`;
  const cover = (c) => (c ? `${base}/cover/${c}` : '');
  root.innerHTML = `
    <div class="sh-bg" style="${s.cover ? `background-image:url('${cover(s.cover)}')` : ''}"></div>
    <div class="sh-card">
      <div class="sh-head">
        <div class="sh-art">${s.cover ? `<img src="${cover(s.cover)}" alt="">` : '<div class="sh-ph">♪</div>'}</div>
        <div>
          <div class="sh-eyebrow">${esc({ track: 'Song', album: 'Album', playlist: 'Playlist' }[s.kind])} · shared by ${esc(s.sharedBy)}</div>
          <h1>${esc(s.title)}</h1>
          ${s.description ? `<p>${esc(s.description)}</p>` : ''}
          <div class="sh-actions">
            <button class="sh-play" data-play aria-label="Play">▶</button>
            ${s.allowDownload ? `<a class="sh-btn" href="${base}/download">Download${s.tracks.length > 1 ? ' (.zip)' : ''}</a>` : ''}
          </div>
        </div>
      </div>
      <div class="sh-bar" hidden>
        <span data-now></span>
        <div class="sh-progress"><span data-cur>0:00</span><input type="range" min="0" max="1000" value="0" data-seek aria-label="Seek"><span data-dur>0:00</span></div>
      </div>
      <ol class="sh-tracks">${s.tracks.map((t, i) => `<li data-i="${i}"><span class="n">${i + 1}</span><span class="t"><b>${esc(t.title)}</b><small>${esc(t.artist)}${s.kind === 'playlist' ? ` · ${esc(t.album)}` : ''}</small></span><span class="d">${fmt(t.duration)}</span></li>`).join('')}</ol>
      ${s.expiresAt ? `<p class="sh-foot">This link works until ${new Date(s.expiresAt).toLocaleString()}.</p>` : ''}
      <p class="sh-foot">Shared with <a href="/">Sonara</a></p>
    </div>`;
  const audio = new Audio();
  let cur = -1;
  const playBtn = root.querySelector('[data-play]');
  const bar = root.querySelector('.sh-bar');
  const seek = root.querySelector('[data-seek]');
  const play = (i) => {
    cur = i;
    const t = s.tracks[i];
    audio.src = `${base}/stream/${t.id}?codec=${codec}`;
    audio.play().catch(() => {});
    bar.hidden = false;
    root.querySelector('[data-now]').textContent = `${t.title} · ${t.artist}`;
    root.querySelectorAll('.sh-tracks li').forEach((li) => li.classList.toggle('on', Number(li.dataset.i) === i));
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: t.album, artwork: t.cover ? [{ src: new URL(cover(t.cover), location.href).href }] : [] });
  };
  playBtn.addEventListener('click', () => (cur < 0 ? play(0) : audio.paused ? audio.play() : audio.pause()));
  root.querySelector('.sh-tracks').addEventListener('click', (e) => { const li = e.target.closest('li'); if (li) play(Number(li.dataset.i)); });
  audio.addEventListener('play', () => { playBtn.textContent = '❚❚'; });
  audio.addEventListener('pause', () => { playBtn.textContent = '▶'; });
  audio.addEventListener('ended', () => { if (cur < s.tracks.length - 1) play(cur + 1); });
  audio.addEventListener('timeupdate', () => {
    const d = Number.isFinite(audio.duration) ? audio.duration : s.tracks[cur]?.duration || 0;
    root.querySelector('[data-cur]').textContent = fmt(audio.currentTime);
    root.querySelector('[data-dur]').textContent = fmt(d);
    if (d) { seek.value = String(Math.round((audio.currentTime / d) * 1000)); seek.style.setProperty('--pct', `${(audio.currentTime / d) * 100}%`); }
  });
  seek.addEventListener('change', () => {
    const d = Number.isFinite(audio.duration) ? audio.duration : s.tracks[cur]?.duration || 0;
    audio.currentTime = (seek.value / 1000) * d;
  });
}
start();
