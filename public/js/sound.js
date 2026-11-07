// Sound settings beyond the EQ: night mode (compression), mono, balance,
// karaoke (vocal reduction) and headphone correction profiles (AutoEq /
// Equalizer APO "ParametricEQ.txt" format). Stored per browser.
import { html, ic, el, prefs, debounce } from './util.js';
import { player, sound, HP_SLOTS } from './player.js';
import { toast, toastError, formDialog, confirmDialog } from './ui.js';
import { t } from './i18n.js';

const TYPES = { PK: 'peaking', PEQ: 'peaking', LS: 'lowshelf', LSC: 'lowshelf', HS: 'highshelf', HSC: 'highshelf', LP: 'lowpass', LPQ: 'lowpass', HP: 'highpass', HPQ: 'highpass', NO: 'notch', AP: 'allpass' };

/** Parse an AutoEq / Equalizer APO parametric EQ text. Returns { preamp, filters } or throws. */
export function parseParametricEq(text) {
  const preamp = Number(String(text).match(/Preamp:\s*(-?[\d.]+)\s*dB/i)?.[1] ?? 0);
  const filters = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/Filter\s*\d*\s*:\s*ON\s+([A-Z]+)\s+Fc\s+([\d.]+)\s*Hz(?:\s+Gain\s+(-?[\d.]+)\s*dB)?(?:\s+Q\s+([\d.]+))?/i);
    if (!m) continue;
    const type = TYPES[m[1].toUpperCase()];
    if (!type) continue;
    filters.push({ type, fc: Number(m[2]), gain: Number(m[3] || 0), q: Number(m[4] || 0.707) });
  }
  if (!filters.length) throw new Error(t('No filters found. Paste the contents of a “ParametricEQ.txt” file.'));
  if (filters.length > HP_SLOTS) throw new Error(t('This profile has more than {n} filters', { n: HP_SLOTS }));
  return { preamp: Number.isFinite(preamp) ? preamp : 0, filters };
}

const profiles = () => prefs.get('hpProfiles', []);
function saveProfile(name, parsed) {
  const id = Math.random().toString(36).slice(2, 9);
  prefs.set('hpProfiles', [...profiles(), { id, name: String(name).slice(0, 80), ...parsed }]);
  prefs.set('hpActive', id);
  player.applyEq();
  return id;
}

// ───────── AutoEq database (fetched straight from GitHub when you search) ─────────

const AUTOEQ = 'https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/results/';
let autoEqIndex = null;
async function searchAutoEq(q) {
  if (!autoEqIndex) {
    const text = await fetch(`${AUTOEQ}INDEX.md`).then((r) => { if (!r.ok) throw new Error(`GitHub answered ${r.status}`); return r.text(); });
    autoEqIndex = [...text.matchAll(/^- \[(.+?)\]\(\.\/(.+?)\) by (.+?)(?: on (.+))?$/gm)].map((m) => ({ name: m[1], path: m[2], source: m[3], rig: m[4] || '' }));
  }
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return autoEqIndex.filter((e) => words.every((w) => e.name.toLowerCase().includes(w))).slice(0, 40);
}
async function loadAutoEq(entry) {
  const name = decodeURIComponent(entry.path.split('/').pop());
  const text = await fetch(`${AUTOEQ}${entry.path}/${encodeURIComponent(name)}%20ParametricEQ.txt`).then((r) => { if (!r.ok) throw new Error(`GitHub answered ${r.status}`); return r.text(); });
  return parseParametricEq(text);
}

// ───────── Editor ─────────

