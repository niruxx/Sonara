// Smart playlists: a page per playlist and a rule editor.
import { api } from '../api.js';
import { html, ic, el, plural, fmtLong, debounce } from '../util.js';
import { player } from '../player.js';
import { refreshPlaylists } from '../state.js';
import { navigate } from '../router.js';
import { modal, toast, toastError, confirmDialog, openMenu } from '../ui.js';
import { trackList, emptyState, playlistArt } from '../components.js';
import { setPalette } from '../theme.js';

const OP_LABEL = {
  is: 'is', isNot: 'is not', contains: 'contains', notContains: 'doesn’t contain', startsWith: 'starts with', endsWith: 'ends with',
  eq: 'is', ne: 'is not', gt: 'is more than', lt: 'is less than', between: 'is between',
  inLast: 'in the last', notInLast: 'not in the last', before: 'before', after: 'after', never: 'never',
  isTrue: 'yes', isFalse: 'no',
};
const SORT_LABEL = {
  random: 'Random', title: 'Title', artist: 'Artist', album: 'Album', year: 'Newest first', added: 'Recently added',
  lastPlayed: 'Recently played', leastRecent: 'Least recently played', mostPlayed: 'Most played', rating: 'Highest rated',
};

// Ready-made starting points.
const TEMPLATES = [
  { name: 'Recently added', rules: { match: 'all', rules: [{ field: 'addedAt', op: 'inLast', value: 30 }] }, sort: 'added' },
  { name: 'Top rated', rules: { match: 'all', rules: [{ field: 'rating', op: 'gt', value: 3 }] }, sort: 'rating' },
  { name: 'Heavy rotation', rules: { match: 'all', rules: [{ field: 'lastPlayed', op: 'inLast', value: 30 }, { field: 'playCount', op: 'gt', value: 2 }] }, sort: 'mostPlayed', maxTracks: 50 },
  { name: 'Forgotten favorites', rules: { match: 'all', rules: [{ field: 'favorite', op: 'isTrue' }, { field: 'lastPlayed', op: 'notInLast', value: 90 }] }, sort: 'random' },
  { name: 'Never played', rules: { match: 'all', rules: [{ field: 'lastPlayed', op: 'never' }] }, sort: 'random', maxTracks: 100 },
  { name: '90s', rules: { match: 'all', rules: [{ field: 'year', op: 'between', value: 1990, value2: 1999 }] }, sort: 'random' },
  { name: 'Lossless only', rules: { match: 'all', rules: [{ field: 'lossless', op: 'isTrue' }] }, sort: 'artist' },
];

let catalogue = null;
const getCatalogue = async () => (catalogue ||= await api.get('/smart-playlists/fields'));

function describeRule(r, fields) {
  const f = fields.find((x) => x.key === r.field);
  if (!f) return '';
  if (r.op === 'isTrue') return `${f.label}`;
  if (r.op === 'isFalse') return `not ${f.label.toLowerCase()}`;
  if (r.op === 'never') return `${f.label.toLowerCase()}: never`;
  const v = r.op === 'between' ? `${r.value}–${r.value2}` : r.op === 'inLast' || r.op === 'notInLast' ? `${r.value} days` : r.value;
  return `${f.label} ${OP_LABEL[r.op]} ${v}`;
}

