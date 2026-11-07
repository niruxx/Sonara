// Inbox (admins): download with yt-dlp, convert video → audio, upload files,
// then tag and file everything into the library.
import { api } from '../api.js';
import { html, ic, el, plural, fmtBytes, fmtTime } from '../util.js';
import { state } from '../state.js';
import { modal, toast, toastError, confirmDialog, formDialog, openMenu } from '../ui.js';
import { emptyState } from '../components.js';
import { editTagsDialog, ensureFileChanges } from '../fileops.js';
import { folderPicker } from './settings.js';
import { t } from '../i18n.js';

const FORMAT_LABEL = { best: 'Best available (no re-encode)', mp3: 'MP3', m4a: 'M4A (AAC)', opus: 'Opus', flac: 'FLAC', wav: 'WAV' };
const CONVERT_LABEL = { mp3: 'MP3', m4a: 'M4A (AAC)', opus: 'Opus', ogg: 'Ogg Vorbis', flac: 'FLAC (lossless)', wav: 'WAV', copy: 'Keep original audio (no quality loss)' };
const KIND_LABEL = { audio: 'audio', video: 'video', 'audio-unsupported': 'converted on play', other: 'other' };
const KIND_ICON = { audio: 'music', video: 'film', 'audio-unsupported': 'alert', other: 'info' };

