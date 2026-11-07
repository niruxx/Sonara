// Reusable view components: cards, track lists, track menus.
import { html, ic, el, art, fmtTime, fmtBytes, plural, hues } from './util.js';
import { player } from './player.js';
import { openMenu, dragSort, modal, toast, toastError } from './ui.js';
import { api } from './api.js';
import { state, bus, toggleFavorite, setRating, createPlaylist, addToPlaylist } from './state.js';
import { navigate } from './router.js';
import { fileMenuItems } from './fileops.js';

// ───────── Cards ─────────

export const albumCard = (a, i = 0) => html`
  <a class="card" href="/album/${a.id}" data-album="${a.id}" style="--i:${i}">
    <div class="card-art">${art(a.cover, a.name)}
      <button class="card-play" data-play-album="${a.id}" aria-label="Play ${a.name}">${ic('play')}</button>
    </div>
    <div class="card-title" title="${a.name}">${a.name}</div>
    <div class="card-sub">${a.year ? `${a.year} · ` : ''}<span data-href="/artist/${a.artistId}">${a.artist}</span></div>
  </a>`;

export const artistCard = (a, i = 0) => html`
  <a class="card round" href="/artist/${a.id}" style="--i:${i}">
    <div class="card-art">${art(a.cover, a.name, 'artist')}
      <button class="card-play" data-play-artist="${a.id}" aria-label="Play ${a.name}">${ic('play')}</button>
    </div>
    <div class="card-title">${a.name}</div>
    <div class="card-sub">${a.albumCount != null ? plural(a.albumCount, 'album') : 'Artist'}</div>
  </a>`;

export function playlistArt(pl) {
  const covers = pl.covers || [];
  if (covers.length >= 4) return html`<div class="hero-art mosaic">${covers.slice(0, 4).map((c) => art(c))}</div>`;
  return html`<div class="hero-art">${art(covers[0], pl.name, 'playlist')}</div>`;
}

export const playlistCard = (pl, i = 0) => html`
  <a class="card" href="/playlist/${pl.id}" style="--i:${i}">
    <div class="card-art">${(pl.covers || []).length >= 4
      ? html`<div style="display:grid;grid-template-columns:1fr 1fr;width:100%;height:100%">${pl.covers.slice(0, 4).map((c) => art(c))}</div>`
      : art(pl.covers?.[0], pl.name, 'playlist')}
      <button class="card-play" data-play-playlist="${pl.id}" aria-label="Play ${pl.name}">${ic('play')}</button>
    </div>
    <div class="card-title">${pl.name}</div>
    <div class="card-sub">${plural(pl.trackCount, 'song')}</div>
  </a>`;

export const genreTile = (g, i = 0) => {
  const { h1, h2 } = hues(g.name);
  return html`<a class="genre-tile" href="/genre/${encodeURIComponent(g.name)}" style="--h1:${h1};--h2:${h2};--i:${i}">
    ${g.name}<small>${plural(g.albumCount, 'album')}</small>
    ${g.cover ? html`<img src="/api/cover/${g.cover}" alt="" loading="lazy">` : ''}
  </a>`;
};

export const skeletonGrid = (n = 12) => html`<div class="grid">${Array.from({ length: n }, () => html`<div class="skeleton sk-card"></div>`)}</div>`;

export const emptyState = (iconName, title, text, action = '') => html`
  <div class="empty"><div class="empty-icon">${ic(iconName)}</div><h3>${title}</h3><p>${text}</p>${action}</div>`;

