// Chapters (podcasts) and bookmarks (songs and episodes) for what's playing:
// shown as ticks on the seek bar and listed in the Now Playing menu.
import { api } from './api.js';
import { html, fmtTime } from './util.js';
import { player } from './player.js';
import { toast, toastError, formDialog, modal } from './ui.js';
import { ic } from './util.js';
import { t } from './i18n.js';

const cache = new Map(); // item id -> { chapters, bookmarks }

const ref = (tr) => (typeof tr?.id === 'number' ? { trackId: tr.id, q: { track: tr.id } } : tr?.kind === 'episode' ? { episodeId: tr.episodeId, q: { episode: tr.episodeId } } : null);

export async function loadMarks(tr, { fresh = false } = {}) {
  const r = ref(tr);
  if (!r) return { chapters: [], bookmarks: [] };
  if (!fresh && cache.has(tr.id)) return cache.get(tr.id);
  const [chapters, bookmarks] = await Promise.all([
    tr.kind === 'episode' ? api.get(`/podcasts/episodes/${tr.episodeId}/chapters`).catch(() => []) : [],
    api.get('/bookmarks', r.q).catch(() => []),
  ]);
  const m = { chapters, bookmarks };
  cache.set(tr.id, m);
  return m;
}

/** Bookmark the current position (B). */
export async function addBookmark({ ask = false } = {}) {
  const tr = player.current;
  const r = ref(tr);
  if (!r || player.remote || tr.live) return toast(t('Bookmarks work for songs and podcast episodes'));
  const position = player.time;
  let label = '';
  if (ask) {
    const v = await formDialog({ title: t('Add bookmark at {time}', { time: fmtTime(position) }), fields: [{ name: 'label', label: t('Name (optional)') }], confirm: t('Add') });
    if (!v) return;
    label = v.label;
  }
  try {
    await api.post('/bookmarks', { trackId: r.trackId, episodeId: r.episodeId, position, label });
    await loadMarks(tr, { fresh: true });
    player.emit('marks', tr.id);
    toast(t('Bookmarked {time}', { time: fmtTime(position) }), { type: 'success', ms: 1500 });
  } catch (err) { toastError(err); }
}

/** Menu items for the Now Playing "more" menu. */
export async function markMenuItems() {
  const tr = player.current;
  if (!ref(tr) || tr.live) return [];
  const { chapters, bookmarks } = await loadMarks(tr);
  const items = [{ icon: 'star', label: html`${t('Add bookmark…')}<small class="menu-sub">${t('Or press B')}</small>`, action: () => addBookmark({ ask: true }) }];
  for (const c of chapters) items.push({ icon: 'list', label: html`${c.title}<small class="menu-sub">${t('Chapter')} · ${fmtTime(c.start)}</small>`, action: () => player.seek(c.start) });
  for (const b of bookmarks) {
    items.push({ icon: 'starFill', label: html`${b.label || t('Bookmark')}<small class="menu-sub">${fmtTime(b.position)}</small>`, action: () => player.seek(b.position) });
  }
  if (bookmarks.length) items.push({ icon: 'edit', label: t('Manage bookmarks…'), action: () => manageBookmarks(tr) });
  return items;
}

function manageBookmarks(tr) {
  return modal(html`<h3>${ic('starFill')} ${t('Bookmarks')}</h3><p>${tr.title}</p><div data-list></div>
    <div class="modal-actions"><button class="btn primary" data-close>${t('Done')}</button></div>`, async (box) => {
    const list = box.querySelector('[data-list]');
    const draw = async () => {
      const { bookmarks } = await loadMarks(tr, { fresh: true });
      player.emit('marks', tr.id);
      list.innerHTML = bookmarks.length ? String(html`${bookmarks.map((b) => html`<div class="list-row">${ic('starFill')}
        <span class="mono">${fmtTime(b.position)}</span>
        <input class="input sm grow" value="${b.label}" placeholder="${t('Name (optional)')}" aria-label="${t('Bookmark name')}" data-label="${b.id}">
        <button class="icon-btn sm" data-del="${b.id}" aria-label="${t('Delete bookmark at {time}', { time: fmtTime(b.position) })}">${ic('trash')}</button></div>`)}`)
        : String(html`<p class="muted">${t('No bookmarks left.')}</p>`);
    };
    list.addEventListener('click', async (e) => {
      const d = e.target.closest('[data-del]');
      if (!d) return;
      try { await api.del(`/bookmarks/${d.dataset.del}`); await draw(); } catch (err) { toastError(err); }
    });
    list.addEventListener('change', async (e) => {
      const i = e.target.closest('[data-label]');
      if (i) try { await api.put(`/bookmarks/${i.dataset.label}`, { label: i.value }); await loadMarks(tr, { fresh: true }); player.emit('marks', tr.id); } catch (err) { toastError(err); }
    });
    await draw();
  });
}

/** Ticks for the seek bar: [{ at (0–1), kind, title }]. */
export async function markTicks(tr) {
  const d = tr?.duration || player.duration;
  if (!d || tr?.live) return [];
  const { chapters, bookmarks } = await loadMarks(tr);
  return [
    ...chapters.filter((c) => c.start > 0).map((c) => ({ at: c.start / d, kind: 'chapter', title: c.title })),
    ...bookmarks.map((b) => ({ at: b.position / d, kind: 'bookmark', title: b.label || fmtTime(b.position) })),
  ].filter((m) => m.at > 0 && m.at < 1);
}
