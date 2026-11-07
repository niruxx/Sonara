// Admin file operations UI: edit tags, move files, organize folders.
import { api } from './api.js';
import { html, ic, plural } from './util.js';
import { state } from './state.js';
import { modal, toast, toastError, confirmDialog } from './ui.js';
import { navigate } from './router.js';
import { folderPicker } from './views/settings.js';

export const isAdmin = () => !!state.user?.isAdmin;

/** Make sure "Allow Sonara to change files" is on, asking the admin once. */
export async function ensureFileChanges() {
  const t = await api.get('/admin/tools').catch(() => null);
  if (t?.allowFileChanges) return t;
  const ok = await confirmDialog({
    title: 'Allow Sonara to change your files?',
    message: 'Editing tags and moving or organizing files changes your music files on disk. You can turn this off again in Settings → Library.',
    confirm: 'Allow file changes',
  });
  if (!ok) return null;
  try {
    await api.put('/admin/settings', { allowFileChanges: true });
    return { ...t, allowFileChanges: true };
  } catch (err) { toastError(err); return null; }
}

const refresh = () => navigate(location.pathname + location.search, { replace: true });

function reportResult(r, verb) {
  if (r.failed?.length) {
    toast(`${r.done} ${verb}, ${r.failed.length} failed: ${r.failed[0].error}`, { type: 'error', ms: 6000 });
  } else toast(`${plural(r.done, 'file')} ${verb}`, { type: 'success' });
}

// ───────── Tag editor ─────────

const FIELDS = [
  ['title', 'Title'], ['artist', 'Artist'], ['album', 'Album'], ['albumArtist', 'Album artist'],
  ['trackNo', 'Track #', 'number'], ['discNo', 'Disc #', 'number'], ['year', 'Year', 'number'], ['genre', 'Genre'],
  ['composer', 'Composer'], ['comment', 'Comment'],
];
const valueOf = (t, k) => (k === 'title' || k === 'artist' || k === 'album' || k === 'albumArtist' || k === 'trackNo' || k === 'discNo' || k === 'year' || k === 'genre' ? t[k] ?? '' : '');

/**
 * Edit tags of one or more tracks. With several tracks, fields that differ show
 * "(multiple values)" and are left alone unless you type something.
 * `save(tags)` defaults to the library endpoint; the Inbox passes its own.
 */
export async function editTagsDialog(tracks, { save, title } = {}) {
  if (!save && !(await ensureFileChanges())) return false;
  const multi = tracks.length > 1;
  const fields = FIELDS.filter(([k]) => !(multi && k === 'title') && !(multi && k === 'trackNo'));
  const common = {};
  for (const [k] of fields) {
    const vals = new Set(tracks.map((t) => String(valueOf(t, k))));
    common[k] = vals.size === 1 ? [...vals][0] : null; // null = mixed
  }
  return modal(html`
    <h3>${ic('edit')} ${title || (multi ? `Edit ${tracks.length} songs` : 'Edit song info')}</h3>
    <p>${multi ? 'Only the fields you change are written. Leave “multiple values” fields empty to keep each song’s own value.' : 'Changes are written to the file’s tags.'}</p>
    <form class="tag-form">
      ${fields.map(([k, label, type]) => html`<div class="field ${type === 'number' ? 'short' : ''}">
        <input name="${k}" type="${type || 'text'}" value="${common[k] ?? ''}" placeholder="${common[k] === null ? 'multiple values' : ' '}" autocomplete="off" ${type === 'number' ? 'min="0" max="9999"' : ''}>
        <label>${label}</label></div>`)}
      <div class="form-error"></div>
      <div class="modal-actions">
        <button type="button" class="btn ghost" data-close>Cancel</button>
        <button type="submit" class="btn primary">${ic('check')} Save</button>
      </div>
    </form>`, (box, close) => {
    box.classList.add('wide');
    const form = box.querySelector('form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const values = Object.fromEntries(new FormData(form));
      const tags = {};
      for (const [k] of fields) {
        const v = values[k].trim();
        if (common[k] === null && v === '') continue;        // mixed and untouched
        if (common[k] !== null && v === String(common[k])) continue; // unchanged
        tags[k] = v; // '' clears the tag
      }
      if (!Object.keys(tags).length) return close(false);
      const btn = form.querySelector('[type=submit]');
      btn.disabled = true;
      btn.textContent = 'Saving…';
      try {
        if (save) await save(tags);
        else reportResult(await api.post('/admin/tracks/tags', { ids: tracks.map((t) => t.id), tags }), 'updated');
        close(true);
        if (!save) refresh();
      } catch (err) {
        form.querySelector('.form-error').textContent = err.message;
        btn.disabled = false;
        btn.textContent = 'Save';
      }
    });
  });
}