// Card buttons: play album / artist / playlist without navigating.
document.addEventListener('click', async (e) => {
  const sub = e.target.closest('[data-href]');
  if (sub && sub.closest('a.card')) {
    e.preventDefault();
    e.stopPropagation();
    navigate(sub.dataset.href);
    return;
  }
  const b = e.target.closest('[data-play-album], [data-play-artist], [data-play-playlist]');
  if (!b) return;
  e.preventDefault();
  e.stopPropagation();
  const d = b.dataset;
  const list = d.playAlbum ? (await api.get(`/albums/${d.playAlbum}`)).tracks
    : d.playArtist ? await api.get(`/artists/${d.playArtist}/tracks`)
    : (await api.get(`/playlists/${d.playPlaylist}`)).tracks;
  player.playList(list, 0, { shuffle: !!d.playArtist });
}, true); // capture: must run before the router's link handler

// ───────── Track menus ─────────

export function trackMenu(at, track, { tracks = [track], extra = [] } = {}) {
  const multi = tracks.length > 1;
  openMenu(at, [
    { icon: 'play', label: multi ? `Play ${tracks.length} songs` : 'Play', action: () => player.playList(tracks, 0) },
    { icon: 'playNext', label: 'Play next', action: () => player.playNext(tracks) },
    { icon: 'addQueue', label: 'Add to queue', action: () => player.addToQueue(tracks) },
    ...(!multi ? [{ icon: 'radio', label: 'Start song radio', action: () => player.startRadio(`track:${track.id}`, track.title) }] : []),
    'sep',
    { icon: 'list', label: 'Add to playlist…', action: (e) => playlistPicker(at instanceof Element ? at : e, tracks) },
    ...(!multi ? [{ icon: track.favorite ? 'heartFill' : 'heart', label: track.favorite ? 'Remove from Favorites' : 'Add to Favorites', action: () => toggleFavorite(track) }] : []),
    ...(!multi ? [{ icon: track.rating ? 'starFill' : 'star', label: track.rating ? `Rating: ${'★'.repeat(track.rating)}` : 'Rate…', action: (e) => ratingMenu(at instanceof Element ? at : e, track) }] : []),
    ...(!multi ? ['sep',
      { icon: 'disc', label: 'Go to album', action: () => navigate(`/album/${track.albumId}`) },
      ...(track.artists?.length > 1
        ? track.artists.map((a) => ({ icon: 'mic', label: `Go to ${a.name}`, action: () => navigate(`/artist/${a.id}`) }))
        : [{ icon: 'mic', label: 'Go to artist', action: () => navigate(`/artist/${track.artistId}`) }]),
      { icon: 'info', label: 'Track details', action: () => trackDetails(track) },
      ...(canShare() ? [{ icon: 'share', label: 'Share…', action: () => shareDialog('track', track.id, track.title) }] : []),
      ...(canDownload() ? [{ icon: 'download', label: 'Download…', action: () => downloadDialog('track', track.id, track.title) }] : [])] : []),
    ...(fileMenuItems(tracks).length ? ['sep', ...fileMenuItems(tracks)] : []),
    ...(extra.length ? ['sep', ...extra] : []),
  ]);
}

// ───────── Downloads ─────────

const DOWNLOAD_FORMATS = [
  ['original', 'Original files', 'Exactly as stored (songs from cue sheets are cut out losslessly)'],
  ['mp3-320', 'MP3 · 320 kbps', 'Plays everywhere'],
  ['mp3-192', 'MP3 · 192 kbps', 'Smaller files'],
  ['aac-256', 'AAC · 256 kbps', 'Great for Apple devices'],
  ['opus-160', 'Opus · 160 kbps', 'Smallest at high quality'],
  ['flac', 'FLAC', 'Lossless (lossy originals are kept as they are)'],
];

