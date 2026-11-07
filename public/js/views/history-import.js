// Settings panel: import listening history from Last.fm, ListenBrainz or a Spotify data export.
import { api } from '../api.js';
import { html, ic } from '../util.js';
import { toast, toastError, formDialog } from '../ui.js';
import { t } from '../i18n.js';

export const historyPanel = () => html`
  <section class="panel" style="--i:6" data-panel="history">
    <h3>${ic('clock')} ${t('Import listening history')}</h3>
    <p>${t('Bring your plays from other services, so stats, “Rediscover” and mixes know your taste from day one. Songs are matched to your library by artist and title.')}</p>
    <div class="row-gap">
      <button class="btn sm" data-hist="lastfm">${t('From Last.fm…')}</button>
      <button class="btn sm" data-hist="listenbrainz">${t('From ListenBrainz…')}</button>
      <label class="btn sm">${t('From a Spotify export…')}<input type="file" accept=".json,application/json" multiple hidden data-hist-spotify></label>
    </div>
    <p class="muted" style="font-size:12px;margin-top:10px">${t('Spotify: request your data at spotify.com/account/privacy, then choose the StreamingHistory*.json (or Streaming_History_Audio_*.json) files. They are read in this browser.')}</p>
    <div data-hist-status aria-live="polite"></div>
  </section>`;

/** Read a Spotify export file into { title, artist, album, at } listens (skips under 30 s). */
function spotifyListens(text) {
  const rows = JSON.parse(text);
  if (!Array.isArray(rows)) throw new Error(t('Unexpected file: expected a list of streams'));
  return rows.map((r) => {
    const ms = r.ms_played ?? r.msPlayed ?? 0;
    if (ms < 30000) return null;
    const end = r.ts ? Date.parse(r.ts) : r.endTime ? Date.parse(`${r.endTime.replace(' ', 'T')}Z`) : NaN;
    const title = r.master_metadata_track_name ?? r.trackName;
    if (!title || !Number.isFinite(end)) return null;
    return { title, artist: r.master_metadata_album_artist_name ?? r.artistName, album: r.master_metadata_album_album_name || null, at: end - ms };
  }).filter(Boolean);
}

export function bindHistory(v) {
  const panel = v.querySelector('[data-panel="history"]');
  if (!panel) return;
  const status = panel.querySelector('[data-hist-status]');
  const show = (j) => {
    if (!j || j.state === 'idle') { status.innerHTML = ''; return; }
    const running = j.state === 'running';
    status.innerHTML = String(html`<div class="list-row" style="margin-top:12px">${ic(running ? 'refresh' : j.state === 'error' ? 'alert' : 'check')}
      <span class="grow">${j.source}: ${running ? t('importing…') : j.state === 'error' ? j.error : t('done')}<br>
        <span class="muted">${t('{read} listens read · {added} added · {skipped} already there · {missing} not in your library', { read: j.fetched, added: j.added, skipped: j.skipped, missing: j.unmatched })}</span></span>
      ${running ? html`<button class="btn sm ghost" data-hist-stop>${t('Stop')}</button>` : ''}</div>`);
    status.querySelector('[data-hist-stop]')?.addEventListener('click', () => api.del('/me/history'));
  };
  let timer = null;
  const poll = async () => {
    clearTimeout(timer);
    const j = await api.get('/me/history').catch(() => null);
    show(j);
    if (j?.state === 'running' && panel.isConnected) timer = setTimeout(poll, 1500);
  };
  poll();

  panel.querySelectorAll('[data-hist]').forEach((b) => b.addEventListener('click', async () => {
    const svc = b.dataset.hist;
    const v2 = await formDialog({ title: svc === 'lastfm' ? t('Import from Last.fm') : t('Import from ListenBrainz'), fields: [{ name: 'username', label: t('Your username') }], confirm: t('Import') });
    if (!v2?.username?.trim()) return;
    try { show(await api.post(`/me/history/${svc}`, { username: v2.username.trim() })); poll(); } catch (err) { toastError(err); }
  }));

  panel.querySelector('[data-hist-spotify]').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (!files.length) return;
    const total = { source: 'Spotify', state: 'running', fetched: 0, matched: 0, unmatched: 0, added: 0, skipped: 0 };
    try {
      for (const f of files) {
        const listens = spotifyListens(await f.text());
        for (let i = 0; i < listens.length; i += 5000) {
          const r = await api.post('/me/history/listens', { listens: listens.slice(i, i + 5000) });
          for (const k of ['fetched', 'matched', 'unmatched', 'added', 'skipped']) total[k] += r[k];
          show(total);
        }
      }
      total.state = 'done';
      show(total);
      toast(t('Imported {n} plays', { n: total.added }), { type: 'success' });
    } catch (err) { total.state = 'error'; total.error = err.message; show(total); }
  });
}
