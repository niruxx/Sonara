// Equalizer editor: on/off, preset chips, a live response graph (with the music's spectrum
// behind it while something plays), a pre-amp and ten band faders.
import { html, ic, el, prefs } from './util.js';
import { player, eq, EQ_BANDS, EQ_PRESETS } from './player.js';
import { modal } from './ui.js';
import { soundEditor } from './sound.js';
import { t } from './i18n.js';

const MIN = -12, MAX = 12;
const fmtHz = (f) => (f >= 1000 ? `${f / 1000}k` : String(f));
const fmtDb = (v) => { const n = Math.round(v * 2) / 2; return `${n > 0 ? '+' : ''}${n.toFixed(n % 1 ? 1 : 0)}`; };
const clamp = (v) => Math.min(MAX, Math.max(MIN, v));
const snap = (v) => Math.round(clamp(v) * 2) / 2;
const reduced = () => document.body.classList.contains('reduce-motion');

const fader = (key, label, value, aria) => html`<div class="eqx-band ${key === 'pre' ? 'pre' : ''}" data-band="${key}">
  <span class="eqx-val">${fmtDb(value)}</span>
  <div class="eqx-fader" role="slider" tabindex="0" aria-label="${aria}" aria-orientation="vertical"
    aria-valuemin="${MIN}" aria-valuemax="${MAX}" aria-valuenow="${value}" aria-valuetext="${fmtDb(value)} dB">
    <div class="eqx-track"><i class="eqx-zero"></i><i class="eqx-fill"></i></div>
    <div class="eqx-thumb"><span class="eqx-bubble">${fmtDb(value)}</span></div>
  </div>
  <span class="eqx-hz">${label}</span>
</div>`;