/** kind: 'track' | 'album' | 'playlist'. Albums and playlists download as a .zip. */
export function downloadDialog(kind, id, name) {
  return modal(html`
    <h3>${ic('download')} Download ${kind === 'track' ? 'song' : kind}</h3>
    <p>${kind === 'track' ? `“${name}”` : html`“${name}” downloads as a .zip file.`} Converted files take a moment to prepare.</p>
    <div class="dl-options">${DOWNLOAD_FORMATS.map(([k, l, d], i) => html`
      <label class="dl-option"><input type="radio" name="fmt" value="${k}" ${i === 0 ? 'checked' : ''}><span><b>${l}</b><span class="muted">${d}</span></span></label>`)}</div>
    <div class="modal-actions"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" data-go>${ic('download')} Download</button></div>`, (box, close) => {
    box.querySelector('[data-go]').addEventListener('click', () => {
      const v = box.querySelector('[name=fmt]:checked').value;
      const [format, bitrate] = v === 'original' ? ['raw'] : v.split('-');
      const a = document.createElement('a');
      a.href = api.downloadUrl(kind, id, { format, bitrate });
      a.download = '';
      document.body.append(a);
      a.click();
      a.remove();
      toast(kind === 'track' ? 'Download starting…' : 'Preparing your .zip, the download starts when it is ready…', { ms: 4000 });
      close(true);
    });
  });
}

export function ratingMenu(at, track) {
  openMenu(at, [
    { head: 'Rate this song' },
    ...[5, 4, 3, 2, 1].map((n) => ({ icon: n === track.rating ? 'check' : 'star', label: '★'.repeat(n) + '☆'.repeat(5 - n), action: () => setRating(track, n) })),
    ...(track.rating ? ['sep', { icon: 'x', label: 'Clear rating', action: () => setRating(track, 0) }] : []),
  ]);
}

/** Linked artist names for a track ("A, B & C" style credits become separate links). */
export const artistLinks = (t) => (t.artists?.length > 1
  ? html`${t.artists.map((a, i) => html`${i ? ', ' : ''}<a href="/artist/${a.id}">${a.name}</a>`)}`
  : html`<a href="/artist/${t.artistId}">${t.artist}</a>`);

const RELEASE_LABEL = { album: 'Album', ep: 'EP', single: 'Single', compilation: 'Compilation', live: 'Live', soundtrack: 'Soundtrack', remix: 'Remix', other: 'Other' };
export const releaseLabel = (type, compilation) => (compilation ? 'Compilation' : RELEASE_LABEL[type] || (type ? type[0].toUpperCase() + type.slice(1) : 'Album'));

const fmtGain = (g) => (g == null ? null : `${g > 0 ? '+' : ''}${g.toFixed(2)} dB`);

