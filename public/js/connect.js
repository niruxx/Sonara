// Sonara Connect (client): this tab reports what it plays, obeys commands from
// your other devices, can remote-control them (and the server speakers / DLNA
// speakers), hand playback over, cast to a Chromecast, and follow a listening party.
import { api } from './api.js';
import { Emitter, shuffleArray } from './util.js';
import { player, deviceId, deviceName } from './player.js';
import { toast, toastError } from './ui.js';

const tabId = (() => {
  let t = sessionStorage.getItem('sonara.tab');
  if (!t) { t = Math.random().toString(36).slice(2, 7); sessionStorage.setItem('sonara.tab', t); }
  return t;
})();
export const clientId = `${deviceId}-${tabId}`;

export const connect = new Emitter();
connect.devices = [];
connect.party = null; // { id, host, hostClient, members, state } while hosting or in a party
connect.connected = false;

let es = null;
let lastSent = 0;
let sendTimer = null;

const trackInfo = (t) => t && {
  id: t.id, title: t.title, artist: t.artist, album: t.album, albumId: t.albumId, artistId: t.artistId,
  cover: t.cover, duration: t.duration, artists: t.artists,
};

// ───────── Reporting our state ─────────

function localState() {
  const local = player.local;
  return {
    playing: local.playing, time: local.time, duration: local.duration, volume: player.remote ? player.localVolume : player.volume,
    track: trackInfo(local.current), index: local.index, queueLength: local.queueLength, shuffle: player.shuffle, repeat: player.repeat,
  };
}

function report(now = false) {
  if (!connect.connected) return;
  clearTimeout(sendTimer);
  const go = () => {
    lastSent = Date.now();
    fetch('/api/connect/state', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: clientId, state: localState() }),
    }).catch(() => {});
  };
  const wait = now ? 0 : Math.max(0, 800 - (Date.now() - lastSent));
  sendTimer = setTimeout(go, wait);
}

// ───────── Obeying commands ─────────

async function lookup(ids) {
  const found = await api.post('/tracks/lookup', { ids });
  return found.filter(Boolean);
}

async function onCommand({ cmd, args = {} }) {
  if (player.remote) player.leaveRemote({ quiet: true });
  switch (cmd) {
    case 'play': return player.play();
    case 'pause': return player.pause();
    case 'toggle': return player.toggle();
    case 'next': return player.next();
    case 'prev': return player.prev();
    case 'seek': return player.seek(Number(args.time) || 0);
    case 'volume': return player.setVolume(Number(args.value));
    case 'jump': return player.jump(Number(args.index));
    case 'shuffle': return player.toggleShuffle();
    case 'repeat': while (player.repeat !== args.value && ['off', 'all', 'one'].includes(args.value)) player.cycleRepeat(); return;
    case 'stop': player.pause(); return;
    case 'playTracks': {
      const tracks = await lookup(args.ids || []);
      if (!tracks.length) return toast("Couldn't find those songs in your library", { type: 'error' });
      const index = Math.min(Math.max(0, Number(args.index) || 0), tracks.length - 1);
      if (['off', 'all', 'one'].includes(args.repeat)) player.repeat = args.repeat;
      player.playList(tracks, index, { time: Number(args.time) || 0 });
      if (args.from) toast(`Playing here, moved from ${args.from}`);
      return;
    }
    case 'handoff': {
      // Another device asked to take over what we're playing.
      const ids = player.queue.map((t) => t.id);
      if (!ids.length) return;
      await api.post('/connect/command', { target: args.to, cmd: 'playTracks', args: { ids, index: player.index, time: player.time, repeat: player.repeat, from: deviceName() } });
      player.pause();
      return;
    }
    default:
  }
}

// ───────── Remote targets ─────────

/** A device controlled through the server (another tab, the jukebox, a DLNA speaker). */
function serverTarget(dev) {
  return {
    id: dev.id, name: dev.name, kind: dev.kind, state: dev.state || null,
    send: (cmd, args = {}) => api.post('/connect/command', { target: dev.id, cmd, args, from: clientId }).catch((err) => { toastError(err); throw err; }),
  };
}

/** Make another device play our queue from where we are, then control it from here. */
export async function moveTo(dev) {
  try {
    if (player.remote?.id === dev.id) return;
    const wasRemote = player.remote;
    const src = wasRemote ? null : player.local;
    if (src && src.current) {
      const ids = player.queue.map((t) => t.id);
      await api.post('/connect/command', { target: dev.id, cmd: 'playTracks', args: { ids, index: player.index, time: player.time, repeat: player.repeat, from: deviceName() } });
      player.pause();
    }
    controlDevice(dev);
  } catch (err) { toastError(err); }
}

export function controlDevice(dev) {
  const target = dev.kind === 'cast' ? dev : serverTarget(dev);
  player.enterRemote(target);
  toast(`Controlling ${dev.name}`);
}