// ───────── Move ─────────

export async function moveDialog(tracks) {
  if (!(await ensureFileChanges())) return;
  const settings = await api.get('/admin/settings');
  const dir = await folderPicker({
    title: `Move ${tracks.length === 1 ? `“${tracks[0].title}”` : plural(tracks.length, 'song')}`,
    message: 'Pick a folder inside your music folders. File names are kept; favorites and playlists follow the files.',
    start: settings.musicDirs[0]?.path || '',
    confirm: 'Move here',
  });
  if (!dir) return;
  try {
    reportResult(await api.post('/admin/tracks/move', { ids: tracks.map((t) => t.id), dir }), 'moved');
    refresh();
  } catch (err) { toastError(err); }
}

// ───────── Organize ─────────

const SCOPE_LABEL = { album: 'this album', artist: 'this artist', genre: 'this genre', playlist: 'this playlist', library: 'your whole library', tracks: 'the selected songs' };

/** scope: { type: 'album'|'artist'|'genre'|'playlist'|'library'|'tracks', id?, ids?, name? } */
export async function organizeDialog(scope) {
  const { templates, roots } = await api.get('/admin/organize/templates');
  if (!roots.length) return toast('Add a music folder in Settings first', { type: 'error' });
  const preset = scope.type === 'playlist' ? 'playlist' : scope.type === 'genre' ? 'genre' : 'album';
  return modal(html`
    <h3>${ic('folder')} Organize files</h3>
    <p>Rename and move the files of <b>${scope.name ? `“${scope.name}”` : SCOPE_LABEL[scope.type]}</b> into folders built from their tags.</p>
    <div class="org-grid">
      <label class="muted">Layout</label>
      <select class="input sm" data-preset>
        ${Object.entries(templates).map(([k, t]) => html`<option value="${k}" ${k === preset ? 'selected' : ''}>${t.name}</option>`)}
        <option value="custom">Custom…</option>
      </select>
      <label class="muted">Template</label>
      <input class="input sm mono" data-template value="${templates[preset].template}" spellcheck="false">
      <label class="muted">Action</label>
      <select class="input sm" data-mode>
        <option value="move">Move files (library updates in place)</option>
        <option value="copy">Copy files somewhere else (e.g. a USB stick)</option>
      </select>
      <label class="muted">Into</label>
      <div class="row-gap" data-root-box>
        <select class="input sm" data-root>${roots.map((r) => html`<option value="${r}">${r}</option>`)}</select>
        <button class="btn sm ghost" data-pick hidden>${ic('folder')} Choose…</button>
      </div>
    </div>
    <p class="muted hint">Fields: {albumartist} {artist} {album} {title} {track} {disc} {year} {genre} {type} {playlist}. Wrap optional parts in [ ], e.g. [{disc}-]. Use / for folders.</p>
    <div class="org-preview"></div>
    <div class="form-error"></div>
    <div class="modal-actions">
      <button class="btn ghost" data-close>Cancel</button>
      <button class="btn" data-preview>${ic('search')} Preview</button>
      <button class="btn primary" data-apply disabled>${ic('check')} Apply</button>
    </div>`, (box, close) => {
    box.classList.add('wide');
    const $ = (s) => box.querySelector(s);
    const err = $('.form-error');
    const preview = $('.org-preview');
    let copyDest = '';
    const body = (dryRun) => ({
      scope, template: $('[data-template]').value, mode: $('[data-mode]').value, dryRun,
      root: $('[data-mode]').value === 'copy' ? copyDest : $('[data-root]').value,
    });
    const invalidate = () => { $('[data-apply]').disabled = true; preview.innerHTML = ''; };
    $('[data-preset]').addEventListener('change', (e) => {
      if (e.target.value !== 'custom') $('[data-template]').value = templates[e.target.value].template;
      else $('[data-template]').focus();
      invalidate();
    });
    $('[data-template]').addEventListener('input', () => { $('[data-preset]').value = 'custom'; invalidate(); });
    $('[data-root]').addEventListener('change', invalidate);
    $('[data-mode]').addEventListener('change', (e) => {
      const copy = e.target.value === 'copy';
      $('[data-root]').hidden = copy;
      $('[data-pick]').hidden = !copy;
      $('[data-pick]').innerHTML = String(html`${ic('folder')} ${copyDest || 'Choose…'}`);
      invalidate();
    });
    $('[data-pick]').addEventListener('click', async () => {
      const d = await folderPicker({ title: 'Copy files to…', message: 'Any folder on the server, such as a mounted USB drive.', confirm: 'Copy here' });
      if (!d) return;
      copyDest = d;
      $('[data-pick]').innerHTML = String(html`${ic('folder')} ${d}`);
      invalidate();
    });
    const rel = (p) => {
      for (const r of [...roots, copyDest].filter(Boolean)) if (p.startsWith(r)) return p.slice(r.length).replace(/^[\\/]/, '');
      return p;
    };
    $('[data-preview]').addEventListener('click', async () => {
      err.textContent = '';
      preview.innerHTML = '<p class="muted">Working out the new names…</p>';
      try {
        const r = await api.post('/admin/organize', body(true));
        preview.innerHTML = String(html`
          <p><b>${plural(r.changes, 'file')}</b> will ${$('[data-mode]').value === 'copy' ? 'be copied' : 'move'}${r.unchanged ? html`, ${r.unchanged} already in place` : ''}.</p>
          ${r.preview.length ? html`<div class="moves">${r.preview.map((m) => html`<div class="move"><span class="from mono" title="${m.from}">${rel(m.from)}</span>${ic('chevronRight')}<span class="to mono" title="${m.to}">${rel(m.to)}</span></div>`)}</div>` : ''}
          ${r.changes > r.preview.length ? html`<p class="muted">…and ${r.changes - r.preview.length} more.</p>` : ''}`);
        $('[data-apply]').disabled = !r.changes;
      } catch (e) { preview.innerHTML = ''; err.textContent = e.message; }
    });
    $('[data-apply]').addEventListener('click', async () => {
      if (!(await ensureFileChanges())) return;
      const b = $('[data-apply]');
      b.disabled = true;
      b.textContent = 'Organizing…';
      try {
        const r = await api.post('/admin/organize', body(false));
        reportResult(r, $('[data-mode]').value === 'copy' ? 'copied' : 'organized');
        close(true);
        refresh();
      } catch (e) { err.textContent = e.message; b.disabled = false; b.textContent = 'Apply'; }
    });
  });
}