export async function trackDetails(track) {
  let t;
  try { t = await api.get(`/tracks/${track.id}`); } catch (err) { toastError(err); return; }
  const rows = [
    ['Title', t.title],
    ['Artists', t.artists.map((a) => a.name).join(', ')],
    ['Album', t.album],
    ['Album artist', t.albumArtists?.map((a) => a.name).join(', ') || t.albumArtist],
    ['Track', t.trackNo ? `${t.trackNo}${t.discNo ? ` · disc ${t.discNo}` : ''}` : null],
    ['Year', t.year ? `${t.year}${t.originalYear && t.originalYear !== t.year ? ` (originally ${t.originalYear})` : ''}` : null],
    ['Release type', t.releaseType || t.compilation ? releaseLabel(t.releaseType, t.compilation) : null],
    ['Genres', t.genres?.join(', ')],
    ['Duration', fmtTime(t.duration)],
    ['Format', [t.format, t.codec].filter(Boolean).join(' · ')],
    ['Playback', t.cue ? `Part of a cue sheet (${fmtTime(t.cueStart)}–${t.cueEnd != null ? fmtTime(t.cueEnd) : 'end'}), cut out by the server` : t.needsTranscode ? 'Converted by the server while playing (browsers can’t play this format)' : null],
    ['Bitrate', t.bitrate ? `${Math.round(t.bitrate / 1000)} kbps` : null],
    ['Sample rate', t.sampleRate ? `${(t.sampleRate / 1000).toFixed(1)} kHz` : null],
    ['Size', t.size ? fmtBytes(t.size) : null],
    ['ReplayGain (track)', [fmtGain(t.rgTrackGain), t.rgTrackPeak ? `peak ${t.rgTrackPeak.toFixed(3)}` : null].filter(Boolean).join(', ') || null],
    ['ReplayGain (album)', [fmtGain(t.rgAlbumGain), t.rgAlbumPeak ? `peak ${t.rgAlbumPeak.toFixed(3)}` : null].filter(Boolean).join(', ') || null],
    ['Your plays', String(t.playCount || 0)],
    ['Last played', t.lastPlayed ? new Date(t.lastPlayed).toLocaleString() : null],
    ['Added', new Date(t.addedAt).toLocaleDateString()],
    ['MusicBrainz', t.mbzTrackId || t.mbzAlbumId ? 'Tagged' : null],
    ['File', t.file],
  ].filter(([, v]) => v);
  modal(html`
    <h3>Track details</h3>
    <div class="stars" data-stars>${[1, 2, 3, 4, 5].map((n) => html`<button class="star ${n <= t.rating ? 'on' : ''}" data-n="${n}" aria-label="${n} stars">${ic(n <= t.rating ? 'starFill' : 'star')}</button>`)}</div>
    <dl class="details">${rows.map(([k, v]) => html`<dt>${k}</dt><dd class="${k === 'File' ? 'mono' : ''}">${v}</dd>`)}</dl>
    <div class="modal-actions"><button class="btn primary" data-close>Close</button></div>`, (box) => {
    box.querySelector('[data-stars]').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-n]');
      if (!b) return;
      const n = Number(b.dataset.n) === track.rating ? 0 : Number(b.dataset.n);
      await setRating(track, n);
      box.querySelectorAll('.star').forEach((s) => {
        const on = Number(s.dataset.n) <= n;
        s.classList.toggle('on', on);
        s.innerHTML = ic(on ? 'starFill' : 'star');
      });
    });
  });
}

export function playlistPicker(at, tracks) {
  const editable = state.playlists.filter((pl) => pl.canEdit !== false);
  if (!state.user.permissions?.playlists) return toast("You don't have permission to edit playlists", { type: 'error' });
  openMenu(at, [
    { head: 'Add to playlist' },
    { icon: 'plus', label: 'New playlist…', action: () => createPlaylist(tracks.map((t) => t.id)) },
    ...(editable.length ? ['sep'] : []),
    ...editable.map((pl) => ({ icon: pl.owned === false ? 'users' : 'listMusic', label: pl.owned === false ? `${pl.name} (${pl.owner})` : pl.name, action: () => addToPlaylist(pl, tracks) })),
  ]);
}

// ───────── Share links ─────────

export const canShare = () => !!state.user.permissions?.share && state.sharing !== false;
export const canDownload = () => !!state.user.permissions?.download;

const EXPIRY = [[1, '1 day'], [7, '1 week'], [30, '30 days'], [365, '1 year'], [0, 'Never']];