/** Bring playback back to this tab (pulling the queue from a browser device when we can). */
export async function playHere() {
  const r = player.remote;
  if (!r) return;
  const s = r.state;
  player.leaveRemote({ quiet: true });
  try {
    if (r.kind === 'browser') {
      await api.post('/connect/command', { target: r.id, cmd: 'handoff', args: { to: clientId } });
    } else if (s?.track) {
      const time = s.playing ? s.time + (Date.now() - (r.receivedAt || Date.now())) / 1000 : s.time;
      await r.send('pause').catch(() => {});
      if (r.kind === 'cast') r.stop?.();
      const [t] = await lookup([s.track.id]);
      if (t) player.playList([t], 0, { time });
    }
  } catch (err) { toastError(err); }
}

// ───────── Chromecast (Google Cast Web Sender) ─────────

let castReady = null;
export const castSupported = () => !!window.chrome && window.isSecureContext && /Chrome|Edg/.test(navigator.userAgent);

function loadCast() {
  if (castReady) return castReady;
  castReady = new Promise((resolve, reject) => {
    window.__onGCastApiAvailable = (ok) => {
      if (!ok) return reject(new Error('Casting is not available in this browser'));
      const ctx = cast.framework.CastContext.getInstance();
      ctx.setOptions({ receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID, autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED });
      resolve(ctx);
    };
    const s = document.createElement('script');
    s.src = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
    s.onerror = () => reject(new Error("Couldn't load the Cast library (are you offline?)"));
    document.head.append(s);
    setTimeout(() => reject(new Error('Casting took too long to start')), 15000);
  });
  castReady.catch(() => { castReady = null; });
  return castReady;
}

export async function startCast() {
  try {
    const ctx = await loadCast();
    await ctx.requestSession();
    const session = ctx.getCurrentSession();
    if (!session) return;
    const rp = new cast.framework.RemotePlayer();
    const rc = new cast.framework.RemotePlayerController(rp);
    const queue = player.queue.slice();
    let index = player.index;
    const startTime = player.time;
    player.pause();
    const target = {
      id: 'cast', name: session.getCastDevice().friendlyName || 'Chromecast', kind: 'cast', state: null,
      async load(i, time = 0) {
        index = i;
        const t = queue[i];
        if (!t) return;
        const u = await api.post('/connect/cast-url', { trackId: t.id });
        const info = new chrome.cast.media.MediaInfo(u.url, u.contentType);
        info.metadata = new chrome.cast.media.MusicTrackMediaMetadata();
        Object.assign(info.metadata, { title: t.title, artist: t.artist, albumName: t.album, images: u.cover ? [new chrome.cast.Image(u.cover)] : [] });
        const req = new chrome.cast.media.LoadRequest(info);
        req.currentTime = time;
        await session.loadMedia(req);
        this.push();
      },
      push() {
        const t = queue[index];
        this.state = { playing: !rp.isPaused && rp.playerState !== 'IDLE', time: rp.currentTime || 0, duration: rp.duration || t?.duration || 0, volume: rp.volumeLevel ?? 1, track: trackInfo(t), index, queueLength: queue.length };
        player.remoteState(this.state);
      },
      async send(cmd, args = {}) {
        if (cmd === 'toggle' || cmd === 'play' || cmd === 'pause') {
          if ((cmd === 'play' && !rp.isPaused) || (cmd === 'pause' && rp.isPaused)) return;
          rc.playOrPause();
        } else if (cmd === 'next') await this.load((index + 1) % queue.length);
        else if (cmd === 'prev') await (rp.currentTime > 3 || index === 0 ? this.send('seek', { time: 0 }) : this.load(index - 1));
        else if (cmd === 'seek') { rp.currentTime = Number(args.time) || 0; rc.seek(); }
        else if (cmd === 'volume') { rp.volumeLevel = Number(args.value); rc.setVolumeLevel(); }
        else if (cmd === 'jump') await this.load(Number(args.index));
        else if (cmd === 'playTracks') {
          const tracks = await lookup(args.ids || []);
          queue.splice(0, queue.length, ...tracks);
          await this.load(Number(args.index) || 0, Number(args.time) || 0);
        }
      },
      stop() { try { ctx.endCurrentSession(true); } catch { /* ignore */ } },
    };
    let ending = false;
    rc.addEventListener(cast.framework.RemotePlayerEventType.ANY_CHANGE, (e) => {
      if (e.field === 'isConnected' && !rp.isConnected) {
        if (player.remote === target) player.leaveRemote();
        return;
      }
      if (e.field === 'playerState' && rp.playerState === 'IDLE' && !ending) {
        const ms = session.getMediaSession();
        if (ms?.idleReason === 'FINISHED' && index < queue.length - 1) { ending = true; target.load(index + 1).finally(() => { ending = false; }); }
      }
      if (['currentTime', 'isPaused', 'playerState', 'volumeLevel', 'duration'].includes(e.field)) target.push();
    });
    player.enterRemote(target);
    await target.load(index, startTime);
    toast(`Casting to ${target.name}`);
  } catch (err) {
    if (err?.code === 'cancel' || err === 'cancel') return;
    toastError(err?.description || err);
  }
}