export async function smartPlaylistView({ params }) {
  const [p, cat] = await Promise.all([api.get(`/smart-playlists/${params.id}`), getCatalogue()]);
  setPalette(p.covers[0]);
  const summary = p.rules.rules.map((r) => describeRule(r, cat.fields)).join(p.rules.match === 'any' ? ' or ' : ' · ');
  const v = el(html`<div>
    <header class="hero">
      ${p.covers.length ? playlistArt(p) : html`<div class="hero-art"><div class="ph smart-ph">${ic('sparkles')}</div></div>`}
      <div class="hero-info">
        <div class="eyebrow">Smart playlist</div>
        <h1 class="hero-title">${p.name}</h1>
        <div class="hero-meta"><span>${plural(p.trackCount, 'song')}, ${fmtLong(p.duration)}</span></div>
        <p class="hero-desc">${p.description || summary || 'Every song'}</p>
      </div>
    </header>
    <div class="actions">
      <button class="play-fab" data-play aria-label="Play">${ic('play')}</button>
      <button class="icon-btn lg" data-shuffle aria-label="Shuffle">${ic('shuffle')}</button>
      <button class="btn" data-edit>${ic('edit')} Edit rules</button>
      <button class="icon-btn lg" data-more aria-label="More">${ic('more')}</button>
    </div>
    <div class="tracks"></div>
  </div>`);
  v.querySelector('.tracks').replaceWith(p.tracks.length ? trackList(p.tracks).el
    : el(emptyState('sparkles', 'Nothing matches yet', 'Songs appear here automatically as soon as they match the rules.')));
  v.querySelector('[data-play]').addEventListener('click', () => p.tracks.length && player.playList(p.tracks, 0));
  v.querySelector('[data-shuffle]').addEventListener('click', () => p.tracks.length && player.playList(p.tracks, 0, { shuffle: true }));
  v.querySelector('[data-edit]').addEventListener('click', async () => {
    if (await smartEditor(p)) navigate(location.pathname, { replace: true });
  });
  v.querySelector('[data-more]').addEventListener('click', (e) => openMenu(e.currentTarget, [
    { icon: 'addQueue', label: 'Add to queue', action: () => p.tracks.length && player.addToQueue(p.tracks) },
    { icon: 'plus', label: 'Save as a regular playlist…', action: async () => {
      try {
        const pl = await api.post('/playlists', { name: `${p.name} (snapshot)`, trackIds: p.tracks.map((t) => t.id) });
        await refreshPlaylists();
        navigate(`/playlist/${pl.id}`);
      } catch (err) { toastError(err); }
    } },
    'sep',
    { icon: 'trash', label: 'Delete smart playlist', danger: true, action: async () => {
      if (!(await confirmDialog({ title: 'Delete smart playlist?', message: `“${p.name}” will be deleted. No songs are removed.`, confirm: 'Delete', danger: true }))) return;
      await api.del(`/smart-playlists/${p.id}`).catch(toastError);
      await refreshPlaylists();
      toast('Smart playlist deleted');
      navigate('/playlists');
    } },
  ]));
  return v;
}