export function soundEditor() {
  const box = el(html`<div class="sound-editor">
    <div class="sound-grid">
      <label class="check"><input type="checkbox" data-s="nightMode"><span class="sw"></span><span>${t('Night mode')}<small class="muted">${t('Evens out loud and quiet parts, for late listening')}</small></span></label>
      <label class="check"><input type="checkbox" data-s="karaoke"><span class="sw"></span><span>${t('Karaoke')}<small class="muted">${t('Reduces vocals mixed in the centre')}</small></span></label>
      <label class="check"><input type="checkbox" data-s="mono"><span class="sw"></span><span>${t('Mono')}<small class="muted">${t('Both ears hear everything')}</small></span></label>
      <div class="balance"><span class="muted">${t('Balance')}</span>
        <span class="muted" aria-hidden="true">L</span><input class="range" type="range" min="-100" max="100" step="5" data-balance aria-label="${t('Balance')}"><span class="muted" aria-hidden="true">R</span>
        <button class="btn sm ghost" data-center>${t('Centre')}</button></div>
    </div>
    <h4>${ic('sliders')} ${t('Headphone correction')}</h4>
    <p class="muted">${t('Applies a correction profile for your headphones (from the AutoEq project), before the equalizer.')}</p>
    <div class="row-gap">
      <select class="input sm" data-hp aria-label="${t('Headphone correction')}"></select>
      <button class="btn sm" data-hp-search>${ic('search')} ${t('Find my headphones…')}</button>
      <button class="btn sm ghost" data-hp-paste>${ic('upload')} ${t('Paste a profile…')}</button>
      <button class="icon-btn sm" data-hp-del aria-label="${t('Delete this profile')}" title="${t('Delete this profile')}">${ic('trash')}</button>
    </div>
  </div>`);

  const draw = () => {
    for (const c of box.querySelectorAll('[data-s]')) c.checked = !!sound[c.dataset.s];
    const bal = box.querySelector('[data-balance]');
    bal.value = String(Math.round(sound.balance * 100));
    bal.style.setProperty('--pct', `${(Number(bal.value) + 100) / 2}%`);
    bal.setAttribute('aria-valuetext', sound.balance === 0 ? t('Centre') : sound.balance < 0 ? t('{n}% left', { n: Math.round(-sound.balance * 100) }) : t('{n}% right', { n: Math.round(sound.balance * 100) }));
    const sel = box.querySelector('[data-hp]');
    const active = prefs.get('hpActive', null);
    sel.innerHTML = String(html`<option value="">${t('Off')}</option>${profiles().map((p) => html`<option value="${p.id}" ${p.id === active ? 'selected' : ''}>${p.name}</option>`)}`);
    box.querySelector('[data-hp-del]').hidden = !active;
  };
  draw();

  box.querySelectorAll('[data-s]').forEach((c) => c.addEventListener('change', () => { prefs.set(c.dataset.s, c.checked); player.applyEq(); }));
  const bal = box.querySelector('[data-balance]');
  bal.addEventListener('input', () => { prefs.set('balance', Number(bal.value) / 100); player.applyEq(); draw(); });
  bal.addEventListener('dblclick', () => { prefs.set('balance', 0); player.applyEq(); draw(); });
  box.querySelector('[data-center]').addEventListener('click', () => { prefs.set('balance', 0); player.applyEq(); draw(); });
  box.querySelector('[data-hp]').addEventListener('change', (e) => { prefs.set('hpActive', e.target.value || null); player.applyEq(); draw(); });
  box.querySelector('[data-hp-del]').addEventListener('click', async () => {
    const id = prefs.get('hpActive', null);
    const p = profiles().find((x) => x.id === id);
    if (!p || !(await confirmDialog({ title: t('Delete “{name}”?', { name: p.name }), message: t('The profile is removed from this browser.'), confirm: t('Delete'), danger: true }))) return;
    prefs.set('hpProfiles', profiles().filter((x) => x.id !== id));
    prefs.set('hpActive', null);
    player.applyEq();
    draw();
  });
  box.querySelector('[data-hp-paste]').addEventListener('click', async () => {
    const v = await formDialog({
      title: t('Paste a headphone profile'),
      message: t('Paste the contents of a “ParametricEQ.txt” file from AutoEq or Equalizer APO.'),
      fields: [{ name: 'name', label: t('Name') }, { name: 'text', label: t('Profile'), textarea: true }],
      confirm: t('Use profile'),
      validate: (val) => { if (!val.name.trim()) return t('Give it a name'); try { val.parsed = parseParametricEq(val.text); return null; } catch (err) { return err.message; } },
    });
    if (!v) return;
    saveProfile(v.name.trim(), v.parsed);
    draw();
    toast(t('Headphone correction on'), { type: 'success' });
  });

  box.querySelector('[data-hp-search]').addEventListener('click', () => {
    const panel = el(html`<div class="hp-search">
      <p class="muted">${t('Searches the AutoEq list on GitHub (your browser downloads it directly).')}</p>
      <input class="input sm" type="search" placeholder="${t('Headphone model, e.g. HD 650')}" aria-label="${t('Headphone model')}" data-q>
      <div class="find-list" data-results aria-live="polite"></div></div>`);
    const old = box.querySelector('.hp-search');
    if (old) { old.remove(); return; }
    box.append(panel);
    const input = panel.querySelector('[data-q]');
    const out = panel.querySelector('[data-results]');
    input.focus();
    let seq = 0;
    input.addEventListener('input', debounce(async () => {
      const q = input.value.trim();
      const mine = ++seq;
      if (q.length < 2) { out.innerHTML = ''; return; }
      out.innerHTML = String(html`<p class="muted">${t('Searching…')}</p>`);
      try {
        const rows = await searchAutoEq(q);
        if (mine !== seq) return;
        out.innerHTML = rows.length ? String(html`${rows.map((r, i) => html`<div class="find-row"><div class="grow"><b>${r.name}</b><div class="muted">${r.source}${r.rig ? ` · ${r.rig}` : ''}</div></div>
          <button class="btn sm" data-use="${i}">${t('Use')}</button></div>`)}`) : String(html`<p class="muted">${t('No profiles found')}</p>`);
        out.querySelectorAll('[data-use]').forEach((b) => b.addEventListener('click', async () => {
          const r = rows[Number(b.dataset.use)];
          b.disabled = true;
          try {
            saveProfile(`${r.name} (${r.source})`, await loadAutoEq(r));
            panel.remove();
            draw();
            toast(t('Headphone correction: {name}', { name: r.name }), { type: 'success' });
          } catch (err) { toastError(err); b.disabled = false; }
        }));
      } catch (err) { if (mine === seq) out.innerHTML = String(html`<p class="muted">${t('Could not reach GitHub: {error}', { error: err.message })}</p>`); }
    }, 300));
  });
  return box;
}