// ───────── Listening parties ─────────

let follow = { receivedAt: 0, busy: false };

async function followParty(state) {
  if (!state || !connect.party || connect.party.hostClient === clientId || player.remote) return;
  follow.receivedAt = performance.now();
  if (follow.busy) return;
  follow.busy = true;
  try {
    const expected = state.playing ? state.time + 0.25 : state.time;
    if (!state.track) return;
    if (player.local.current?.id !== state.track.id) {
      const [t] = await lookup([state.track.id]);
      if (!t) { toast(`“${state.track.title}” isn't in your library`, { type: 'error' }); return; }
      const lag = (performance.now() - follow.receivedAt) / 1000;
      player.playList([t], 0, { time: expected + (state.playing ? lag : 0), autoplay: state.playing });
      return;
    }
    if (state.playing && !player.playing) player.play();
    if (!state.playing && player.playing) player.pause();
    if (Math.abs(player.time - expected) > 2.5) player.seek(expected);
  } finally { follow.busy = false; }
}

export async function startParty() {
  try {
    connect.party = await api.post('/party', { device: clientId });
    connect.emit('party', connect.party);
    report(true);
    return connect.party;
  } catch (err) { toastError(err); return null; }
}

export async function joinParty(id) {
  try {
    for (let i = 0; i < 20 && !connect.connected; i++) await new Promise((r) => setTimeout(r, 250));
    if (player.remote) player.leaveRemote({ quiet: true });
    connect.party = await api.post(`/party/${id}/join`, { device: clientId });
    connect.emit('party', connect.party);
    toast(`Joined ${connect.party.host}'s listening party`, { type: 'success' });
    followParty(connect.party.state);
  } catch (err) { toastError(err); }
}

export async function leaveParty({ end = false } = {}) {
  const p = connect.party;
  if (!p) return;
  connect.party = null;
  connect.emit('party', null);
  await api.post(`/party/${p.id}/leave`, { device: clientId, end }).catch(() => {});
}

export const partyUrl = (p) => `${location.origin}/party/${p.id}`;

// ───────── Connection ─────────

export function startConnect() {
  if (es) return;
  const open = () => {
    es = new EventSource(`/api/connect/events?device=${encodeURIComponent(clientId)}&name=${encodeURIComponent(deviceName())}`);
    es.addEventListener('hello', () => { connect.connected = true; report(true); connect.emit('status', true); });
    es.addEventListener('devices', (e) => {
      connect.devices = JSON.parse(e.data).filter((d) => d.id !== clientId);
      // The device we were controlling went away.
      if (player.remote && player.remote.kind !== 'cast' && !connect.devices.some((d) => d.id === player.remote.id)) {
        player.leaveRemote();
        toast('The device you were controlling disconnected');
      }
      connect.emit('devices', connect.devices);
    });
    es.addEventListener('state', (e) => {
      const { device, state } = JSON.parse(e.data);
      const d = connect.devices.find((x) => x.id === device);
      if (d) d.state = state;
      if (player.remote?.id === device) player.remoteState(state);
      connect.emit('devices', connect.devices);
    });
    es.addEventListener('command', (e) => onCommand(JSON.parse(e.data)).catch(toastError));
    es.addEventListener('party', (e) => {
      const p = JSON.parse(e.data);
      if (p.ended) {
        if (connect.party?.id === p.id) {
          connect.party = null;
          connect.emit('party', null);
          if (p.hostClient !== clientId) toast('The listening party has ended');
        }
        return;
      }
      connect.party = p;
      connect.emit('party', p);
    });
    es.addEventListener('party-state', (e) => {
      const { id, state } = JSON.parse(e.data);
      if (connect.party?.id !== id) return;
      connect.party.state = state;
      followParty(state);
    });
    es.onerror = () => { connect.connected = false; connect.emit('status', false); };
  };
  open();
  for (const ev of ['track', 'state', 'volume', 'mode']) player.on(ev, () => report());
  player.on('queue', () => report());
  // While playing, refresh the position now and then (more often when hosting a party).
  setInterval(() => {
    if (player.local.playing && Date.now() - lastSent > (connect.party?.hostClient === clientId ? 4000 : 10000)) report(true);
  }, 1000);
  addEventListener('pagehide', () => { if (connect.party?.hostClient === clientId) leaveParty({ end: true }); });
}

/** Shuffle helper for playing a list on a remote device. */
export const shuffledIds = (tracks, start) => {
  const first = tracks[start] || tracks[0];
  return [first, ...shuffleArray(tracks.filter((t) => t !== first))].map((t) => t.id);
};