/** Returns an element; changes apply to playback immediately. */
export function eqEditor() {
  const box = el(html`<div class="eqx ${eq.enabled ? '' : 'off'}">
    <div class="eqx-head">
      <label class="check"><input type="checkbox" data-eq-on ${eq.enabled ? 'checked' : ''}><span class="sw"></span>${t('Equalizer')}</label>
      <button class="btn sm ghost" data-reset>${ic('refresh')} ${t('Reset')}</button>
    </div>
    <div class="eqx-presets" role="group" aria-label="${t('Preset')}">
      ${Object.entries(EQ_PRESETS).map(([k, p]) => html`<button type="button" class="eqx-chip" data-preset="${k}" aria-pressed="false">${t(p.name)}</button>`)}
      <span class="eqx-chip custom" data-preset="custom" aria-hidden="true">${t('Custom')}</span>
    </div>
    <div class="eqx-graph"><canvas aria-hidden="true"></canvas></div>
    <div class="eqx-bands">
      ${fader('pre', t('Pre'), eq.preamp, t('Pre-amp'))}
      ${EQ_BANDS.map((f, i) => fader(i, fmtHz(f), eq.gains[i], `${fmtHz(f)} Hz`))}
    </div>
    <div class="eqx-foot">
      <label class="check"><input type="checkbox" data-headroom ${eq.autoHeadroom ? 'checked' : ''}><span class="sw"></span>${t('Prevent clipping when boosting')}</label>
    </div>
  </div>`);

  // What's on screen. Gains glide towards their targets when a preset is picked.
  const shown = { gains: eq.gains.slice(), pre: eq.preamp };
  const bands = [...box.querySelectorAll('.eqx-band')];
  const canvas = box.querySelector('canvas');
  const graph = createGraph(canvas, () => shown, () => hovered);
  let hovered = -1;

  const paint = (key, v) => {
    const b = bands[key === 'pre' ? 0 : key + 1];
    const pos = (MAX - v) / (MAX - MIN); // 0 = top
    b.style.setProperty('--pos', pos);
    b.style.setProperty('--fill-top', `${Math.min(pos, 0.5) * 100}%`);
    b.style.setProperty('--fill-h', `${Math.abs(pos - 0.5) * 100}%`);
    b.classList.toggle('cut', v < 0);
    b.classList.toggle('boost', v > 0);
    const txt = fmtDb(v);
    b.querySelector('.eqx-val').textContent = txt;
    b.querySelector('.eqx-bubble').textContent = txt;
    const f = b.querySelector('.eqx-fader');
    f.setAttribute('aria-valuenow', String(Math.round(v * 2) / 2));
    f.setAttribute('aria-valuetext', `${txt} dB`);
  };
  const paintAll = () => { paint('pre', shown.pre); shown.gains.forEach((v, i) => paint(i, v)); graph.dirty(); };

  const markPreset = (key) => {
    box.querySelectorAll('.eqx-chip').forEach((c) => {
      const on = c.dataset.preset === key;
      c.classList.toggle('on', on);
      if (c.tagName === 'BUTTON') c.setAttribute('aria-pressed', String(on));
    });
    box.querySelector('.eqx-chip.custom').hidden = key !== 'custom';
  };
  const presetFor = (g) => Object.entries(EQ_PRESETS).find(([, p]) => p.gains.every((x, k) => x === g[k]))?.[0] || 'custom';

  // Write to the saved settings and the audio graph.
  const commit = () => {
    prefs.set('eqGains', shown.gains.map(snap));
    prefs.set('eqPreamp', snap(shown.pre));
    player.applyEq();
  };

  // Glide from what's shown to new values (presets, reset).
  let tween = 0;
  const glideTo = (gains, pre) => {
    cancelAnimationFrame(tween);
    const from = { gains: shown.gains.slice(), pre: shown.pre };
    const dur = reduced() ? 0 : 420;
    const t0 = performance.now();
    const step = (now) => {
      const k = dur ? Math.min(1, (now - t0) / dur) : 1;
      const e = 1 - (1 - k) ** 3;
      shown.gains = from.gains.map((g, i) => g + (gains[i] - g) * e);
      shown.pre = from.pre + (pre - from.pre) * e;
      paintAll();
      commit();
      if (k < 1) tween = requestAnimationFrame(step);
      else { shown.gains = gains.slice(); shown.pre = pre; paintAll(); commit(); }
    };
    tween = requestAnimationFrame(step);
  };

  const setOne = (key, v) => {
    cancelAnimationFrame(tween);
    v = snap(v);
    if (key === 'pre') shown.pre = v; else shown.gains[key] = v;
    paint(key, v);
    graph.dirty();
    commit();
    if (key !== 'pre') { const p = presetFor(shown.gains.map(snap)); prefs.set('eqPreset', p); markPreset(p); }
  };

  // ── Faders: drag, click, wheel, keyboard, double-click to zero.
  bands.forEach((b, idx) => {
    const key = idx === 0 ? 'pre' : idx - 1;
    const f = b.querySelector('.eqx-fader');
    const valueAt = (clientY) => {
      const r = f.querySelector('.eqx-track').getBoundingClientRect();
      return MAX - ((clientY - r.top) / r.height) * (MAX - MIN);
    };
    f.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      f.focus();
      f.setPointerCapture(e.pointerId);
      b.classList.add('dragging');
      setOne(key, valueAt(e.clientY));
      const move = (ev) => setOne(key, valueAt(ev.clientY));
      const up = () => { b.classList.remove('dragging'); f.removeEventListener('pointermove', move); f.removeEventListener('pointerup', up); f.removeEventListener('pointercancel', up); };
      f.addEventListener('pointermove', move);
      f.addEventListener('pointerup', up);
      f.addEventListener('pointercancel', up);
    });
    f.addEventListener('dblclick', () => setOne(key, 0));
    f.addEventListener('wheel', (e) => {
      if (!e.deltaY) return;
      e.preventDefault();
      setOne(key, (key === 'pre' ? shown.pre : shown.gains[key]) + (e.deltaY < 0 ? 0.5 : -0.5));
    }, { passive: false });
    f.addEventListener('keydown', (e) => {
      const cur = key === 'pre' ? shown.pre : shown.gains[key];
      const d = { ArrowUp: 0.5, ArrowRight: 0.5, ArrowDown: -0.5, ArrowLeft: -0.5, PageUp: 3, PageDown: -3 }[e.key];
      if (d != null) setOne(key, cur + d);
      else if (e.key === 'Home') setOne(key, MAX);
      else if (e.key === 'End') setOne(key, MIN);
      else if (e.key === '0' || e.key === 'Delete' || e.key === 'Backspace') setOne(key, 0);
      else return;
      e.preventDefault();
    });
    if (key !== 'pre') {
      b.addEventListener('pointerenter', () => { hovered = key; graph.dirty(); });
      b.addEventListener('pointerleave', () => { hovered = -1; graph.dirty(); });
      f.addEventListener('focus', () => { hovered = key; graph.dirty(); });
      f.addEventListener('blur', () => { hovered = -1; graph.dirty(); });
    }
  });

  // ── Presets, on/off, reset
  box.querySelector('.eqx-presets').addEventListener('click', (e) => {
    const c = e.target.closest('button[data-preset]');
    if (!c) return;
    prefs.set('eqPreset', c.dataset.preset);
    markPreset(c.dataset.preset);
    if (!eq.enabled) setEnabled(true);
    glideTo(EQ_PRESETS[c.dataset.preset].gains.slice(), shown.pre);
  });
  const onBox = box.querySelector('[data-eq-on]');
  const setEnabled = (on) => {
    onBox.checked = on;
    prefs.set('eqOn', on);
    box.classList.toggle('off', !on);
    player.applyEq();
    graph.dirty();
  };
  onBox.addEventListener('change', () => setEnabled(onBox.checked));
  box.querySelector('[data-headroom]').addEventListener('change', (e) => { prefs.set('eqHeadroom', e.target.checked); player.applyEq(); });
  box.querySelector('[data-reset]').addEventListener('click', () => {
    prefs.set('eqPreset', 'flat');
    markPreset('flat');
    glideTo(EQ_PRESETS.flat.gains.slice(), 0);
  });

  markPreset(eq.preset in EQ_PRESETS ? eq.preset : presetFor(eq.gains));
  paintAll();
  // Faders slide in from 0 dB when the editor opens.
  if (!reduced()) {
    box.classList.add('intro');
    requestAnimationFrame(() => requestAnimationFrame(() => {
      box.classList.replace('intro', 'settle');
      setTimeout(() => box.classList.remove('settle'), 800);
    }));
  }
  return box;
}

