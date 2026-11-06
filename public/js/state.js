// Shared app state + actions used across views.
import { api } from './api.js';
import { Emitter } from './util.js';
import { player } from './player.js';
import { toast, toastError, formDialog } from './ui.js';

export const bus = new Emitter();
export const state = { user: null, playlists: [] };

export async function refreshPlaylists() {
  try {
    state.playlists = await api.get('/playlists');
    bus.emit('playlists', state.playlists);
  } catch { /* signed out */ }
}

export async function toggleFavorite(track) {
  const next = !track.favorite;
  try {
    await (next ? api.put(`/favorites/${track.id}`) : api.del(`/favorites/${track.id}`));
    track.favorite = next;
    player.patchTrack(track.id, { favorite: next });
    bus.emit('favorite', track.id, next);
    if (next) toast('Added to Favorites', { type: 'success', ms: 1600 });
  } catch (err) { toastError(err); }
}

export async function createPlaylist(trackIds = []) {
  const v = await formDialog({
    title: 'New playlist',
    fields: [{ name: 'name', label: 'Name' }, { name: 'description', label: 'Description (optional)', textarea: true }],
    confirm: 'Create',
    validate: (v) => (v.name.trim() ? null : 'Give your playlist a name'),
  });
  if (!v) return null;
  try {
    const pl = await api.post('/playlists', { ...v, trackIds });
    await refreshPlaylists();
    toast(`Created “${pl.name}”`, { type: 'success' });
    return pl;
  } catch (err) { toastError(err); return null; }
}

export async function addToPlaylist(pl, tracks) {
  try {
    await api.post(`/playlists/${pl.id}/tracks`, { trackIds: tracks.map((t) => t.id) });
    toast(`Added ${tracks.length === 1 ? `“${tracks[0].title}”` : `${tracks.length} songs`} to ${pl.name}`, { type: 'success' });
    refreshPlaylists();
    bus.emit('playlist-changed', pl.id);
  } catch (err) { toastError(err); }
}
