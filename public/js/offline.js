// Offline music: save albums and playlists to this device (Cache Storage),
// played back by the service worker (/sw.js) without a connection.
import { api } from './api.js';
import { prefs, plural, fmtBytes } from './util.js';
import { toast, toastError } from './ui.js';
import { Emitter } from './util.js';
import { t } from './i18n.js';

const CACHE = 'sonara-offline';
export const offline = new Emitter();
const supported = 'serviceWorker' in navigator && 'caches' in window && window.isSecureContext;
export const offlineSupported = () => supported;

const index = () => prefs.get('offline', {});
const saveIndex = (i) => { prefs.set('offline', i); offline.emit('change', i); };
const key = (kind, id) => `${kind}:${id}`;
export const offlineList = () => Object.values(index()).sort((a, b) => b.savedAt - a.savedAt);
export const isOffline = (kind, id) => !!index()[key(kind, id)];
const busy = new Set();

export function registerServiceWorker() {
  if (!supported) return;
  navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('Service worker failed', err));
}

/** Track ids still needed by some saved collection (so shared songs aren't deleted twice). */
function keptIds(except) {
  const ids = new Set();
  for (const [k, v] of Object.entries(index())) if (k !== except) v.trackIds.forEach((t) => ids.add(t));
  return ids;
}

export async function saveOffline(kind, id, name, tracks, cover) {
  if (!supported) return toast(t('Offline music needs Sonara to be opened over HTTPS (or on localhost)'), { type: 'error', ms: 5000 });
  const k = key(kind, id);
  if (busy.has(k)) return;
  busy.add(k);
  try {
    await navigator.storage?.persist?.().catch(() => {});
    const cache = await caches.open(CACHE);
    let bytes = 0;
    let done = 0;
    toast(t('Saving “{name}” for offline ({songs})…', { name, songs: plural(tracks.length, 'song') }), { ms: 3000 });
    for (const t of tracks) {
      const k2 = `/offline/track/${t.id}`;
      const have = await cache.match(k2);
      if (have) { bytes += Number(have.headers.get('Content-Length')) || 0; done++; continue; }
      // wait=1: converted streams are sent complete, so the saved copy is the whole song.
      const res = await fetch(api.streamUrl(t.id, { wait: 1 }), { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`Couldn't download “${t.title}”`);
      const blob = await res.blob();
      bytes += blob.size;
      await cache.put(k2, new Response(blob, { headers: { 'Content-Type': res.headers.get('Content-Type') || blob.type || 'audio/mpeg', 'Content-Length': String(blob.size) } }));
      done++;
      offline.emit('progress', { key: k, done, total: tracks.length });
    }
    // Keep the pages and art needed to browse it offline.
    await Promise.all([
      fetch(`/api/${kind === 'album' ? 'albums' : 'playlists'}/${encodeURIComponent(id)}`, { credentials: 'same-origin' }).catch(() => {}),
      ...[...new Set(tracks.map((t) => t.cover).filter(Boolean))].map((c) => fetch(`/api/cover/${c}`).catch(() => {})),
    ]);
    const i = index();
    i[k] = { key: k, kind, id, name, cover: cover || tracks.find((t) => t.cover)?.cover || null, trackIds: tracks.map((t) => t.id), bytes, savedAt: Date.now() };
    saveIndex(i);
    toast(t('“{name}” is available offline ({size})', { name, size: fmtBytes(bytes) }), { type: 'success' });
  } catch (err) {
    toastError(err);
  } finally { busy.delete(k); }
}

export async function removeOffline(kind, id) {
  const k = key(kind, id);
  const entry = index()[k];
  if (!entry) return;
  const keep = keptIds(k);
  const cache = await caches.open(CACHE);
  for (const t of entry.trackIds) if (!keep.has(t)) await cache.delete(`/offline/track/${t}`);
  const i = index();
  delete i[k];
  saveIndex(i);
  toast(t('Removed “{name}” from this device', { name: entry.name }));
}

export async function clearOffline() {
  await caches.delete(CACHE);
  saveIndex({});
}

/** Menu items for an album or playlist. */
export function offlineItems(kind, id, name, tracks, cover) {
  if (!supported || !tracks?.length) return [];
  return isOffline(kind, id)
    ? [{ icon: 'check', label: t('Saved on this device · remove'), action: () => removeOffline(kind, id) }]
    : [{ icon: 'download', label: t('Make available offline'), action: () => saveOffline(kind, id, name, tracks, cover) }];
}

export async function storageInfo() {
  const est = await navigator.storage?.estimate?.().catch(() => null);
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  return { usage: est?.usage || 0, quota: est?.quota || 0, persisted: !!persisted };
}

addEventListener('online', () => document.body.classList.remove('is-offline'));
addEventListener('offline', () => { document.body.classList.add('is-offline'); toast("You're offline. Songs saved on this device still play."); });
if (!navigator.onLine) document.body.classList.add('is-offline');