/** kind: 'track' | 'album' | 'playlist'. Creates a public link anyone can open without an account. */
export function shareDialog(kind, id, name) {
  return modal(html`
    <h3>${ic('share')} Share ${kind === 'track' ? 'song' : kind}</h3>
    <p>Anyone with the link can listen to “${name}”, without an account.${kind === 'playlist' ? ' It shows the playlist as it is when they open it.' : ''}</p>
    <div class="share-form">
      <label class="muted">Link expires after</label>
      <div class="seg2" data-exp>${EXPIRY.map(([d, l]) => html`<button type="button" class="seg-btn ${d === 7 ? 'on' : ''}" data-days="${d}">${l}</button>`)}</div>
      ${canDownload() ? html`<label class="check" style="margin-top:12px"><input type="checkbox" data-dl><span class="sw"></span>Allow downloading</label>` : ''}
    </div>
    <div class="share-result" hidden>
      <div class="copy-row"><input class="input mono" readonly data-url><button class="btn sm primary" data-copy>${ic('copy')} Copy</button></div>
      <p class="muted" data-exp-note style="margin-top:8px"></p>
    </div>
    <div class="form-error"></div>
    <div class="modal-actions"><button class="btn ghost" data-close>Close</button><button class="btn primary" data-create>${ic('link')} Create link</button></div>`, (box) => {
    let days = 7;
    box.querySelector('[data-exp]').addEventListener('click', (e) => {
      const b = e.target.closest('[data-days]');
      if (!b) return;
      days = Number(b.dataset.days);
      box.querySelectorAll('[data-days]').forEach((x) => x.classList.toggle('on', x === b));
    });
    const create = box.querySelector('[data-create]');
    create.addEventListener('click', async () => {
      create.disabled = true;
      try {
        const s = await api.post('/shares', { kind, id, expiresInDays: days, allowDownload: !!box.querySelector('[data-dl]')?.checked });
        box.querySelector('.share-form').hidden = true;
        box.querySelector('.share-result').hidden = false;
        box.querySelector('[data-url]').value = s.url;
        box.querySelector('[data-exp-note]').textContent = s.expiresAt ? `Expires ${new Date(s.expiresAt).toLocaleString()}. Manage your links in Settings.` : 'Never expires. Manage your links in Settings.';
        create.hidden = true;
        copyText(s.url);
      } catch (err) {
        box.querySelector('.form-error').textContent = err.message;
        create.disabled = false;
      }
    });
    box.querySelector('[data-copy]').addEventListener('click', () => copyText(box.querySelector('[data-url]').value));
  });
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Link copied', { type: 'success', ms: 1600 });
  } catch {
    // Clipboard API needs HTTPS; fall back to a selection copy.
    const t = el(html`<textarea style="position:fixed;opacity:0">${text}</textarea>`);
    document.body.append(t);
    t.select();
    const ok = document.execCommand('copy');
    t.remove();
    toast(ok ? 'Link copied' : 'Copy the link from the box', { type: ok ? 'success' : 'info', ms: 2000 });
  }
}

// ───────── Track list ─────────

/**
 * opts: { cover, album, numbered, discs, compact, playlist: { id, onRemove, onReorder }, head }
 * Returns { el, add(tracks), tracks }.
 */