// ───────── Response graph ─────────

const N = 220;
const FREQS = new Float32Array(N).map((_, i) => 20 * Math.pow(1000, i / (N - 1))); // 20 Hz … 20 kHz, log scale
const xOf = (f, w) => (Math.log10(f / 20) / 3) * w;

/** Filter response (dB) per frequency for the given gains, using the browser's own biquads. */
function response(gains) {
  const actx = player.ctx || (response.ctx ||= new OfflineAudioContext(1, 1, 44100));
  const total = new Float32Array(N);
  const mag = new Float32Array(N), ph = new Float32Array(N);
  EQ_BANDS.forEach((f, i) => {
    if (!gains[i]) return;
    const n = actx.createBiquadFilter();
    n.type = i === 0 ? 'lowshelf' : i === EQ_BANDS.length - 1 ? 'highshelf' : 'peaking';
    n.frequency.value = f;
    n.Q.value = 1.1;
    n.gain.value = gains[i];
    n.getFrequencyResponse(FREQS, mag, ph);
    for (let k = 0; k < N; k++) total[k] += 20 * Math.log10(mag[k]);
  });
  return total;
}

function createGraph(cv, getShown, getHovered) {
  let dirty = true;
  let raf = 0;
  let spectrum = null;
  let bins = null;
  const colors = () => {
    const cs = getComputedStyle(cv);
    return { c1: cs.getPropertyValue('--c1').trim() || '#a78bfa', c2: cs.getPropertyValue('--c2').trim() || '#f472b6', text: cs.getPropertyValue('--text-3').trim() || 'rgba(255,255,255,.45)' };
  };

  const draw = () => {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr);
    if (!w || !h) return;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const ctx = cv.getContext('2d');
    const { c1, c2, text } = colors();
    const on = eq.enabled;
    const { gains, pre } = getShown();
    const pad = 6 * dpr;
    const y = (db) => h / 2 - (db / 15) * (h / 2 - pad);
    ctx.clearRect(0, 0, w, h);

    // Grid: dB lines and decade lines, with small labels.
    ctx.lineWidth = dpr;
    ctx.font = `${10 * dpr}px system-ui, sans-serif`;
    ctx.fillStyle = text;
    for (const db of [12, 6, 0, -6, -12]) {
      ctx.strokeStyle = db === 0 ? 'rgba(255,255,255,.16)' : 'rgba(255,255,255,.05)';
      ctx.beginPath(); ctx.moveTo(0, y(db)); ctx.lineTo(w, y(db)); ctx.stroke();
      if (db) ctx.fillText(`${db > 0 ? '+' : ''}${db}`, 6 * dpr, y(db) - 3 * dpr);
    }
    for (const f of [100, 1000, 10000]) {
      const x = xOf(f, w);
      ctx.strokeStyle = 'rgba(255,255,255,.05)';
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      ctx.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x + 4 * dpr, h - 5 * dpr);
    }

    // The music's spectrum, faintly, while something plays.
    if (spectrum) {
      ctx.fillStyle = 'rgba(255,255,255,.06)';
      const bw = w / spectrum.length;
      for (let i = 0; i < spectrum.length; i++) {
        const v = spectrum[i] / 255;
        const bh = v * v * (h - pad * 2);
        ctx.fillRect(i * bw + dpr, h - bh, Math.max(1, bw - 2 * dpr), bh);
      }
    }

    // The response curve: band gains plus pre-amp.
    const total = response(on ? gains : gains.map(() => 0));
    const offset = on ? pre : 0;
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, c1); grad.addColorStop(1, c2);
    ctx.beginPath();
    for (let k = 0; k < N; k++) {
      const px = (k / (N - 1)) * w;
      const py = y(Math.max(-15, Math.min(15, total[k] + offset)));
      k ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.save();
    ctx.lineTo(w, y(0)); ctx.lineTo(0, y(0)); ctx.closePath();
    // Theme colours may be hex or rgb(), so transparency comes from globalAlpha.
    ctx.fillStyle = grad;
    ctx.globalAlpha = on ? 0.2 : 0.08;
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    for (let k = 0; k < N; k++) {
      const px = (k / (N - 1)) * w;
      const py = y(Math.max(-15, Math.min(15, total[k] + offset)));
      k ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.strokeStyle = on ? grad : 'rgba(255,255,255,.25)';
    ctx.lineWidth = 2.5 * dpr;
    ctx.lineJoin = 'round';
    if (on && !document.body.classList.contains('flat')) { ctx.shadowColor = c1; ctx.shadowBlur = 14 * dpr; }
    ctx.stroke();
    ctx.shadowBlur = 0;

    // A dot per band on the curve; the hovered one is bigger.
    const hover = getHovered();
    EQ_BANDS.forEach((f, i) => {
      const k = Math.round((Math.log10(f / 20) / 3) * (N - 1));
      const px = xOf(f, w);
      const py = y(Math.max(-15, Math.min(15, total[Math.min(N - 1, k)] + offset)));
      const r = (i === hover ? 6 : 3.5) * dpr;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fillStyle = on ? (i === hover ? '#fff' : c1) : 'rgba(255,255,255,.35)';
      ctx.fill();
      if (i === hover) { ctx.lineWidth = 2 * dpr; ctx.strokeStyle = c1; ctx.stroke(); }
    });
  };

  // Log-spaced spectrum bars from the player's analyser.
  const readSpectrum = () => {
    const a = player.analyser;
    if (!a || !document.body.classList.contains('playing') || document.hidden) return null;
    const data = (readSpectrum.buf ||= new Uint8Array(a.frequencyBinCount));
    if (data.length !== a.frequencyBinCount) readSpectrum.buf = new Uint8Array(a.frequencyBinCount);
    a.getByteFrequencyData(readSpectrum.buf);
    const sr = player.ctx?.sampleRate || 44100;
    const count = 64;
    bins ||= new Float32Array(count);
    const out = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      const f0 = 20 * Math.pow(1000, i / count), f1 = 20 * Math.pow(1000, (i + 1) / count);
      const b0 = Math.floor((f0 / (sr / 2)) * readSpectrum.buf.length);
      const b1 = Math.max(b0 + 1, Math.ceil((f1 / (sr / 2)) * readSpectrum.buf.length));
      let m = 0;
      for (let b = b0; b < b1 && b < readSpectrum.buf.length; b++) m = Math.max(m, readSpectrum.buf[b]);
      bins[i] += (m - bins[i]) * 0.35; // ease, so bars move smoothly
      out[i] = bins[i];
    }
    return out;
  };

  let frame = 0;
  let lastColors = '';
  const loop = () => {
    if (!cv.isConnected) { raf = 0; return; }
    // Colours follow the album art: notice a theme change a few times a second.
    if (frame++ % 20 === 0) {
      const c = JSON.stringify(colors());
      if (c !== lastColors) { lastColors = c; dirty = true; }
    }
    const s = reduced() ? null : readSpectrum();
    if (s || spectrum) { spectrum = s; dirty = true; }
    if (dirty) { dirty = false; draw(); }
    raf = requestAnimationFrame(loop);
  };
  new ResizeObserver(() => { dirty = true; }).observe(cv);
  requestAnimationFrame(() => { if (!raf) raf = requestAnimationFrame(loop); });
  return { dirty: () => { dirty = true; if (!raf && cv.isConnected) raf = requestAnimationFrame(loop); } };
}

export function openEqualizer() {
  return modal(html`<h3>${ic('sliders')} ${t('Sound')}</h3><p>${t('Shape the sound. Saved in this browser.')}</p>
    <div data-eq-host></div>
    <div data-sound-host></div>
    <div class="modal-actions"><button class="btn primary" data-close>${t('Done')}</button></div>`, (box) => {
    box.classList.add('wide');
    box.querySelector('[data-eq-host]').replaceWith(eqEditor());
    box.querySelector('[data-sound-host]').replaceWith(soundEditor());
  });
}