/** Identify a song by its sound (AcoustID) and write the chosen match into its tags. */
export function identifyDialog(track) {
  return modal(html`<h3>${ic('waves')} Identify “${track.title}”</h3>
    <p>Sonara fingerprints the audio and looks it up on AcoustID / MusicBrainz. Pick the right match to write it into the file.</p>
    <div data-results><div class="progress indeterminate"><i></i></div><p class="muted">Listening…</p></div>
    <div class="modal-actions"><button class="btn ghost" data-close>Close</button></div>`, async (box, close) => {
    const out = box.querySelector('[data-results]');
    let list;
    try { list = await api.post(`/admin/tracks/${track.id}/identify`); } catch (err) { out.innerHTML = String(html`<p class="form-error">${err.message}</p>`); return; }
    if (!list.length) { out.innerHTML = String(html`<p class="muted">No match found. The recording may not be in AcoustID yet.</p>`); return; }
    out.innerHTML = String(html`<div class="find-list">${list.map((c, i) => html`<div class="find-row">
      <div class="grow"><b>${c.title}</b><div class="muted">${c.artist}${c.album ? ` · ${c.album}` : ''}${c.type ? ` (${c.type})` : ''} · ${c.score}% match</div></div>
      <button class="btn sm" data-apply="${i}">Apply</button></div>`)}</div>`);
    out.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-apply]');
      if (!b) return;
      const c = list[Number(b.dataset.apply)];
      if (!(await ensureFileChanges())) return;
      b.disabled = true;
      try {
        await api.post('/admin/tracks/tags', { ids: [track.id], tags: { title: c.title, artist: c.artist, ...(c.album ? { album: c.album, albumArtist: c.albumArtist } : {}) } });
        toast(`Tagged “${c.title}” by ${c.artist}`, { type: 'success' });
        close(true);
      } catch (err) { toastError(err); b.disabled = false; }
    });
  });
}

/** Menu items for track menus (admins only). */
export function fileMenuItems(tracks) {
  if (!isAdmin()) return [];
  return [
    { icon: 'edit', label: tracks.length > 1 ? `Edit info of ${tracks.length} songs…` : 'Edit info…', action: () => editTagsDialog(tracks) },
    ...(tracks.length === 1 ? [{ icon: 'waves', label: 'Identify song…', action: () => identifyDialog(tracks[0]) }] : []),
    { icon: 'folder', label: 'Move to folder…', action: () => moveDialog(tracks) },
  ];
}

/** Menu items for album/artist/genre/playlist pages (admins only). */
export function collectionFileItems(tracks, scope) {
  if (!isAdmin()) return [];
  return [
    'sep',
    ...(scope.type === 'album' ? [{ icon: 'edit', label: 'Edit album info…', action: () => editTagsDialog(tracks, { title: `Edit “${scope.name}”` }) }] : []),
    { icon: 'folder', label: 'Organize files…', action: () => organizeDialog(scope) },
    { icon: 'folder', label: 'Move to folder…', action: () => moveDialog(tracks) },
  ];
}