export function trackList(initial = [], opts = {}) {
  const list = el(html`<div class="tracklist ${opts.album === false ? 'compact' : ''}">
    ${opts.head !== false ? html`<div class="tl-head"><span>#</span><span>Title</span>${opts.album !== false ? html`<span class="h-album">Album</span>` : ''}<span class="r h-dur">${ic('clock')}</span><span></span></div>` : ''}
    <div class="tl-body"></div></div>`);
  const body = list.querySelector('.tl-body');
  const tracks = [];
  let lastDisc = null;
  const multiDisc = opts.discs && new Set(initial.map((t) => t.discNo || 1)).size > 1;

  const row = (t, i) => {
    const num = opts.numbered ? t.trackNo || i + 1 : i + 1;
    const cur = player.current?.id === t.id;
    return html`
      <div class="tl-row ${cur ? 'is-current' : ''}" data-i="${i}" data-track-id="${t.id}" style="--i:${i % 40}" ${opts.playlist ? 'draggable="true"' : ''}>
        <div class="tl-num"><span class="n">${num}</span><span class="eq"><i></i><i></i><i></i><i></i></span>
          <button class="tl-play" data-act="play" aria-label="Play">${ic('play')}</button></div>
        <div class="tl-main">
          ${opts.cover !== false ? html`<div class="tl-cover">${art(t.cover, t.album)}</div>` : ''}
          <div class="tl-text">
            <div class="tl-title">${t.title}${t.lossless ? html`<span class="badge">${(t.codec || 'LOSSLESS').split(' ')[0]}</span>` : ''}</div>
            <div class="tl-sub">${t.rating ? html`<span class="tl-rating" data-rating="${t.id}">${'★'.repeat(t.rating)}</span>` : html`<span class="tl-rating" data-rating="${t.id}"></span>`}${artistLinks(t)}</div>
          </div>
        </div>
        ${opts.album !== false ? html`<div class="tl-album"><a href="/album/${t.albumId}">${t.album}</a></div>` : ''}
        <div class="tl-dur r">${fmtTime(t.duration)}</div>
        <div class="tl-actions">
          <button class="icon-btn sm heart ${t.favorite ? 'on' : ''}" data-act="fav" data-fav="${t.id}" aria-label="Favorite">${ic(t.favorite ? 'heartFill' : 'heart')}</button>
          <button class="icon-btn sm" data-act="more" aria-label="More">${ic('more')}</button>
        </div>
      </div>`;
  };

  const add = (more) => {
    const frag = document.createDocumentFragment();
    for (const t of more) {
      const i = tracks.length;
      tracks.push(t);
      if (multiDisc && (t.discNo || 1) !== lastDisc) {
        lastDisc = t.discNo || 1;
        frag.append(el(html`<div class="disc-head">${ic('disc')} Disc ${lastDisc}</div>`));
      }
      frag.append(el(row(t, i)));
    }
    body.append(frag);
  };
  add(initial);

  const play = (i) => player.playList(opts.queue?.() || tracks, i);
  const hoverless = matchMedia('(hover: none)');

  body.addEventListener('click', (e) => {
    const r = e.target.closest('.tl-row');
    if (!r || e.target.closest('a')) return;
    const i = Number(r.dataset.i);
    const act = e.target.closest('[data-act]')?.dataset.act;
    const t = tracks[i];
    t.favorite = r.querySelector('.heart').classList.contains('on'); // stay in sync with other lists
    if (act === 'play') return play(i);
    if (act === 'fav') return toggleFavorite(t);
    if (act === 'more') return trackMenu(e.target.closest('[data-act]'), t, { extra: extraItems(t) });
    if (hoverless.matches) return play(i);
    body.querySelectorAll('.tl-row.selected').forEach((x) => x.classList.remove('selected'));
    r.classList.add('selected');
  });
  body.addEventListener('dblclick', (e) => {
    const r = e.target.closest('.tl-row');
    if (r && !e.target.closest('button, a')) play(Number(r.dataset.i));
  });
  body.addEventListener('contextmenu', (e) => {
    const r = e.target.closest('.tl-row');
    if (!r) return;
    e.preventDefault();
    const t = tracks[Number(r.dataset.i)];
    trackMenu(e, t, { extra: extraItems(t) });
  });

  const extraItems = (t) => opts.playlist
    ? [{ icon: 'trash', label: 'Remove from playlist', danger: true, action: () => opts.playlist.onRemove(t) }]
    : [];

  if (opts.playlist?.onReorder) {
    dragSort(body, '.tl-row', (from, to) => {
      const [t] = tracks.splice(from, 1);
      tracks.splice(to, 0, t);
      opts.playlist.onReorder(tracks);
    });
  }

  return { el: list, add, tracks };
}

// Keep hearts in sync everywhere.
bus.on('favorite', (id, on) => {
  document.querySelectorAll(`[data-fav="${id}"]`).forEach((b) => {
    b.classList.toggle('on', on);
    b.innerHTML = ic(on ? 'heartFill' : 'heart');
    b.classList.remove('pop');
    void b.offsetWidth;
    b.classList.add('pop');
  });
});

bus.on('rating', (id, n) => {
  document.querySelectorAll(`[data-rating="${id}"]`).forEach((s) => { s.textContent = '★'.repeat(n); });
});

// Highlight the current track in any visible list.
player.on('track', (t) => {
  document.querySelectorAll('.tl-row.is-current').forEach((r) => r.classList.remove('is-current'));
  if (t) document.querySelectorAll(`.tl-row[data-track-id="${t.id}"]`).forEach((r) => r.classList.add('is-current'));
});