export async function inboxView() {
  if (!state.user.isAdmin) return el(emptyState('key', t('Admins only'), t('Ask an admin to download or import music.')));
  const data = await api.get('/admin/inbox');
  const tools = data.tools;
  const v = el(html`<div>
    <h1 class="page-title">${t('Inbox')}</h1>
    <p class="page-sub">${t('Downloads, conversions and uploads wait here until you file them into your library.')}<br>
      <span class="muted mono" style="font-size:12px">${data.dir}</span></p>

    <div class="panels">
      <section class="panel" style="--i:0">
        <h3>${ic('download')} ${t('Download')}</h3>
        ${tools.ytdlp ? html`<p>${t('Paste links from YouTube, SoundCloud, Bandcamp and')} <a href="https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md" target="_blank" rel="noopener">${t('many more sites')}</a>. ${t('One per line.')}</p>`
          : html`<p class="warn-box">${ic('alert')} ${t("yt-dlp isn't installed on the server. Install it with")} <span class="mono">pip install yt-dlp</span>, ${t('your package manager, or')} <a href="https://github.com/yt-dlp/yt-dlp#installation" target="_blank" rel="noopener">${t('a release binary')}</a>, ${t('then reload this page.')}</p>`}
        ${!tools.ffmpeg ? html`<p class="warn-box">${ic('alert')} ${t('ffmpeg is also needed to extract audio.')}</p>` : ''}
        <div class="field"><textarea name="urls" placeholder=" " data-urls ${tools.ytdlp ? '' : 'disabled'}></textarea><label>${t('Links')}</label></div>
        <div class="row-gap">
          <select class="input sm" data-format>${data.formats.map((f) => html`<option value="${f}" ${f === 'mp3' ? 'selected' : ''}>${FORMAT_LABEL[f] ? t(FORMAT_LABEL[f]) : f}</option>`)}</select>
          <button class="btn sm primary" data-download ${tools.ytdlp && tools.ffmpeg ? '' : 'disabled'}>${ic('download')} ${t('Download')}</button>
        </div>
        <label class="check"><input type="checkbox" data-playlist><span class="sw"></span>${t('Download whole playlists')}</label>
        <label class="check"><input type="checkbox" data-thumb checked><span class="sw"></span>${t('Embed thumbnail as cover art')}</label>
      </section>

      <section class="panel" style="--i:1">
        <h3>${ic('film')} ${t('Convert video to audio')}</h3>
        <p>${t('Extract the soundtrack from a video. Upload one from this device, pick one on the server, or use “Convert” on an Inbox video below.')}</p>
        ${!tools.ffmpeg ? html`<p class="warn-box">${ic('alert')} ${t("ffmpeg isn't installed on the server, so conversion is unavailable.")}</p>` : ''}
        <div class="row-gap">
          <select class="input sm" data-cformat>${data.convertFormats.map((f) => html`<option value="${f}">${CONVERT_LABEL[f] ? t(CONVERT_LABEL[f]) : f}</option>`)}</select>
          <select class="input sm" data-bitrate aria-label="${t('Bitrate')}">${[320, 256, 192, 160, 128].map((b) => html`<option value="${b}">${b} kbps</option>`)}</select>
        </div>
        <div class="row-gap" style="margin-top:12px">
          <label class="btn sm ${tools.ffmpeg ? '' : 'disabled'}">${ic('upload')} ${t('Upload and convert')}<input type="file" data-upload accept="video/*,audio/*" multiple hidden ${tools.ffmpeg ? '' : 'disabled'}></label>
          <button class="btn sm" data-server-file ${tools.ffmpeg ? '' : 'disabled'}>${ic('folder')} ${t('Pick on server…')}</button>
        </div>
        <label class="check"><input type="checkbox" data-keep-upload><span class="sw"></span>${t('Keep uploaded videos in the Inbox')}</label>
        <div class="uploads"></div>
        <p class="muted" style="font-size:12px;margin-top:10px">${t('Have audio files already? Uploads that are audio go straight to the Inbox.')}</p>
      </section>
    </div>

    <section class="section"><div class="section-head"><h2>${t('Activity')}</h2><button class="btn sm ghost" data-clear-jobs>${t('Clear finished')}</button></div><div class="jobs"></div></section>

    <section class="section">
      <div class="section-head"><h2>${t('Files')}</h2>
        <div class="row-gap">
          <button class="btn sm" data-select-all>${t('Select all')}</button>
          <button class="btn sm primary" data-import disabled>${ic('check')} ${t('Add to library…')}</button>
          <button class="icon-btn sm" data-bulk-more aria-label="${t('More')}" disabled>${ic('more')}</button>
        </div>
      </div>
      <div class="inbox-files"></div>
    </section>
    <audio class="inbox-audio" hidden></audio>
  </div>`);

  const $ = (s) => v.querySelector(s);
  // Playable audio, plus formats the server converts on the fly (needs ffmpeg).
  const importable = (f) => (f.kind === 'audio' && f.playable) || (f.kind === 'audio-unsupported' && !!tools.ffmpeg);
  let files = data.files;
  let jobs = data.jobs;
  const selected = new Set();
  const audioEl = $('.inbox-audio');
  let previewing = null;

  // ── Files list
  const drawFiles = () => {
    const box = $('.inbox-files');
    for (const n of [...selected]) if (!files.some((f) => f.name === n)) selected.delete(n);
    if (!files.length) {
      box.replaceChildren(el(emptyState('download', t('The Inbox is empty'), t('Downloads and converted files show up here.'))));
    } else {
      box.innerHTML = String(html`<div class="inbox-list">${files.map((f) => html`
        <div class="inbox-row ${selected.has(f.name) ? 'selected' : ''}" data-name="${f.name}">
          <input type="checkbox" class="pick" ${selected.has(f.name) ? 'checked' : ''} aria-label="${t('Select')}" ${importable(f) ? '' : 'disabled'}>
          <button class="icon-btn sm" data-act="preview" aria-label="${t('Preview')}" ${f.playable ? '' : 'disabled'}>${ic(previewing === f.name ? 'pause' : KIND_ICON[f.kind] === 'music' ? 'play' : KIND_ICON[f.kind])}</button>
          <div class="grow ir-main">
            <div class="ir-title">${f.tags?.title || f.name}</div>
            <div class="ir-sub muted">${[f.tags?.artist, f.tags?.album].filter(Boolean).join(' · ') || f.name}</div>
          </div>
          <span class="badge kind-${f.kind}" title="${f.kind === 'audio-unsupported' ? t('Browsers can’t play this format; Sonara converts it while it plays') : ''}">${t(KIND_LABEL[f.kind] || f.kind)}</span>
          <span class="muted ir-meta">${f.duration ? fmtTime(f.duration) : ''}</span>
          <span class="muted ir-meta">${fmtBytes(f.size)}</span>
          ${f.kind !== 'audio' ? html`<button class="btn sm" data-act="convert" ${tools.ffmpeg ? '' : 'disabled'}>${ic('film')} ${t('Convert')}</button>` : ''}
          <button class="icon-btn sm" data-act="more" aria-label="${t('More')}">${ic('more')}</button>
        </div>`)}</div>`);
    }
    $('[data-import]').disabled = !selected.size;
    $('[data-bulk-more]').disabled = !selected.size;
    $('[data-import]').innerHTML = String(html`${ic('check')} ${selected.size > 1 ? t('Add {n} files to library…', { n: selected.size }) : t('Add to library…')}`);
  };
  const reloadFiles = async () => {
    try { files = (await api.get('/admin/inbox')).files; drawFiles(); } catch (err) { toastError(err); }
  };

  const fileByRow = (e) => files.find((f) => f.name === e.target.closest('.inbox-row')?.dataset.name);
  $('.inbox-files').addEventListener('change', (e) => {
    if (!e.target.matches('.pick')) return;
    const f = fileByRow(e);
    e.target.checked ? selected.add(f.name) : selected.delete(f.name);
    drawFiles();
  });
  $('.inbox-files').addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    const f = fileByRow(e);
    if (!f || !act) return;
    if (act === 'preview') {
      if (previewing === f.name) { audioEl.pause(); previewing = null; }
      else { audioEl.src = `/api/admin/inbox/file/${encodeURIComponent(f.name)}`; audioEl.play().catch(() => {}); previewing = f.name; }
      return drawFiles();
    }
    if (act === 'convert') return convertInbox(f.name);
    if (act === 'more') {
      openMenu(e.target.closest('[data-act]'), [
        ...(importable(f) ? [{ icon: 'check', label: t('Add to library…'), action: () => importDialog([f.name]) }] : []),
        ...(f.kind !== 'other' ? [{ icon: 'edit', label: t('Edit tags…'), action: () => editInboxTags([f]) }] : []),
        ...(f.kind !== 'audio' ? [{ icon: 'film', label: t('Convert to audio'), action: () => convertInbox(f.name) }] : []),
        { icon: 'edit', label: t('Rename…'), action: () => renameFile(f) },
        { icon: 'download', label: t('Download to this device'), action: () => { const a = document.createElement('a'); a.href = `/api/admin/inbox/file/${encodeURIComponent(f.name)}`; a.download = f.name; a.click(); } },
        'sep',
        { icon: 'trash', label: t('Delete'), danger: true, action: () => deleteFiles([f.name]) },
      ]);
    }
  });
  audioEl.addEventListener('ended', () => { previewing = null; drawFiles(); });

  $('[data-select-all]').addEventListener('click', () => {
    const choices = files.filter((f) => importable(f));
    if (choices.every((f) => selected.has(f.name))) selected.clear();
    else choices.forEach((f) => selected.add(f.name));
    drawFiles();
  });
  $('[data-import]').addEventListener('click', () => importDialog([...selected]));
  $('[data-bulk-more]').addEventListener('click', (e) => openMenu(e.currentTarget, [
    { icon: 'edit', label: t('Edit tags of {files}…', { files: plural(selected.size, 'file') }), action: () => editInboxTags(files.filter((f) => selected.has(f.name))) },
    'sep',
    { icon: 'trash', label: t('Delete {files}', { files: plural(selected.size, 'file') }), danger: true, action: () => deleteFiles([...selected]) },
  ]));

  async function editInboxTags(list) {
    const asTracks = list.map((f) => ({ ...(f.tags || {}), name: f.name }));
    const ok = await editTagsDialog(asTracks, {
      title: list.length > 1 ? t('Edit {n} files', { n: list.length }) : t('Edit “{name}”', { name: list[0].tags?.title || list[0].name }),
      save: async (tags) => {
        for (const f of list) await api.put(`/admin/inbox/tags/${encodeURIComponent(f.name)}`, { tags });
      },
    });
    if (ok) { toast(t('Tags saved'), { type: 'success' }); reloadFiles(); }
  }

  async function renameFile(f) {
    const val = await formDialog({ title: t('Rename file'), fields: [{ name: 'name', label: t('File name'), value: f.name }], confirm: t('Rename'),
      validate: (x) => (x.name.trim() ? null : t('Enter a name')) });
    if (!val || val.name === f.name) return;
    try { await api.put(`/admin/inbox/rename/${encodeURIComponent(f.name)}`, { name: val.name }); reloadFiles(); } catch (err) { toastError(err); }
  }

  async function deleteFiles(names) {
    if (!(await confirmDialog({ title: t('Delete {files}?', { files: plural(names.length, 'file') }), message: t('They will be permanently removed from the Inbox.'), confirm: t('Delete'), danger: true }))) return;
    for (const n of names) await api.del(`/admin/inbox/${encodeURIComponent(n)}`).catch(toastError);
    if (names.includes(previewing)) { audioEl.pause(); previewing = null; }
    names.forEach((n) => selected.delete(n));
    reloadFiles();
  }

  // ── Download
  $('[data-download]').addEventListener('click', async () => {
    const url = $('[data-urls]').value.trim();
    if (!url) return toast(t('Paste a link first'), { type: 'error' });
    try {
      const r = await api.post('/admin/inbox/download', { url, format: $('[data-format]').value, playlist: $('[data-playlist]').checked, embedThumbnail: $('[data-thumb]').checked });
      $('[data-urls]').value = '';
      toast(r.jobs.length > 1 ? t('{n} downloads started', { n: r.jobs.length }) : t('Download started'), { type: 'success' });
      pollJobs(true);
    } catch (err) { toastError(err); }
  });

  // ── Convert
  const convertOpts = () => ({ format: $('[data-cformat]').value, bitrate: Number($('[data-bitrate]').value) });
  $('[data-cformat]').addEventListener('change', (e) => { $('[data-bitrate]').hidden = ['flac', 'wav', 'copy'].includes(e.target.value); });
  async function convertInbox(name, deleteSource = false) {
    try { await api.post('/admin/inbox/convert', { name, ...convertOpts(), deleteSource }); pollJobs(true); } catch (err) { toastError(err); }
  }
  $('[data-server-file]').addEventListener('click', async () => {
    const p = await folderPicker({ title: t('Pick a video'), message: t('Choose a video file on the server. The original is left untouched.'), files: 'video' });
    if (!p) return;
    try { await api.post('/admin/inbox/convert', { path: p, ...convertOpts() }); pollJobs(true); } catch (err) { toastError(err); }
  });
  $('[data-upload]').addEventListener('change', async (e) => {
    const list = [...e.target.files];
    e.target.value = '';
    for (const file of list) {
      const row = el(html`<div class="upload"><span class="grow">${file.name}</span><div class="progress" style="--p:0%"><i></i></div></div>`);
      $('.uploads').append(row);
      try {
        const name = await uploadFile(file, (p) => row.querySelector('.progress').style.setProperty('--p', `${p}%`));
        row.remove();
        const isVideo = file.type.startsWith('video/') || /\.(mp4|mkv|webm|mov|avi|flv|wmv|m4v|ts|3gp|mpe?g)$/i.test(file.name);
        if (isVideo) await convertInbox(name, !$('[data-keep-upload]').checked);
        else reloadFiles();
      } catch (err) {
        row.remove();
        toastError(err);
      }
    }
  });

  // ── Jobs
  let poll = null;
  const drawJobs = () => {
    const box = $('.jobs');
    if (!jobs.length) { box.innerHTML = String(html`<p class="muted">${t('Nothing running. Downloads and conversions show progress here.')}</p>`); return; }
    box.innerHTML = String(html`${jobs.map((j) => html`
      <div class="job ${j.status}">
        ${ic(j.kind === 'download' ? 'download' : 'film')}
        <div class="grow">
          <div class="job-title" title="${j.source}">${j.title}</div>
          ${j.status === 'running' || j.status === 'queued' ? html`<div class="progress ${j.status === 'queued' || !j.progress ? 'indeterminate' : ''}" style="--p:${j.progress}%"><i></i></div>` : ''}
          <div class="muted job-sub">${j.status === 'running' ? [j.progress ? `${Math.round(j.progress)}%` : t('Starting…'), j.speed, j.eta && t('{time} left', { time: j.eta })].filter(Boolean).join(' · ')
            : j.status === 'queued' ? t('Waiting…')
            : j.status === 'done' ? (j.files.length ? t('Saved {files}', { files: j.files.join(', ') }) : (j.log.at(-1) || t('Done')))
            : j.status === 'cancelled' ? t('Cancelled') : j.error}</div>
        </div>
        ${j.status === 'running' || j.status === 'queued' ? html`<button class="btn sm ghost" data-cancel="${j.id}">${t('Cancel')}</button>` : ''}
        ${j.status === 'error' && j.log.length ? html`<button class="btn sm ghost" data-log="${j.id}">${t('Details')}</button>` : ''}
      </div>`)}`);
  };
  $('.jobs').addEventListener('click', async (e) => {
    const c = e.target.closest('[data-cancel]');
    if (c) { await api.post(`/admin/inbox/jobs/${c.dataset.cancel}/cancel`).catch(toastError); return pollJobs(true); }
    const l = e.target.closest('[data-log]');
    if (l) {
      const j = jobs.find((x) => x.id === l.dataset.log);
      modal(html`<h3>${t('What happened')}</h3><pre class="job-log">${j.log.join('\n')}</pre><div class="modal-actions"><button class="btn primary" data-close>${t('Close')}</button></div>`, (b) => b.classList.add('wide'));
    }
  });
  $('[data-clear-jobs]').addEventListener('click', async () => { await api.del('/admin/inbox/jobs').catch(toastError); pollJobs(true); });

  function pollJobs(force = false) {
    if (poll && !force) return;
    clearTimeout(poll);
    const tick = async () => {
      if (!v.isConnected) return;
      const before = new Set(jobs.filter((j) => j.finishedAt).map((j) => j.id));
      try { jobs = await api.get('/admin/inbox/jobs'); } catch { /* keep going */ }
      drawJobs();
      const newlyDone = jobs.filter((j) => j.finishedAt && !before.has(j.id));
      if (newlyDone.length) {
        reloadFiles();
        for (const j of newlyDone) {
          if (j.status === 'done' && j.files.length) toast(t(j.kind === 'download' ? 'Downloaded “{title}”' : 'Converted “{title}”', { title: j.title }), { type: 'success' });
          if (j.status === 'error') toast(t('Failed: {title}', { title: j.title }), { type: 'error' });
        }
      }
      poll = jobs.some((j) => !j.finishedAt) ? setTimeout(tick, 1000) : null;
    };
    tick();
  }

  // ── Import
  async function importDialog(names) {
    if (!(await ensureFileChanges())) return;
    const { templates, roots } = await api.get('/admin/organize/templates');
    if (!roots.length) return toast(t('Add a music folder in Settings first'), { type: 'error' });
    let dir = '';
    await modal(html`
      <h3>${ic('check')} ${t('Add {files} to your library', { files: plural(names.length, 'file') })}</h3>
      <p>${t(names.length > 1 ? 'Choose where they go. Fix the tags first if you want them filed by artist and album.' : 'Choose where it goes. Fix the tags first if you want it filed by artist and album.')}</p>
      <div class="seg" role="radiogroup">
        <label><input type="radio" name="how" value="organize" checked><span>${t('Organize by tags')}</span></label>
        <label><input type="radio" name="how" value="folder"><span>${t('Pick a folder')}</span></label>
      </div>
      <div class="org-grid" data-how="organize">
        <label class="muted">${t('Layout')}</label>
        <select class="input sm" data-preset>${Object.entries(templates).filter(([k]) => k !== 'playlist').map(([k, tp]) => html`<option value="${k}">${t(tp.name)}</option>`)}</select>
        <label class="muted">${t('Template')}</label>
        <input class="input sm mono" data-template value="${templates.album.template}" spellcheck="false">
        <label class="muted">${t('Music folder')}</label>
        <select class="input sm" data-root>${roots.map((r) => html`<option value="${r}">${r}</option>`)}</select>
      </div>
      <div class="org-grid" data-how="folder" hidden>
        <label class="muted">${t('Folder')}</label>
        <button class="btn sm" data-pick-dir>${ic('folder')} ${t('Choose…')}</button>
      </div>
      <div class="org-grid">
        <label class="muted">${t('Also add to')}</label>
        <select class="input sm" data-pl><option value="">${t('No playlist')}</option>${state.playlists.map((p) => html`<option value="${p.id}">${p.name}</option>`)}</select>
      </div>
      <div class="form-error"></div>
      <div class="modal-actions"><button class="btn ghost" data-close>${t('Cancel')}</button><button class="btn primary" data-go>${ic('check')} ${t('Add to library')}</button></div>`, (box, close) => {
      box.classList.add('wide');
      const q = (s) => box.querySelector(s);
      box.querySelectorAll('[name=how]').forEach((r) => r.addEventListener('change', () => {
        const how = box.querySelector('[name=how]:checked').value;
        box.querySelectorAll('[data-how]').forEach((g) => { g.hidden = g.dataset.how !== how; });
      }));
      q('[data-preset]').addEventListener('change', (e) => { q('[data-template]').value = templates[e.target.value].template; });
      q('[data-pick-dir]').addEventListener('click', async () => {
        const d = await folderPicker({ title: t('Add to which folder?'), message: t('Pick a folder inside your music folders.'), start: roots[0], confirm: t('Put files here') });
        if (d) { dir = d; q('[data-pick-dir]').innerHTML = String(html`${ic('folder')} ${d}`); }
      });
      q('[data-go]').addEventListener('click', async () => {
        const how = box.querySelector('[name=how]:checked').value;
        if (how === 'folder' && !dir) { q('.form-error').textContent = t('Choose a folder'); return; }
        const body = how === 'folder' ? { names, dir } : { names, template: q('[data-template]').value, root: q('[data-root]').value };
        body.playlistId = q('[data-pl]').value || null;
        q('[data-go]').disabled = true;
        try {
          const r = await api.post('/admin/inbox/import', body);
          if (r.failed.length) toast(t('{done} added, {failed} failed: {error}', { done: r.imported.length, failed: r.failed.length, error: r.failed[0].error }), { type: 'error', ms: 6000 });
          else toast(t('Added {songs} to your library', { songs: plural(r.imported.length, 'song') }), { type: 'success' });
          names.forEach((n) => selected.delete(n));
          close(true);
          reloadFiles();
        } catch (err) { q('.form-error').textContent = err.message; q('[data-go]').disabled = false; }
      });
    });
  }

  drawFiles();
  drawJobs();
  if (jobs.some((j) => !j.finishedAt)) pollJobs(true);
  v._destroy = () => { clearTimeout(poll); audioEl.pause(); };
  return v;
}

/** Upload with progress (fetch can't report upload progress). Resolves with the saved Inbox name. */
function uploadFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/admin/inbox/upload?name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress((e.loaded / e.total) * 100);
    xhr.onload = () => {
      let body = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body.name);
      else reject(new Error(body?.error || t('Upload failed ({status})', { status: xhr.status })));
    };
    xhr.onerror = () => reject(new Error(t('Upload failed')));
    xhr.send(file);
  });
}
