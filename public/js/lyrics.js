// Lyrics panel for the Now Playing view: synced (LRC) lyrics scroll and
// highlight with the music, and a click on a line seeks to it.
import { api } from './api.js';
import { html, ic, prefs } from './util.js';
import { player } from './player.js';
import { state } from './state.js';
import { modal, toast, toastError } from './ui.js';

/** Parse LRC text → { synced: [{ t, text }] } or { plain: [lines] }. */
export function parseLrc(text) {
  let offset = 0;
  const lines = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const off = raw.match(/^\s*\[offset:\s*([+-]?\d+)\s*\]/i);
    if (off) { offset = Number(off[1]) / 1000; continue; }
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (!stamps.length) continue;
    // Strip timestamps and word-level <mm:ss.xx> tags (enhanced LRC).
    const words = raw.replace(/\[[^\]]*\]/g, '').replace(/<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/g, '').trim();
    for (const m of stamps) {
      const frac = m[3] ? Number(m[3]) / 10 ** m[3].length : 0;
      lines.push({ t: Number(m[1]) * 60 + Number(m[2]) + frac - offset, text: words });
    }
  }
  if (lines.length) return { synced: lines.sort((a, b) => a.t - b.t) };
  return { plain: String(text || '').replace(/^\s*\[(ti|ar|al|by|length|re|ve):[^\]]*\]\s*$/gim, '').trim().split(/\r?\n/) };
}

const SOURCE_LABEL = { lrc: 'From a .lrc file', file: 'From a text file', embedded: 'From the file’s tags', lrclib: 'From LRCLIB', manual: 'Added by an admin' };

export function attachLyrics(np) {
  const btn = np.querySelector('[data-np-lyrics]');
  const pane = np.querySelector('.np-lyrics');
  let open = prefs.get('lyricsOpen', false);
  let current = null; // { trackId, synced, plain }
  let activeIdx = -1;
  let userScrolledAt = 0;

  const setOpen = (v) => {
    open = v;
    prefs.set('lyricsOpen', v);
    np.classList.toggle('show-lyrics', v);
    btn.classList.toggle('on', v);
    if (v) load();
  };

  const render = (data) => {
    activeIdx = -1;
    if (!data) { pane.innerHTML = '<div class="lyr-empty"><div class="lyr-spinner"></div></div>'; return; }
    if (!data.found) {
      pane.innerHTML = String(html`<div class="lyr-empty">${ic('mic')}<p>No lyrics for this song</p>
        <span class="muted">${data.online ? 'Nothing found online either.' : 'Add a .lrc file next to the song, or turn on online lyrics in Settings.'}</span>
        ${state.user?.isAdmin ? html`<button class="btn sm" data-edit-lyrics>${ic('edit')} Add lyrics</button>` : ''}</div>`);
      return;
    }
    const parsed = parseLrc(data.text);
    current = { trackId: player.current?.id, ...parsed };
    pane.innerHTML = String(html`
      <div class="lyr-lines ${parsed.synced ? 'synced' : 'plain'}">
        ${parsed.synced
          ? parsed.synced.map((l, i) => html`<p class="lyr-line" data-i="${i}" data-t="${l.t}">${l.text || '♪'}</p>`)
          : parsed.plain.map((l) => html`<p class="lyr-line">${l || '\u00a0'}</p>`)}
      </div>
      <div class="lyr-foot muted">${SOURCE_LABEL[data.source] || ''}
        ${state.user?.isAdmin ? html` · <button class="link" data-edit-lyrics>Edit</button>${data.source === 'lrclib' || data.online ? html` · <button class="link" data-refresh-lyrics>Search again</button>` : ''}` : ''}
      </div>`);
    pane.scrollTop = 0;
    sync(true);
  };

  async function load(refresh = false) {
    const t = player.current;
    if (!open || !t) return;
    if (typeof t.id !== 'number') {
      current = { trackId: t.id };
      pane.innerHTML = String(html`<div class="lyr-empty">${ic(t.live ? 'radio' : 'podcast')}<p>${t.live ? 'Lyrics aren’t available for radio' : 'Lyrics aren’t available for podcasts'}</p></div>`);
      return;
    }
    if (!refresh && current?.trackId === t.id) return;
    current = { trackId: t.id };
    render(null);
    try {
      const data = await api.get(`/tracks/${t.id}/lyrics`, refresh ? { refresh: 1 } : {});
      if (player.current?.id === t.id) render(data);
    } catch (err) {
      pane.innerHTML = String(html`<div class="lyr-empty">${ic('alert')}<p>${err.message}</p></div>`);
    }
  }

  // Highlight the current line and keep it centred (unless the user is scrolling).
  function sync(jump = false) {
    if (!open || !current?.synced) return;
    const t = player.time + 0.15;
    let i = -1;
    for (let k = 0; k < current.synced.length && current.synced[k].t <= t; k++) i = k;
    if (i === activeIdx && !jump) return;
    activeIdx = i;
    pane.querySelectorAll('.lyr-line.active, .lyr-line.past').forEach((p) => p.classList.remove('active', 'past'));
    pane.querySelectorAll('.lyr-line').forEach((p) => { if (Number(p.dataset.i) < i) p.classList.add('past'); });
    const line = pane.querySelector(`.lyr-line[data-i="${i}"]`);
    line?.classList.add('active');
    if (line && Date.now() - userScrolledAt > 3000) {
      const top = line.offsetTop - pane.clientHeight / 2 + line.clientHeight / 2;
      pane.scrollTo({ top, behavior: jump || document.body.classList.contains('reduce-motion') ? 'auto' : 'smooth' });
    }
  }

  pane.addEventListener('wheel', () => { userScrolledAt = Date.now(); }, { passive: true });
  pane.addEventListener('touchmove', () => { userScrolledAt = Date.now(); }, { passive: true });
  pane.addEventListener('click', async (e) => {
    const line = e.target.closest('.lyr-line[data-t]');
    if (line) { userScrolledAt = 0; player.seek(Number(line.dataset.t)); return; }
    if (e.target.closest('[data-refresh-lyrics]')) return load(true);
    if (e.target.closest('[data-edit-lyrics]')) {
      const t = player.current;
      const existing = await api.get(`/tracks/${t.id}/lyrics`).catch(() => null);
      const text = await editLyrics(t, existing?.text || '');
      if (text == null) return;
      try {
        await api.put(`/tracks/${t.id}/lyrics`, { text });
        toast('Lyrics saved', { type: 'success' });
        load(true);
      } catch (err) { toastError(err); }
    }
  });

  btn.addEventListener('click', () => setOpen(!open));
  player.on('track', () => { current = null; load(); });
  player.on('time', () => sync());
  setOpen(open);
  return { toggle: () => setOpen(!open) };
}

function editLyrics(track, text) {
  return modal(html`
    <h3>${ic('mic')} Lyrics for “${track.title}”</h3>
    <p>Paste plain lyrics, or synced lyrics in LRC format (<span class="mono">[01:23.45] A line</span>). Saved in Sonara; your files aren't changed.</p>
    <div class="field"><textarea name="lyrics" class="lyr-edit" placeholder=" ">${text}</textarea><label>Lyrics</label></div>
    <div class="modal-actions"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" data-ok>${ic('check')} Save</button></div>`, (box, close) => {
    box.classList.add('wide');
    box.querySelector('[data-ok]').addEventListener('click', () => close(box.querySelector('textarea').value));
  });
}