/** Create (no `existing`) or edit a smart playlist. Resolves with the saved playlist or null. */
export async function smartEditor(existing = null) {
  const cat = await getCatalogue();
  const fields = cat.fields;
  const fieldOf = (k) => fields.find((f) => f.key === k);
  let spec = existing
    ? { name: existing.name, description: existing.description, rules: structuredClone(existing.rules), sort: existing.sort, maxTracks: existing.maxTracks }
    : { name: '', description: '', rules: { match: 'all', rules: [{ field: 'genre', op: 'is', value: '' }] }, sort: 'random', maxTracks: 0 };

  const valueInputs = (r, i) => {
    const f = fieldOf(r.field);
    if (f.type === 'bool' || r.op === 'never') return '';
    if (f.type === 'date' && (r.op === 'inLast' || r.op === 'notInLast')) {
      return html`<input class="input sm" type="number" min="1" data-v="${i}" value="${r.value ?? 30}" style="width:80px"><span class="muted">days</span>`;
    }
    if (f.type === 'date') return html`<input class="input sm" type="date" data-v="${i}" value="${r.value || ''}">`;
    if (f.type === 'num') {
      const step = r.field === 'rating' ? 1 : 'any';
      return html`<input class="input sm" type="number" step="${step}" data-v="${i}" value="${r.value ?? ''}" style="width:90px">
        ${r.op === 'between' ? html`<span class="muted">and</span><input class="input sm" type="number" step="${step}" data-v2="${i}" value="${r.value2 ?? ''}" style="width:90px">` : ''}`;
    }
    return html`<input class="input sm grow" type="text" data-v="${i}" value="${r.value ?? ''}" placeholder="${r.field === 'genre' ? 'e.g. Jazz' : ''}" list="smart-suggest-${r.field}">`;
  };

  return modal(html`
    <h3>${ic('sparkles')} ${existing ? 'Edit smart playlist' : 'New smart playlist'}</h3>
    <p>Songs that match the rules are added automatically, and the playlist stays up to date.</p>
    ${!existing ? html`<div class="chips smart-templates">${TEMPLATES.map((t, i) => html`<button class="chip" data-tpl="${i}">${t.name}</button>`)}</div>` : ''}
    <div class="field"><input name="name" value="${spec.name}" placeholder=" " autocomplete="off"><label>Name</label></div>
    <div class="row-gap" style="margin-bottom:10px">
      <span class="muted">Match</span>
      <select class="input sm" data-match><option value="all">all</option><option value="any">any</option></select>
      <span class="muted">of these rules:</span>
    </div>
    <div class="smart-rules"></div>
    <button class="btn sm ghost" data-add-rule>${ic('plus')} Add rule</button>
    <div class="org-grid" style="margin-top:16px">
      <label class="muted">Order</label>
      <select class="input sm" data-sort>${cat.sorts.map((k) => html`<option value="${k}">${SORT_LABEL[k] || k}</option>`)}</select>
      <label class="muted">Limit</label>
      <div class="row-gap"><input class="input sm" type="number" min="0" max="5000" data-max style="width:90px"><span class="muted">songs (0 = no limit)</span></div>
    </div>
    <div class="smart-preview muted"></div>
    <datalist id="smart-suggest-genre"></datalist>
    <div class="form-error"></div>
    <div class="modal-actions"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" data-save>${ic('check')} ${existing ? 'Save' : 'Create'}</button></div>`, (box, close) => {
    box.classList.add('wide');
    const $ = (s) => box.querySelector(s);
    const rulesBox = $('.smart-rules');
    api.get('/genres').then((g) => { $('#smart-suggest-genre').innerHTML = String(html`${g.map((x) => html`<option value="${x.name}">`)}`); }).catch(() => {});

    const draw = () => {
      $('[name=name]').value = spec.name;
      $('[data-match]').value = spec.rules.match;
      $('[data-sort]').value = spec.sort;
      $('[data-max]').value = spec.maxTracks || 0;
      rulesBox.innerHTML = String(html`${spec.rules.rules.map((r, i) => {
        const f = fieldOf(r.field);
        return html`<div class="smart-rule" data-i="${i}">
          <select class="input sm" data-f="${i}">${fields.map((x) => html`<option value="${x.key}" ${x.key === r.field ? 'selected' : ''}>${x.label}</option>`)}</select>
          <select class="input sm" data-op="${i}">${f.ops.map((o) => html`<option value="${o}" ${o === r.op ? 'selected' : ''}>${OP_LABEL[o]}</option>`)}</select>
          ${valueInputs(r, i)}
          <button class="icon-btn sm" data-rm="${i}" aria-label="Remove rule" ${spec.rules.rules.length < 2 ? 'disabled' : ''}>${ic('x')}</button>
        </div>`;
      })}`);
      preview();
    };

    const readInputs = () => {
      spec.name = $('[name=name]').value;
      spec.rules.match = $('[data-match]').value;
      spec.sort = $('[data-sort]').value;
      spec.maxTracks = Number($('[data-max]').value) || 0;
      spec.rules.rules.forEach((r, i) => {
        const v = box.querySelector(`[data-v="${i}"]`);
        const v2 = box.querySelector(`[data-v2="${i}"]`);
        if (v) r.value = v.type === 'number' ? (v.value === '' ? '' : Number(v.value)) : v.value;
        else delete r.value;
        if (v2) r.value2 = v2.value === '' ? '' : Number(v2.value);
      });
    };

    const preview = debounce(async () => {
      readInputs();
      const out = $('.smart-preview');
      try {
        const r = await api.post('/smart-playlists/preview', { rules: spec.rules, sort: spec.sort, maxTracks: spec.maxTracks });
        out.innerHTML = String(html`<b>${plural(r.count, 'song')}</b> match${r.count === 1 ? 'es' : ''}${r.sample.length ? html`: ${r.sample.slice(0, 4).map((t) => t.title).join(', ')}${r.count > 4 ? '…' : ''}` : ''}`);
        $('.form-error').textContent = '';
      } catch (err) { out.textContent = ''; $('.form-error').textContent = err.message; }
    }, 300);

    box.addEventListener('input', (e) => { if (e.target.matches('[data-v], [data-v2], [data-max]')) preview(); });
    box.addEventListener('change', (e) => {
      const t = e.target;
      if (t.matches('[data-f]')) {
        readInputs();
        const r = spec.rules.rules[Number(t.dataset.f)];
        r.field = t.value;
        r.op = fieldOf(r.field).ops[0];
        r.value = fieldOf(r.field).type === 'date' ? 30 : '';
        delete r.value2;
        draw();
      } else if (t.matches('[data-op]')) {
        readInputs();
        spec.rules.rules[Number(t.dataset.op)].op = t.value;
        draw();
      } else if (t.matches('[data-match], [data-sort]')) preview();
    });
    box.addEventListener('click', (e) => {
      const rm = e.target.closest('[data-rm]');
      if (rm) { readInputs(); spec.rules.rules.splice(Number(rm.dataset.rm), 1); draw(); return; }
      const tpl = e.target.closest('[data-tpl]');
      if (tpl) { spec = { description: '', maxTracks: 0, ...structuredClone(TEMPLATES[Number(tpl.dataset.tpl)]) }; draw(); }
    });
    $('[data-add-rule]').addEventListener('click', () => { readInputs(); spec.rules.rules.push({ field: 'artist', op: 'contains', value: '' }); draw(); });
    $('[data-save]').addEventListener('click', async () => {
      readInputs();
      if (!spec.name.trim()) { $('.form-error').textContent = 'Give it a name'; return; }
      try {
        const body = { name: spec.name, description: spec.description, rules: spec.rules, sort: spec.sort, maxTracks: spec.maxTracks };
        const saved = existing ? (await api.put(`/smart-playlists/${existing.id}`, body), existing) : await api.post('/smart-playlists', body);
        await refreshPlaylists();
        close(saved);
      } catch (err) { $('.form-error').textContent = err.message; }
    });
    draw();
  });
}
