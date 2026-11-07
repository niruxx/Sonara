// Mini player: a small always-on-top window with cover, title and controls.
// Uses Document Picture-in-Picture (Chrome, Edge) and falls back to a video
// picture-in-picture of the cover art, controlled with media keys / the PiP
// buttons (Firefox, Safari).
import { player } from './player.js';
import { html, ic, art, fmtTime, coverUrl } from './util.js';
import { toast } from './ui.js';

let win = null;      // Document PiP window
let video = null;    // fallback <video>
let off = [];

export const miniSupported = () => 'documentPictureInPicture' in window || (document.pictureInPictureEnabled && !!HTMLCanvasElement.prototype.captureStream);
export const miniOpen = () => !!win || !!document.pictureInPictureElement;

export async function toggleMiniPlayer() {
  if (win) { win.close(); return; }
  if (document.pictureInPictureElement) { await document.exitPictureInPicture().catch(() => {}); return; }
  if (!player.current) return toast('Play something first');
  if ('documentPictureInPicture' in window) return openDocPip();
  if (document.pictureInPictureEnabled) return openVideoPip();
  toast("This browser doesn't support a mini player window", { type: 'error' });
}

function listen(ev, fn) { off.push(player.on(ev, fn)); }
function cleanup() { off.forEach((f) => f()); off = []; document.body.classList.remove('mini-open'); }

async function openDocPip() {
  win = await window.documentPictureInPicture.requestWindow({ width: 340, height: 420 });
  const d = win.document;
  // Bring the app's styles and current accent colours into the window.
  for (const l of document.querySelectorAll('link[rel=stylesheet]')) d.head.append(Object.assign(d.createElement('link'), { rel: 'stylesheet', href: l.href }));
  const root = document.documentElement;
  for (const v of ['--c1', '--c2', '--c3']) d.documentElement.style.setProperty(v, root.style.getPropertyValue(v));
  d.body.className = `mini-body ${document.body.className}`;
  d.title = 'Sonara';
  d.body.innerHTML = String(html`<div class="mini">
    <div class="mini-art"></div>
    <div class="mini-meta"><div class="mini-title"></div><div class="mini-artist"></div></div>
    <input class="range" type="range" min="0" max="1000" value="0" data-seek aria-label="Seek">
    <div class="mini-time"><span data-cur>0:00</span><span data-dur>0:00</span></div>
    <div class="mini-controls">
      <button class="icon-btn" data-prev aria-label="Previous">${ic('prev')}</button>
      <button class="pb-play" data-toggle aria-label="Play">${ic('play')}</button>
      <button class="icon-btn" data-next aria-label="Next">${ic('next')}</button>
    </div></div>`);
  const $ = (s) => d.querySelector(s);
  const drawTrack = (t) => {
    if (!t) return;
    $('.mini-art').innerHTML = String(art(t.cover, t.album, 'disc', 600));
    $('.mini-title').textContent = t.title;
    $('.mini-artist').textContent = [...new Set([t.artist, t.album].filter(Boolean))].join(' · ');
    for (const v of ['--c1', '--c2', '--c3']) d.documentElement.style.setProperty(v, root.style.getPropertyValue(v));
  };
  const drawState = (p) => { $('[data-toggle]').innerHTML = ic(p ? 'pause' : 'play'); d.body.classList.toggle('playing', p); };
  let dragging = false;
  const seek = $('[data-seek]');
  const drawTime = (t, dur) => {
    if (dragging) return;
    seek.value = String(dur ? Math.round((t / dur) * 1000) : 0);
    seek.style.setProperty('--pct', `${dur ? (t / dur) * 100 : 0}%`);
    $('[data-cur]').textContent = fmtTime(t);
    $('[data-dur]').textContent = fmtTime(dur);
  };
  seek.addEventListener('input', () => { dragging = true; });
  seek.addEventListener('change', () => { dragging = false; player.seek((seek.value / 1000) * player.duration); });
  $('[data-toggle]').addEventListener('click', () => player.toggle());
  $('[data-prev]').addEventListener('click', () => player.prev());
  $('[data-next]').addEventListener('click', () => player.next());
  d.addEventListener('keydown', (e) => {
    if (e.key === ' ') { e.preventDefault(); player.toggle(); }
    if (e.key === 'ArrowRight') player.next();
    if (e.key === 'ArrowLeft') player.prev();
  });
  drawTrack(player.current); drawState(player.playing); drawTime(player.time, player.duration);
  listen('track', (t) => setTimeout(() => drawTrack(t), 400)); // after the accent colours settle
  listen('state', drawState);
  listen('time', drawTime);
  document.body.classList.add('mini-open');
  win.addEventListener('pagehide', () => { win = null; cleanup(); });
}

async function openVideoPip() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 512;
  const ctx = canvas.getContext('2d');
  const img = new Image();
  const draw = () => {
    const t = player.current;
    ctx.fillStyle = '#0b0913';
    ctx.fillRect(0, 0, 512, 512);
    if (img.complete && img.naturalWidth) ctx.drawImage(img, 0, 0, 512, 512);
    const g = ctx.createLinearGradient(0, 300, 0, 512);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,.85)');
    ctx.fillStyle = g; ctx.fillRect(0, 300, 512, 212);
    ctx.fillStyle = '#fff'; ctx.font = '600 30px system-ui, sans-serif'; ctx.fillText(t?.title || '', 24, 450, 464);
    ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.font = '22px system-ui, sans-serif'; ctx.fillText(t?.artist || '', 24, 486, 464);
    const pct = player.duration ? player.time / player.duration : 0;
    ctx.fillStyle = 'rgba(255,255,255,.25)'; ctx.fillRect(0, 506, 512, 6);
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 506, 512 * pct, 6);
  };
  const load = (t) => { img.src = t?.cover ? coverUrl(t.cover) : ''; draw(); };
  img.onload = draw;
  load(player.current);
  video = document.createElement('video');
  video.muted = true;
  video.srcObject = canvas.captureStream(4);
  await video.play();
  listen('track', load);
  listen('time', draw);
  listen('state', (p) => { if (p) video.play().catch(() => {}); else video.pause(); });
  try {
    await video.requestPictureInPicture();
    if (!player.playing) video.pause();
    // The PiP window's play/pause buttons drive the music.
    video.addEventListener('pause', () => { if (document.pictureInPictureElement === video && player.playing) player.pause(); });
    video.addEventListener('play', () => { if (document.pictureInPictureElement === video && !player.playing) player.play(); });
    document.body.classList.add('mini-open');
    video.addEventListener('leavepictureinpicture', () => { cleanup(); video.srcObject = null; video = null; }, { once: true });
  } catch (err) {
    cleanup();
    toast(err.message, { type: 'error' });
  }
}
