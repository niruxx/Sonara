// Equalizer editor: on/off, presets, 10 band sliders, pre-amp and a live response curve.
import { html, ic, el, prefs } from './util.js';
import { player, eq, EQ_BANDS, EQ_PRESETS } from './player.js';
import { modal } from './ui.js';

const fmtHz = (f) => (f >= 1000 ? `${f / 1000}k` : String(f));
const fmtDb = (v) => `${v > 0 ? '+' : ''}${Number(v).toFixed(v % 1 ? 1 : 0)}`;

/** Returns an element; changes apply to playback immediately. */
export function eqEditor() {
  const box = el(html`<div class="eq ${eq.enabled ? '' : 'off'}">
    <div class="eq-top">
      <label class="check"><input type="checkbox" data-eq-on ${eq.enabled ? 'checked' : ''}><span class="sw"></span>Equalizer</label>
      <select class="input sm" data-eq-preset aria-label="Preset">
        ${Object.entries(EQ_PRESETS).map(([k, p]) => html`<option value="${k}" ${eq.preset === k ? 'selected' : ''}>${p.name}</option>`)}
        <option value="custom" ${eq.preset === 'custom' ? 'selected' : ''}>Custom</option>
      </select>
    </div>
    <canvas class="eq-curve" aria-hidden="true"></canvas>
    <div class="eq-bands">
      <div class="eq-band preamp">
        <span class="eq-val" data-pre-val>${fmtDb(eq.preamp)}</span>
        <input class="eq-slider" type="range" min="-12" max="12" step="0.5" value="${eq.preamp}" data-pre aria-label="Pre-amp">
        <span class="eq-hz">Pre</span>
      </div>
      ${EQ_BANDS.map((f, i) => html`<div class="eq-band">
        <span class="eq-val" data-val="${i}">${fmtDb(eq.gains[i])}</span>
        <input class="eq-slider" type="range" min="-12" max="12" step="0.5" value="${eq.gains[i]}" data-band="${i}" aria-label="${fmtHz(f)} Hz">
        <span class="eq-hz">${fmtHz(f)}</span>
      </div>`)}
    </div>
    <div class="eq-foot">
      <label class="check"><input type="checkbox" data-headroom ${eq.autoHeadroom ? 'checked' : ''}><span class="sw"></span>Prevent clipping when boosting</label>
      <button class="btn sm ghost" data-reset>${ic('refresh')} Reset</button>
    </div>
  </div>`);

  const sliders = [...box.querySelectorAll('[data-band]')];
  const preset = box.querySelector('[data-eq-preset]');
  const canvas = box.querySelector('.eq-curve');

  const apply = () => { player.applyEq(); drawCurve(canvas); };
  const setGains = (gains, presetKey) => {
    prefs.set('eqGains', gains);
    prefs.set('eqPreset', presetKey);
    sliders.forEach((s, i) => { s.value = gains[i]; box.querySelector(`[data-val="${i}"]`).textContent = fmtDb(gains[i]); });
    preset.value = presetKey;
    apply();
  };

  box.querySelector('[data-eq-on]').addEventListener('change', (e) => {
    prefs.set('eqOn', e.target.checked);
    box.classList.toggle('off', !e.target.checked);
    apply();
  });
  preset.addEventListener('change', () => {
    if (preset.value !== 'custom') setGains(EQ_PRESETS[preset.value].gains.slice(), preset.value);
    else prefs.set('eqPreset', 'custom');
  });
  sliders.forEach((s, i) => s.addEventListener('input', () => {
    const g = eq.gains;
    g[i] = Number(s.value);
    const match = Object.entries(EQ_PRESETS).find(([, p]) => p.gains.every((x, k) => x === g[k]));
    setGains(g, match ? match[0] : 'custom');
  }));
  // Double-click a slider to zero it.
  sliders.forEach((s) => s.addEventListener('dblclick', () => { s.value = 0; s.dispatchEvent(new Event('input')); }));
  const pre = box.querySelector('[data-pre]');
  pre.addEventListener('input', () => {
    prefs.set('eqPreamp', Number(pre.value));
    box.querySelector('[data-pre-val]').textContent = fmtDb(pre.value);
    apply();
  });
  pre.addEventListener('dblclick', () => { pre.value = 0; pre.dispatchEvent(new Event('input')); });
  box.querySelector('[data-headroom]').addEventListener('change', (e) => { prefs.set('eqHeadroom', e.target.checked); apply(); });
  box.querySelector('[data-reset]').addEventListener('click', () => {
    setGains(EQ_PRESETS.flat.gains.slice(), 'flat');
    pre.value = 0;
    pre.dispatchEvent(new Event('input'));
  });

  requestAnimationFrame(() => drawCurve(canvas));
  return box;
}

/** Draw the combined frequency response of the current settings. */
function drawCurve(cv) {
  if (!cv.isConnected) return;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = cv.clientWidth * dpr, h = cv.clientHeight * dpr;
  if (!w || !h) return;
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  const cs = getComputedStyle(document.documentElement);
  const c1 = cs.getPropertyValue('--c1').trim() || '#a78bfa';
  const c2 = cs.getPropertyValue('--c2').trim() || '#f472b6';

  // Response from the real filters when the audio graph exists, otherwise from an offline context.
  const N = 200;
  const freqs = new Float32Array(N);
  for (let i = 0; i < N; i++) freqs[i] = 20 * Math.pow(1000, i / (N - 1)); // 20 Hz … 20 kHz, log scale
  const total = new Float32Array(N);
  const on = eq.enabled;
  const gains = eq.gains;
  const actx = player.ctx || (drawCurve.ctx ||= new OfflineAudioContext(1, 1, 44100));
  EQ_BANDS.forEach((f, i) => {
    const n = actx.createBiquadFilter();
    n.type = i === 0 ? 'lowshelf' : i === EQ_BANDS.length - 1 ? 'highshelf' : 'peaking';
    n.frequency.value = f;
    n.Q.value = 1.1;
    n.gain.value = on ? gains[i] : 0;
    const mag = new Float32Array(N), ph = new Float32Array(N);
    n.getFrequencyResponse(freqs, mag, ph);
    for (let k = 0; k < N; k++) total[k] += 20 * Math.log10(mag[k]);
  });

  const y = (db) => h / 2 - (db / 15) * (h / 2 - 4 * dpr);
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(255,255,255,.12)';
  ctx.lineWidth = dpr;
  ctx.beginPath(); ctx.moveTo(0, y(0)); ctx.lineTo(w, y(0)); ctx.stroke();

  const grad = ctx.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, c1); grad.addColorStop(1, c2);
  ctx.beginPath();
  for (let k = 0; k < N; k++) {
    const px = (k / (N - 1)) * w;
    k ? ctx.lineTo(px, y(total[k])) : ctx.moveTo(px, y(total[k]));
  }
  ctx.strokeStyle = grad;
  ctx.lineWidth = 2.5 * dpr;
  ctx.shadowColor = c1;
  ctx.shadowBlur = 12 * dpr;
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.lineTo(w, y(0)); ctx.lineTo(0, y(0)); ctx.closePath();
  ctx.globalAlpha = 0.15;
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.globalAlpha = 1;
}

export function openEqualizer() {
  return modal(html`<h3>${ic('sliders')} Equalizer</h3><p>Shape the sound. Saved in this browser.</p>
    <div data-eq-host></div>
    <div class="modal-actions"><button class="btn primary" data-close>Done</button></div>`, (box) => {
    box.classList.add('wide');
    box.querySelector('[data-eq-host]').replaceWith(eqEditor());
  });
}
