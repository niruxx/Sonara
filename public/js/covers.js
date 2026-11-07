// Cover art editing (admins): upload an image, paste a web address, pick a
// picture from the album's folder, or go back to the art from the files.
import { api } from './api.js';
import { html, ic, art } from './util.js';
import { modal, toast } from './ui.js';

async function post(url, body, type) {
  const res = await fetch(`/api${url}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': type }, body });
  const r = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(r.error || 'Something went wrong');
  return r;
}

/** Resolves true when the cover changed. */
export function coverEditor(album) {
  return modal(html`
    <h3>${ic('palette')} Album cover</h3>
    <p>“${album.name}” · ${album.artist}. The new cover is kept by Sonara (your files aren't changed) and survives rescans.</p>
    <div class="cover-edit">
      <div class="cover-now">${art(album.cover, album.name, 'disc', 300)}</div>
      <div class="cover-opts">
        <label class="drop" data-drop>${ic('upload')}<span><b>Upload an image</b><br><span class="muted">or drop one here (JPEG, PNG, WebP)</span></span>
          <input type="file" accept="image/jpeg,image/png,image/webp" hidden data-file></label>
        <div class="copy-row"><input class="input sm" data-url placeholder="…or paste an image address (https://…)"><button class="btn sm" data-use-url>Use</button></div>
        <div class="muted" style="font-size:13px;margin-top:6px">Pictures in the album's folder:</div>
        <div class="cover-cands"><span class="muted">Looking…</span></div>
      </div>
    </div>
    <div class="form-error"></div>
    <div class="modal-actions"><button class="btn ghost" data-reset hidden>Use the art from the files</button><span style="flex:1"></span><button class="btn ghost" data-close>Close</button></div>`, (box, close) => {
    const err = box.querySelector('.form-error');
    const done = (r) => { toast('Cover updated', { type: 'success' }); album.cover = r.cover; close(true); };
    const fail = (e) => { err.textContent = e.message; };
    const upload = (file) => {
      if (!file) return;
      err.textContent = 'Uploading…';
      post(`/admin/albums/${encodeURIComponent(album.id)}/cover`, file, file.type || 'application/octet-stream').then(done, fail);
    };
    box.querySelector('[data-file]').addEventListener('change', (e) => upload(e.target.files[0]));
    const drop = box.querySelector('[data-drop]');
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); upload(e.dataTransfer.files[0]); });
    // Pasting an image from the clipboard works too.
    box.addEventListener('paste', (e) => {
      const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/'));
      if (f) { e.preventDefault(); upload(f); }
    });
    const fromUrl = () => {
      const url = box.querySelector('[data-url]').value.trim();
      if (!url) return;
      err.textContent = 'Downloading…';
      api.post(`/admin/albums/${encodeURIComponent(album.id)}/cover/from`, { url }).then(done, fail);
    };
    box.querySelector('[data-use-url]').addEventListener('click', fromUrl);
    box.querySelector('[data-url]').addEventListener('keydown', (e) => { if (e.key === 'Enter') fromUrl(); });
    const cands = box.querySelector('.cover-cands');
    api.get(`/admin/albums/${encodeURIComponent(album.id)}/cover/candidates`).then((r) => {
      box.querySelector('[data-reset]').hidden = !r.custom;
      cands.innerHTML = String(r.candidates.length
        ? html`${r.candidates.map((c) => html`<button class="cand" data-cand="${c.cover}" title="${c.name}">${art(c.cover, c.name, 'disc', 120)}</button>`)}`
        : html`<span class="muted">None found.</span>`);
    }).catch(() => { cands.textContent = ''; });
    cands.addEventListener('click', (e) => {
      const b = e.target.closest('[data-cand]');
      if (b) api.post(`/admin/albums/${encodeURIComponent(album.id)}/cover/from`, { candidate: b.dataset.cand }).then(done, fail);
    });
    box.querySelector('[data-reset]').addEventListener('click', () => {
      api.del(`/admin/albums/${encodeURIComponent(album.id)}/cover`).then(() => {
        toast('Going back to the art from your files. It shows up after a quick rescan.');
        close(true);
      }, fail);
    });
  });
}
