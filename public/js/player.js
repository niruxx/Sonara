// Audio engine: queue management, shuffle/repeat, gapless playback and
// crossfade (two alternating <audio> "decks"), ReplayGain, playback speed,
// sleep timer, persistence (locally and on the server, so playback can resume
// on another device), Media Session, and a Web Audio analyser for the visualizers.
import { api } from './api.js';
import { Emitter, shuffleArray, prefs, coverUrl } from './util.js';
import { toast } from './ui.js';
import { t } from './i18n.js';

const MAX_PERSIST = 2000;
const PRELOAD_BEFORE_END = 30;   // seconds before the end to start buffering the next track
const GAPLESS_LEAD = 0.3;        // seconds before the end to schedule the gapless hand-over
const SERVER_SYNC_MS = 15000;    // how often to push the playback position while playing
const SLEEP_FADE = 8;            // seconds of fade-out when the sleep timer fires

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const PROGRESS_MS = 10000;       // how often to save a podcast episode's position while playing
const ON_AIR_MS = 15000;         // how often to ask what song a radio station is playing

/** Library songs have numeric ids; podcast episodes and radio stations bring their own stream address. */
const isLib = (t) => !!t && typeof t.id === 'number';
const srcFor = (t, extra) => (t.src ? t.src : api.streamUrl(t.id, extra));

// ───────── Equalizer ─────────
export const EQ_BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export const EQ_PRESETS = {
  flat: { name: 'Flat', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  bass: { name: 'Bass boost', gains: [6, 5, 4, 2, 0.5, 0, 0, 0, 0, 0] },
  bassCut: { name: 'Bass reducer', gains: [-6, -5, -4, -2, -0.5, 0, 0, 0, 0, 0] },
  treble: { name: 'Treble boost', gains: [0, 0, 0, 0, 0, 0.5, 2, 4, 5, 6] },
  vocal: { name: 'Vocal', gains: [-2, -2, -1, 1, 3, 4, 3, 1, 0, -1] },
  rock: { name: 'Rock', gains: [5, 4, 2, -1, -2, -1, 1, 3, 4, 5] },
  pop: { name: 'Pop', gains: [-1, 0, 2, 3, 4, 3, 1, 0, -1, -1] },
  electronic: { name: 'Electronic', gains: [5, 4, 1, 0, -2, 1, 0, 1, 4, 5] },
  jazz: { name: 'Jazz', gains: [3, 2, 1, 2, -1, -1, 0, 1, 2, 3] },
  classical: { name: 'Classical', gains: [4, 3, 2, 1, -1, -1, 0, 2, 3, 4] },
  acoustic: { name: 'Acoustic', gains: [4, 3, 2, 1, 1, 1, 2, 3, 2, 1] },
  loudness: { name: 'Loudness', gains: [6, 4, 0, 0, -2, 0, -1, -3, 4, 2] },
  spoken: { name: 'Spoken word', gains: [-4, -3, -1, 1, 3, 4, 4, 2, 0, -3] },
  night: { name: 'Late night', gains: [-3, -2, 0, 1, 2, 2, 1, 0, -2, -4] },
};

/** Equalizer settings, stored per browser. */
export const eq = {
  get enabled() { return !!prefs.get('eqOn', false); },
  get gains() {
    const g = prefs.get('eqGains', null);
    return Array.isArray(g) && g.length === EQ_BANDS.length ? g.map((x) => clamp(Number(x) || 0, -12, 12)) : EQ_PRESETS.flat.gains.slice();
  },
  get preset() { return prefs.get('eqPreset', 'flat'); }, // a key of EQ_PRESETS, or 'custom'
  get preamp() { return clamp(Number(prefs.get('eqPreamp', 0)) || 0, -12, 12); },
  get autoHeadroom() { return prefs.get('eqHeadroom', true); },
};

/** Sound processing beyond the EQ, stored per browser (see sound.js for the editor). */
export const HP_SLOTS = 16;
export const sound = {
  get nightMode() { return !!prefs.get('nightMode', false); },   // dynamic range compression
  get mono() { return !!prefs.get('mono', false); },
  get balance() { return clamp(Number(prefs.get('balance', 0)) || 0, -1, 1); },
  get karaoke() { return !!prefs.get('karaoke', false); },       // centre (vocal) reduction
  /** Active headphone correction: { name, preamp, filters: [{ type, fc, gain, q }] } or null. */
  get headphone() {
    const id = prefs.get('hpActive', null);
    return id ? (prefs.get('hpProfiles', []).find((p) => p.id === id) || null) : null;
  },
  get active() { return this.nightMode || this.mono || this.balance !== 0 || this.karaoke || !!this.headphone; },
};

/** Playback settings, stored per browser. */
export const playback = {
  get gapless() { return prefs.get('gapless', true); },
  get crossfade() { return clamp(Number(prefs.get('crossfade', 0)) || 0, 0, 12); },
  get crossfadeAlbums() { return prefs.get('crossfadeAlbums', false); }, // crossfade inside an album too?
  get replayGain() { return prefs.get('replayGain', 'auto'); },         // off | track | album | auto
  get preamp() { return clamp(Number(prefs.get('rgPreamp', 0)) || 0, -15, 15); },
  get fallbackGain() { return clamp(Number(prefs.get('rgFallback', 0)) || 0, -15, 0); },
  get preventClipping() { return prefs.get('rgClip', true); },
};

export const deviceId = (() => {
  let id = prefs.get('deviceId', null);
  if (!id) { id = Math.random().toString(36).slice(2, 10); prefs.set('deviceId', id); }
  return id;
})();
export const deviceName = () => {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Browser';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return `${br ? br + ' on ' : ''}${os}`;
};

/**
 * Shuffle that feels random to people: songs you rate or love come up a bit more
 * often, and the same artist doesn't play twice in a row when it can be avoided.
 */
export function smartShuffle(list) {
  const weight = (t) => 1 + (t.rating || 0) * 0.35 + (t.favorite ? 1 : 0);
  const keyed = list.map((t) => [Math.random() ** (1 / weight(t)), t]).sort((a, b) => b[0] - a[0]).map((x) => x[1]);
  const artist = (t) => (t.artistId ?? t.artist ?? '').toString();
  for (let i = 1; i < keyed.length; i++) {
    if (artist(keyed[i]) !== artist(keyed[i - 1])) continue;
    for (let j = i + 1; j < Math.min(keyed.length, i + 25); j++) {
      if (artist(keyed[j]) !== artist(keyed[i - 1])) {
        [keyed[i], keyed[j]] = [keyed[j], keyed[i]];
        break;
      }
    }
  }
  return keyed;
}
const shuffled = (list) => (prefs.get('smartShuffle', true) ? smartShuffle(list) : shuffleArray(list));

class Player extends Emitter {
  decks = [new Audio(), new Audio()];
  active = 0;          // index of the deck that is "the" player
  queue = [];          // play order
  original = [];       // order before shuffling
  index = -1;
  shuffle = false;
  repeat = 'off';      // off | all | one
  volume = clamp(Number(prefs.get('volume', 0.8)), 0, 1);
  muted = !!prefs.get('muted', false);
  rate = clamp(Number(prefs.get('rate', 1)) || 1, 0.25, 4);
  sleep = null;        // null | { at: timestamp } | { endOfTrack: true }
  ctx = null;
  analyser = null;
  userId = null;
  #scrobbled = false;
  #extScrobbled = false; // sent to Last.fm / ListenBrainz
  #startedAt = 0;
  #announced = null;     // track id we sent "now playing" for
  #radioBusy = false;
  radio = null;          // { seed, label } while a radio station is playing
  #errors = 0;
  #saveTimer = null;
  #syncTimer = null;
  #lastSync = 0;
  #preloaded = null;   // { track, deck } buffered on the inactive deck
  #transition = null;  // { from, to, start, dur } while crossfading
  #handover = null;    // gapless setTimeout
  #fade = 1;           // sleep-timer fade multiplier
  #tick = null;
  #sleepTimer = null;

  constructor() {
    super();
    for (const d of this.decks) {
      d.preload = 'auto';
      d.crossOrigin = 'anonymous';
      d.preservesPitch = true;
      const on = (ev, fn) => d.addEventListener(ev, (e) => { if (d === this.audio) fn(e); });
      on('play', () => this.#state());
      on('pause', () => this.#state());
      on('playing', () => {
        this.#errors = 0;
        this.#state();
        const t = this.current;
        if (t && this.#announced !== t.id) {
          this.#announced = t.id;
          if (isLib(t)) api.post(`/tracks/${t.id}/nowplaying`).catch(() => {});
        }
      });
      on('waiting', () => this.emit('state', this.playing, true));
      on('timeupdate', () => this.#onTime());
      on('durationchange', () => this.emit('time', this.time, this.duration));
      on('ended', () => this.#onEnded());
      on('error', () => this.#onError());
      // The preloaded deck failing shouldn't interrupt anything; just forget it.
      d.addEventListener('error', () => { if (d !== this.audio && this.#preloaded?.deck === d) this.#preloaded = null; });
    }
    this.#applyVolume();
    this.#setupMediaSession();
    addEventListener('pagehide', () => { this.#save(true); this.#syncServer(true); if (this.playing) this.#saveProgress({ keepalive: true }); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.#syncServer(true); });
  }

  /** The active <audio> element. */
  get audio() { return this.decks[this.active]; }
  get other() { return this.decks[1 - this.active]; }
  // While controlling another device (Sonara Connect, casting), these describe *that* device.
  get current() { return this.remote ? this.remote.state?.track || null : this.queue[this.index] || null; }
  get playing() { return this.remote ? !!this.remote.state?.playing : !this.audio.paused; }
  get duration() {
    if (this.remote) return this.remote.state?.duration || this.remote.state?.track?.duration || 0;
    return Number.isFinite(this.audio.duration) ? this.audio.duration : this.current?.duration || 0;
  }
  get time() {
    if (!this.remote) return this.audio.currentTime;
    const s = this.remote.state;
    if (!s) return 0;
    const t = s.playing ? s.time + (Date.now() - this.remote.receivedAt) / 1000 : s.time;
    return Math.min(t, s.duration || t);
  }
  get upNext() { return this.remote ? [] : this.queue.slice(this.index + 1); }
  /** This tab's own playback, regardless of remote mode. */
  get local() {
    return {
      current: this.queue[this.index] || null, playing: !this.audio.paused, time: this.audio.currentTime, index: this.index, queueLength: this.queue.length,
      duration: Number.isFinite(this.audio.duration) ? this.audio.duration : this.queue[this.index]?.duration || 0,
    };
  }

  // ───────── Remote mode ─────────

  remote = null;        // { id, name, kind, state, send(cmd, args), receivedAt }
  localVolume = null;
  #remoteTick = null;

  enterRemote(target) {
    if (this.remote) this.leaveRemote({ quiet: true });
    this.pause();
    this.localVolume = this.volume;
    this.remote = target;
    this.#remoteShown = false;
    target.receivedAt = Date.now();
    document.body.classList.add('remote-mode');
    this.emit('remote', target);
    if (target.state) this.remoteState(target.state);
    else { this.emit('track', null); this.emit('state', false, false); }
    clearInterval(this.#remoteTick);
    this.#remoteTick = setInterval(() => { if (this.remote?.state?.playing) this.emit('time', this.time, this.duration); }, 500);
  }

  leaveRemote({ quiet = false } = {}) {
    if (!this.remote) return;
    const name = this.remote.name;
    this.remote = null;
    clearInterval(this.#remoteTick);
    document.body.classList.remove('remote-mode');
    if (this.localVolume != null) { this.volume = this.localVolume; this.localVolume = null; this.#applyVolume(); }
    this.emit('remote', null);
    this.emit('volume', this.volume, this.muted);
    this.emit('track', this.current);
    this.emit('state', this.playing, false);
    this.emit('time', this.time, this.duration);
    this.emit('queue');
    if (!quiet) toast(t('Stopped controlling {name}', { name }));
  }

  /** New state from the device we're controlling. */
  remoteState(s) {
    const r = this.remote;
    if (!r) return;
    const prevTrack = r.state?.track?.id;
    r.state = s;
    r.receivedAt = Date.now();
    if (s?.track?.id !== prevTrack || !this.#remoteShown) { this.#remoteShown = true; this.emit('track', s?.track || null); this.#updateMediaSession(); }
    this.emit('state', !!s?.playing, false);
    this.emit('time', this.time, this.duration);
    if (s && typeof s.volume === 'number' && Date.now() - this.#remoteVolAt > 1500) { this.volume = s.volume; this.emit('volume', this.volume, false); }
    if (s?.repeat) { this.repeat = s.repeat; this.emit('mode'); }
    this.emit('queue');
  }
  #remoteShown = false;
  #remoteVolAt = 0;
  #remoteVolTimer = null;

  #send(cmd, args) {
    this.remote?.send(cmd, args)?.catch?.(() => {});
    // Optimistic update so the UI responds immediately.
    const s = this.remote?.state;
    if (!s) return;
    if (cmd === 'pause') s.playing = false;
    if (cmd === 'play') s.playing = true;
    if (cmd === 'toggle') s.playing = !s.playing;
    if (cmd === 'seek') { s.time = args.time; this.remote.receivedAt = Date.now(); }
    this.emit('state', s.playing, false);
    this.emit('time', this.time, this.duration);
  }

  // ───────── Queue ─────────

  /** Replace the queue and start playing at `start`. `radio` keeps the queue topped up with similar songs. */
  playList(tracks, start = 0, { shuffle = false, radio = null, time = 0, autoplay = true } = {}) {
    if (!tracks?.length) return;
    if (this.remote) {
      if (!tracks.every(isLib)) { toast(t('Podcasts and radio play in this browser only. Pick “This browser” in the devices menu first.')); return; }
      let ids = tracks.map((t) => t.id);
      let index = Math.min(Math.max(0, start), ids.length - 1);
      if (shuffle || this.shuffle) {
        const first = shuffle && start === 0 ? Math.floor(Math.random() * ids.length) : index;
        ids = [ids[first], ...shuffleArray(ids.filter((_, i) => i !== first))];
        index = 0;
      }
      this.#send('playTracks', { ids, index, time });
      return;
    }
    this.radio = radio;
    this.emit('radio', radio);
    tracks = tracks.slice();
    this.original = tracks;
    if (shuffle) this.shuffle = true;
    if (this.shuffle) {
      const first = shuffle && start === 0 ? Math.floor(Math.random() * tracks.length) : start;
      const rest = tracks.filter((_, i) => i !== first);
      this.queue = [tracks[first], ...shuffled(rest)];
      this.index = 0;
    } else {
      // A copy: queue and original must be separate arrays, or "Play next" / "Add to queue" insert everything twice.
      this.queue = tracks.slice();
      this.index = Math.min(Math.max(0, start), tracks.length - 1);
    }
    this.emit('mode');
    this.#load(autoplay, time);
    this.#queueChanged();
  }

  #remoteOnly(what) {
    if (!this.remote) return false;
    toast(t("{what} isn't available while controlling {name}", { what: t(what), name: this.remote.name }));
    return true;
  }

  playNext(tracks) {
    if (this.#remoteOnly('Play next')) return;
    tracks = [].concat(tracks);
    if (!this.current) return this.playList(tracks);
    this.queue.splice(this.index + 1, 0, ...tracks);
    const oi = this.original.indexOf(this.current);
    this.original.splice(oi + 1, 0, ...tracks);
    this.#queueChanged();
    toast(tracks.length === 1 ? t('“{title}” plays next', { title: tracks[0].title }) : t('{n} items play next', { n: tracks.length }), { type: 'success' });
  }

  addToQueue(tracks) {
    if (this.#remoteOnly('Adding to the queue')) return;
    tracks = [].concat(tracks);
    if (!this.current) return this.playList(tracks);
    this.queue.push(...tracks);
    this.original.push(...tracks);
    this.#queueChanged();
    toast(tracks.length === 1 ? t('Added “{title}” to the queue', { title: tracks[0].title }) : t('Added {n} items to the queue', { n: tracks.length }), { type: 'success' });
  }

  jump(i) {
    if (this.remote) return this.#send('jump', { index: i });
    if (i < 0 || i >= this.queue.length) return;
    this.index = i;
    this.#load(true);
    this.#queueChanged();
  }

  removeAt(i) {
    if (i === this.index || i < 0 || i >= this.queue.length) return;
    const [t] = this.queue.splice(i, 1);
    const oi = this.original.indexOf(t);
    if (oi >= 0) this.original.splice(oi, 1);
    if (i < this.index) this.index--;
    this.#queueChanged();
  }

  move(from, to) {
    if (from === to) return;
    const cur = this.current;
    const [t] = this.queue.splice(from, 1);
    this.queue.splice(to, 0, t);
    this.index = this.queue.indexOf(cur);
    this.#queueChanged();
  }

  clearUpNext() {
    this.queue = this.queue.slice(0, this.index + 1);
    this.original = this.original.filter((t) => this.queue.includes(t));
    this.#queueChanged();
  }

  /** Update track objects in place (e.g. after favouriting or rating). */
  patchTrack(id, patch) {
    for (const list of [this.queue, this.original]) for (const t of list) if (t.id === id) Object.assign(t, patch);
    if (this.current?.id === id) this.emit('track', this.current);
    this.#save();
  }

  // ───────── Transport ─────────

  async play() {
    if (this.remote) return this.#send('play');
    if (!this.current) return;
    this.#ensureAudioGraph();
    // A paused radio station disconnects; reconnect so playback is live again.
    if (this.current.live && !this.audio.getAttribute('src')) { this.audio.src = srcFor(this.current); this.audio.playbackRate = 1; }
    try {
      await this.audio.play();
    } catch (err) {
      if (err.name !== 'AbortError') console.warn(err);
    }
  }
  pause() {
    if (this.remote) return this.#send('pause');
    this.#cancelTransition(true);
    this.audio.pause();
    this.#saveProgress();
    if (this.current?.live) { this.audio.removeAttribute('src'); this.audio.load(); }
  }
  toggle() { this.playing ? this.pause() : this.play(); }

  next(auto = false) {
    if (this.remote) return auto ? undefined : this.#send('next');
    if (!this.queue.length) return;
    if (this.index < this.queue.length - 1) this.index++;
    else if (this.repeat === 'all' || !auto) this.index = 0;
    else { this.pause(); this.audio.currentTime = 0; return; }
    this.#load(true);
    this.#queueChanged();
  }

  prev() {
    if (this.remote) return this.#send('prev');
    if (this.audio.currentTime > 3 || this.index <= 0) { this.seek(0); return; }
    this.index--;
    this.#load(true);
    this.#queueChanged();
  }

  seek(sec) {
    if (this.remote) return this.#send('seek', { time: Math.max(0, sec) });
    if (!this.current || this.current.live) return;
    this.#cancelTransition(true);
    const target = Math.max(0, Math.min(sec, this.duration || sec));
    const a = this.audio;
    // A stream that is still being transcoded can't seek yet: reload it once the
    // server has the whole file (wait=1) and jump to the position then.
    if (!this.#seekable(target) && a.src && isLib(this.current)) {
      const wasPlaying = this.playing;
      a.src = api.streamUrl(this.current.id, { wait: 1 });
      a.addEventListener('loadedmetadata', () => {
        a.currentTime = target;
        if (wasPlaying) a.play().catch(() => {});
      }, { once: true });
      this.emit('state', this.playing, true);
      return;
    }
    a.currentTime = target;
  }

  #seekable(t) {
    const r = this.audio.seekable;
    if (!r || !r.length) return t === 0;
    for (let i = 0; i < r.length; i++) if (t >= r.start(i) && t <= r.end(i) + 0.5) return true;
    return false;
  }

  setVolume(v) {
    if (this.remote) {
      this.volume = clamp(v, 0, 1);
      this.#remoteVolAt = Date.now();
      this.emit('volume', this.volume, false);
      clearTimeout(this.#remoteVolTimer);
      this.#remoteVolTimer = setTimeout(() => this.remote?.send('volume', { value: this.volume })?.catch?.(() => {}), 150);
      return;
    }
    this.volume = clamp(v, 0, 1);
    if (this.muted && v > 0) this.muted = false;
    this.#volumeChanged();
  }
  toggleMute() {
    this.muted = !this.muted;
    this.#volumeChanged();
  }

  setRate(r) {
    this.rate = clamp(Math.round(r * 100) / 100, 0.25, 4);
    for (const d of this.decks) d.playbackRate = d._track?.live ? 1 : this.rate;
    prefs.set('rate', this.rate);
    this.emit('rate', this.rate);
    this.#save();
  }

  /** minutes: number, 'track' (stop after the current song), or null to cancel. */
  setSleep(minutes) {
    clearTimeout(this.#sleepTimer);
    this.#fade = 1;
    this.#applyVolume();
    if (minutes === 'track') this.sleep = { endOfTrack: true };
    else if (minutes > 0) {
      this.sleep = { at: Date.now() + minutes * 60000 };
      this.#sleepTimer = setTimeout(() => this.#sleepFire(), Math.max(0, minutes * 60000 - SLEEP_FADE * 1000));
    } else this.sleep = null;
    this.emit('sleep', this.sleep);
  }

  toggleShuffle() {
    if (this.remote) return this.remote.kind === 'browser' ? this.#send('shuffle') : this.#remoteOnly('Shuffle');
    this.shuffle = !this.shuffle;
    const cur = this.current;
    if (cur) {
      if (this.shuffle) {
        const rest = this.original.filter((t) => t !== cur);
        this.queue = [cur, ...shuffled(rest)];
        this.index = 0;
      } else {
        this.queue = this.original.slice();
        this.index = Math.max(0, this.queue.indexOf(cur));
      }
    }
    this.emit('mode');
    this.#queueChanged();
  }

  cycleRepeat() {
    if (this.remote) {
      const value = { off: 'all', all: 'one', one: 'off' }[this.repeat];
      this.repeat = value;
      this.emit('mode');
      return this.#send('repeat', { value });
    }
    this.repeat = { off: 'all', all: 'one', one: 'off' }[this.repeat];
    this.#preloaded = null;
    this.emit('mode');
    this.#save();
  }

  /** Re-apply ReplayGain etc. after settings change. */
  refreshSettings() {
    this.#preloaded = null;
    this.#applyVolume();
  }

  // ───────── Volume & ReplayGain ─────────

  /** Linear gain for a track according to the ReplayGain settings (≤ 1: <audio> can't amplify). */
  gainFor(t, neighbours = this.queue, i = this.queue.indexOf(t)) {
    const mode = playback.replayGain;
    if (!t || mode === 'off') return 1;
    let useAlbum = mode === 'album';
    if (mode === 'auto') {
      // Album gain when the queue around this track is the same album played in order.
      const prev = neighbours[i - 1];
      const next = neighbours[i + 1];
      useAlbum = !this.shuffle && [prev, next].some((n) => n && n.albumId === t.albumId);
    }
    // Tags first; otherwise what Sonara measured itself (see analysis.js).
    const g = useAlbum ? t.rgAlbumGain ?? t.rgTrackGain ?? t.calcAlbumGain ?? t.calcTrackGain : t.rgTrackGain ?? t.rgAlbumGain ?? t.calcTrackGain ?? t.calcAlbumGain;
    const p = useAlbum ? t.rgAlbumPeak ?? t.rgTrackPeak ?? t.calcAlbumPeak ?? t.calcPeak : t.rgTrackPeak ?? t.rgAlbumPeak ?? t.calcPeak ?? t.calcAlbumPeak;
    const db = (g ?? playback.fallbackGain) + playback.preamp;
    let lin = 10 ** (db / 20);
    if (playback.preventClipping && p > 0) lin = Math.min(lin, 1 / p);
    return clamp(lin, 0, 1);
  }

  #deckGain(deck) {
    const t = deck === this.audio ? this.current : this.#preloaded?.deck === deck ? this.#preloaded.track : deck._track;
    return this.gainFor(t, this.queue, this.queue.indexOf(t));
  }

  #applyVolume() {
    for (const d of this.decks) {
      const tr = this.#transition;
      const xf = tr ? (d === tr.to ? tr.inGain : d === tr.from ? tr.outGain : 1) : 1;
      d.volume = clamp(this.volume * this.#deckGain(d) * xf * this.#fade, 0, 1);
      d.muted = this.muted;
    }
  }

  #volumeChanged() {
    prefs.set('volume', this.volume);
    prefs.set('muted', this.muted);
    this.#applyVolume();
    this.emit('volume', this.volume, this.muted);
    this.#save();
  }

  // ───────── Gapless & crossfade ─────────

  /** The track that will play after the current one finishes on its own. */
  #peekNext() {
    if (this.repeat === 'one' || this.sleep?.endOfTrack) return null;
    if (this.index < this.queue.length - 1) return { track: this.queue[this.index + 1], index: this.index + 1 };
    if (this.repeat === 'all' && this.queue.length > 1) return { track: this.queue[0], index: 0 };
    return null;
  }

  #crossfadeFor(a, b) {
    const xf = playback.crossfade;
    if (!xf || !a || !b) return 0;
    // Albums are usually meant to flow into the next track: keep them gapless.
    if (!playback.crossfadeAlbums && a.albumId === b.albumId && !this.shuffle) return 0;
    return xf;
  }

  #preload() {
    const n = this.#peekNext();
    if (!n || (!playback.gapless && !playback.crossfade)) return;
    if (this.#preloaded?.track === n.track) return;
    const d = this.other;
    if (this.#transition) return;
    d.pause();
    d._track = n.track;
    if (n.track.live) return; // radio connects when it starts, not ahead of time
    d.src = srcFor(n.track);
    d.playbackRate = this.rate;
    d.load();
    this.#preloaded = { track: n.track, deck: d };
  }

  #loop() {
    clearInterval(this.#tick);
    this.#tick = setInterval(() => {
      if (this.remote) return;
      if (!this.playing && !this.#transition) return;
      this.#stepTransition();
      const a = this.audio;
      const d = this.duration;
      if (!d || !this.current) return;
      const remaining = (d - a.currentTime) / (a.playbackRate || 1);
      if (remaining < PRELOAD_BEFORE_END + playback.crossfade) this.#preload();
      const n = this.#peekNext();
      const pre = this.#preloaded;
      if (!n || !pre || pre.track !== n.track || this.#transition || this.#handover) return;
      const xf = this.#crossfadeFor(this.current, n.track);
      if (xf && remaining <= xf) this.#startTransition(n, xf);
      else if (!xf && playback.gapless && remaining <= GAPLESS_LEAD) {
        this.#handover = setTimeout(() => {
          this.#handover = null;
          if (this.#preloaded === pre && this.playing) this.#startTransition(n, 0);
        }, Math.max(0, remaining * 1000 - 15));
      }
    }, 100);
  }

  /** Hand playback over to the preloaded deck (instantly, or fading over `dur` seconds). */
  #startTransition(n, dur) {
    const from = this.audio;
    const to = this.#preloaded.deck;
    this.#preloaded = null;
    to.currentTime = 0;
    this.active = this.decks.indexOf(to);
    this.index = n.index;
    if (dur) this.#transition = { from, to, start: performance.now(), dur: dur * 1000, inGain: 0, outGain: 1 };
    else from.pause();
    this.#applyVolume();
    to.play().catch((err) => err.name !== 'AbortError' && console.warn(err));
    this.#scrobbled = false;
    this.#extScrobbled = false;
    this.#startedAt = Date.now();
    this.emit('track', this.current);
    this.#updateMediaSession();
    this.#queueChanged();
  }

  #stepTransition() {
    const tr = this.#transition;
    if (!tr) return;
    const p = clamp((performance.now() - tr.start) / tr.dur, 0, 1);
    // Equal-power curve so the overall loudness stays constant.
    tr.inGain = Math.sin((p * Math.PI) / 2);
    tr.outGain = Math.cos((p * Math.PI) / 2);
    this.#applyVolume();
    if (p >= 1) this.#cancelTransition(false);
  }

  /** End a crossfade: stop the outgoing deck. */
  #cancelTransition(stopNow) {
    clearTimeout(this.#handover);
    this.#handover = null;
    const tr = this.#transition;
    if (!tr) return;
    this.#transition = null;
    tr.from.pause();
    if (stopNow) tr.from.removeAttribute('src');
    this.#applyVolume();
  }

  // ───────── Sleep timer ─────────

  #sleepFire() {
    const start = performance.now();
    const step = () => {
      if (!this.sleep?.at) { this.#fade = 1; this.#applyVolume(); return; }
      const p = (performance.now() - start) / (SLEEP_FADE * 1000);
      this.#fade = clamp(1 - p, 0, 1);
      this.#applyVolume();
      if (p < 1) { requestAnimationFrame(step); return; }
      this.pause();
      this.sleep = null;
      this.#fade = 1;
      this.#applyVolume();
      this.emit('sleep', null);
      toast(t('Sleep timer: playback paused'));
    };
    requestAnimationFrame(step);
  }

  // ───────── Internals ─────────

  #load(autoplay, startAt = 0) {
    const t = this.current;
    if (!t) return;
    this.#cancelTransition(true);
    this.#scrobbled = false;
    this.#extScrobbled = false;
    this.#startedAt = Date.now();
    const pre = this.#preloaded;
    this.#preloaded = null;
    if (pre && pre.track === t) {
      // Already buffered on the other deck: switch to it.
      this.audio.pause();
      this.active = this.decks.indexOf(pre.deck);
      this.audio.currentTime = 0;
    } else {
      this.other.pause();
      this.other.removeAttribute('src');
      if (!startAt && t.kind === 'episode' && t.resumeAt) startAt = t.resumeAt;
      if (t.live) {
        startAt = 0;
        // Connect to a station only when it's actually going to play.
        if (autoplay) this.audio.src = srcFor(t);
        else { this.audio.removeAttribute('src'); this.audio.load(); }
      } else {
        // Resuming mid-song: ask for the complete file so seeking works on transcoded streams too.
        this.audio.src = srcFor(t, startAt && isLib(t) ? { wait: 1 } : {});
      }
    }
    this.audio._track = t;
    this.audio.playbackRate = t.live ? 1 : this.rate;
    if (startAt) {
      const once = () => { this.audio.currentTime = startAt; };
      this.audio.addEventListener('loadedmetadata', once, { once: true });
    }
    this.#applyVolume();
    this.#lastProgress = Date.now();
    this.emit('track', t);
    this.#updateMediaSession();
    this.#watchOnAir();
    if (autoplay) this.play();
  }

  // ───────── Podcasts & radio ─────────

  #lastProgress = 0;
  #onAirTimer = null;

  /** Save where we are in a podcast episode (so it resumes there, on any device). */
  #saveProgress({ played = false, keepalive = false } = {}) {
    const t = this.current;
    if (this.remote || t?.kind !== 'episode') return;
    const position = played ? 0 : this.audio.currentTime;
    if (!played && position < 5) return;
    this.#lastProgress = Date.now();
    t.resumeAt = played ? 0 : position;
    fetch(`/api/podcasts/episodes/${t.episodeId}/progress`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', keepalive,
      body: JSON.stringify({ position, played }),
    }).then(() => this.emit('progress', t.episodeId, position, played)).catch(() => {});
  }

  /** Mark the current episode as finished. */
  markPlayed() { this.#saveProgress({ played: true }); }

  /** Radio: show the song that's on air (the server reads it from the stream's metadata). */
  #watchOnAir() {
    clearInterval(this.#onAirTimer);
    const tr = this.current;
    if (!tr?.live) return;
    const check = async () => {
      if (this.current !== tr || this.remote) { clearInterval(this.#onAirTimer); return; }
      if (!this.playing) return;
      const r = await api.get(`/stations/${tr.stationId}/now`).catch(() => null);
      const title = r?.title || t('Live radio');
      if (this.current === tr && title !== tr.artist) {
        tr.artist = title;
        this.emit('track', tr);
        this.#updateMediaSession();
      }
    };
    setTimeout(check, 4000);
    this.#onAirTimer = setInterval(check, ON_AIR_MS);
  }

  #state() {
    if (this.remote) { this.#save(); return; }
    document.body.classList.toggle('playing', this.playing);
    this.emit('state', this.playing, false);
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = this.playing ? 'playing' : 'paused';
    if (this.playing) this.#loop();
    this.#save();
    this.#syncServer();
  }

  #onTime() {
    if (this.remote) return;
    const a = this.audio;
    this.emit('time', a.currentTime, this.duration);
    const d = this.duration;
    if (!isLib(this.current)) {
      if (this.current?.kind === 'episode' && Date.now() - this.#lastProgress > PROGRESS_MS) this.#saveProgress();
      if ('mediaSession' in navigator && d && navigator.mediaSession.setPositionState) {
        try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(a.currentTime, d), playbackRate: a.playbackRate }); } catch { /* ignore */ }
      }
      this.#save();
      return;
    }
    if (!this.#scrobbled && d && a.currentTime >= Math.min(30, d / 2)) {
      this.#scrobbled = true;
      api.post(`/tracks/${this.current.id}/play`).catch(() => {});
    }
    // Last.fm / ListenBrainz rule: longer than 30 s, and played for half its length or 4 minutes.
    if (!this.#extScrobbled && d >= 30 && a.currentTime >= Math.min(240, d / 2)) {
      this.#extScrobbled = true;
      api.post(`/tracks/${this.current.id}/scrobble`, { startedAt: this.#startedAt }).catch(() => {});
    }
    if ('mediaSession' in navigator && d && navigator.mediaSession.setPositionState) {
      try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(a.currentTime, d), playbackRate: a.playbackRate }); } catch { /* ignore */ }
    }
    this.#save();
    if (Date.now() - this.#lastSync > SERVER_SYNC_MS) this.#syncServer();
  }

  #onEnded() {
    if (this.remote) return;
    if (this.current?.kind === 'episode') this.#saveProgress({ played: true });
    if (this.sleep?.endOfTrack) {
      this.sleep = null;
      this.emit('sleep', null);
      this.audio.currentTime = 0;
      this.#state();
      toast(t('Sleep timer: stopped after this song'));
      return;
    }
    if (this.repeat === 'one') { this.seek(0); this.play(); return; }
    this.next(true);
  }

  #onError() {
    if (this.remote) return;
    if (!this.audio.src || !this.current) return;
    this.#errors++;
    toast(this.current.live ? t("Couldn't connect to {name}. The station may be offline.", { name: this.current.title }) : t("Couldn't play “{title}”", { title: this.current.title }), { type: 'error' });
    if (this.#errors < 5 && this.index < this.queue.length - 1) setTimeout(() => this.next(true), 800);
  }

  /** Start a radio station from a seed like 'track:12', 'artist:<id>', 'album:<id>' or 'genre:Rock'. */
  async startRadio(seed, label) {
    try {
      const list = await api.get('/radio', { seed, limit: 40 });
      if (!list.length) return toast(t('Not enough music to start a radio station yet'), { type: 'error' });
      // A song or album radio starts with the seed itself.
      let first = [];
      if (seed.startsWith('track:') || seed.startsWith('sound:')) {
        const [t] = await api.post('/tracks/lookup', { ids: [Number(seed.slice(6))] });
        if (t) first = [t];
      }
      this.shuffle = false;
      this.playList([...first, ...list], 0, { radio: { seed, label } });
      toast(t('{name} radio', { name: label }), { type: 'success' });
    } catch (err) { toast(err.message, { type: 'error' }); }
  }

  stopRadio() {
    this.radio = null;
    this.emit('radio', null);
  }

  /** Keep a radio queue from running dry. */
  async #topUpRadio() {
    if (!this.radio || this.#radioBusy || this.queue.length - this.index > 6) return;
    this.#radioBusy = true;
    const radio = this.radio;
    try {
      const exclude = this.queue.slice(-300).filter(isLib).map((t) => t.id).join(',');
      const more = await api.get('/radio', { seed: radio.seed, limit: 25, exclude });
      if (this.radio !== radio || !more.length) return;
      this.queue.push(...more);
      this.original.push(...more);
      this.emit('queue');
      this.#save();
    } catch { /* try again on the next track */ } finally {
      this.#radioBusy = false;
    }
  }

  #queueChanged() {
    this.#topUpRadio();
    // The next track may have changed: re-check what's buffered.
    const n = this.#peekNext();
    if (this.#preloaded && this.#preloaded.track !== n?.track) this.#preloaded = null;
    this.emit('queue');
    this.#save();
    this.#syncServer();
  }

  /** Build the Web Audio graph (decks → EQ → analyser → speakers) when the visualizer or EQ needs it. */
  #ensureAudioGraph() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return true;
    }
    if (prefs.get('visualizer', true) === false && !eq.enabled && !sound.active) return false;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = this.ctx = new Ctx();
      const gain = (v = 1) => { const g = ctx.createGain(); g.gain.value = v; return g; };
      // decks → karaoke → headphone correction → EQ → mono / balance → night mode → analyser → speakers.
      // Each optional stage has a "dry" and a "wet" path; switching a feature just swaps their gains.
      this.eqInput = gain();
      const k = this.karaokeNodes = { out: gain(), dry: gain(1), wet: gain(0) };
      const split = ctx.createChannelSplitter(2);
      const side = gain(1);
      side.channelCount = 1; side.channelCountMode = 'explicit';
      const invert = gain(-1);
      const merge = ctx.createChannelMerger(2);
      const bass = ctx.createBiquadFilter();
      bass.type = 'lowpass'; bass.frequency.value = 140;
      // Vocals usually sit in the centre: left minus right removes them; the bass (also centred) is added back.
      this.eqInput.connect(split);
      split.connect(side, 0);
      split.connect(invert, 1);
      invert.connect(side);
      side.connect(merge, 0, 0);
      side.connect(merge, 0, 1);
      merge.connect(k.wet);
      this.eqInput.connect(bass).connect(k.wet);
      this.eqInput.connect(k.dry);
      k.dry.connect(k.out);
      k.wet.connect(k.out);

      this.hpPreamp = gain();
      this.hpFilters = Array.from({ length: HP_SLOTS }, () => { const f = ctx.createBiquadFilter(); f.type = 'peaking'; f.gain.value = 0; return f; });
      this.eqFilters = EQ_BANDS.map((f, i) => {
        const n = ctx.createBiquadFilter();
        n.type = i === 0 ? 'lowshelf' : i === EQ_BANDS.length - 1 ? 'highshelf' : 'peaking';
        n.frequency.value = f;
        n.Q.value = 1.1;
        return n;
      });
      [k.out, this.hpPreamp, ...this.hpFilters, ...this.eqFilters].reduce((a, b) => (a.connect(b), b));
      const eqOut = this.eqFilters[this.eqFilters.length - 1];

      const m = this.monoNodes = { dry: gain(1), wet: gain(0), out: gain() };
      const down = gain(1);
      down.channelCount = 1; down.channelCountMode = 'explicit'; down.channelInterpretation = 'speakers';
      eqOut.connect(m.dry).connect(m.out);
      eqOut.connect(down).connect(m.wet).connect(m.out);
      this.panner = ctx.createStereoPanner();
      m.out.connect(this.panner);

      const n = this.nightNodes = { dry: gain(1), wet: gain(0), out: gain(), comp: ctx.createDynamicsCompressor(), makeup: gain(10 ** (6 / 20)) };
      n.comp.threshold.value = -32; n.comp.knee.value = 18; n.comp.ratio.value = 5; n.comp.attack.value = 0.005; n.comp.release.value = 0.3;
      this.panner.connect(n.dry).connect(n.out);
      this.panner.connect(n.comp).connect(n.makeup).connect(n.wet).connect(n.out);

      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.8;
      for (const d of this.decks) ctx.createMediaElementSource(d).connect(this.eqInput);
      n.out.connect(this.analyser).connect(ctx.destination);
      this.applyEq();
      return true;
    } catch (err) {
      console.warn('Web Audio unavailable', err);
      return false;
    }
  }

  /** Push the saved EQ and sound settings into the audio graph (smoothly). */
  applyEq() {
    if (!this.ctx) {
      // Turning the EQ (or a sound feature) on mid-song: build the graph now so it takes effect immediately.
      if ((eq.enabled || sound.active) && this.current) this.#ensureAudioGraph();
      if (!this.ctx) return;
    }
    this.#applySound();
    const on = eq.enabled;
    const gains = eq.gains;
    const t = this.ctx.currentTime;
    this.eqFilters.forEach((f, i) => f.gain.setTargetAtTime(on ? gains[i] : 0, t, 0.03));
    // Pre-amp, plus automatic headroom so boosted bands don't clip.
    const boost = on ? Math.max(0, ...gains) : 0;
    const db = on ? eq.preamp - (eq.autoHeadroom ? boost * 0.6 : 0) : 0;
    this.eqInput.gain.setTargetAtTime(10 ** (db / 20), t, 0.03);
  }

  #applySound() {
    const t = this.ctx.currentTime;
    const set = (param, v) => param.setTargetAtTime(v, t, 0.04);
    const swap = (nodes, on) => { set(nodes.dry.gain, on ? 0 : 1); set(nodes.wet.gain, on ? 1 : 0); };
    swap(this.karaokeNodes, sound.karaoke);
    swap(this.monoNodes, sound.mono);
    swap(this.nightNodes, sound.nightMode);
    set(this.panner.pan, sound.balance);
    const hp = sound.headphone;
    const filters = hp?.filters || [];
    set(this.hpPreamp.gain, hp ? 10 ** ((Number(hp.preamp) || 0) / 20) : 1);
    this.hpFilters.forEach((f, i) => {
      const spec = filters[i];
      if (!spec) { f.type = 'peaking'; set(f.gain, 0); return; }
      f.type = spec.type;
      set(f.frequency, clamp(spec.fc, 10, 22000));
      set(f.Q, clamp(spec.q || 0.707, 0.05, 30));
      set(f.gain, clamp(spec.gain || 0, -30, 30));
    });
  }

  #setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const h = {
      play: () => this.play(), pause: () => this.pause(),
      previoustrack: () => this.prev(), nexttrack: () => this.next(),
      seekto: (d) => this.seek(d.seekTime),
      seekbackward: (d) => this.seek(this.time - (d.seekOffset || (this.current?.kind === 'episode' ? 15 : 10))),
      seekforward: (d) => this.seek(this.time + (d.seekOffset || (this.current?.kind === 'episode' ? 30 : 10))),
    };
    for (const [k, fn] of Object.entries(h)) { try { ms.setActionHandler(k, fn); } catch { /* unsupported */ } }
  }

  #updateMediaSession() {
    if (!('mediaSession' in navigator) || !this.current) return;
    const t = this.current;
    const src = coverUrl(t.cover);
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title, artist: t.artist, album: t.album,
      artwork: src ? [{ src: new URL(src, location.href).href, sizes: '512x512' }] : [],
    });
    document.title = `${t.title} · ${t.artist} — Sonara`;
  }

  // ───────── Persistence ─────────

  #window() {
    const start = Math.max(0, this.index - 200);
    const q = this.queue.slice(start, start + MAX_PERSIST);
    return { start, q, original: this.original.map((t) => q.indexOf(t)).filter((i) => i >= 0) };
  }

  #save(now = false) {
    clearTimeout(this.#saveTimer);
    const write = () => {
      const { start, q, original } = this.#window();
      prefs.set('player', {
        user: this.userId,
        savedAt: Date.now(),
        queue: q,
        original,
        index: this.index - start,
        time: this.audio.currentTime,
        shuffle: this.shuffle,
        repeat: this.repeat,
      });
    };
    now ? write() : (this.#saveTimer = setTimeout(write, 1000));
  }

  /** Push the playback state to the server (debounced; `now` for page unload). */
  #syncServer(now = false) {
    // Only library songs follow you to other devices (episodes keep their own position on the server).
    if (!this.userId || !isLib(this.current)) return;
    clearTimeout(this.#syncTimer);
    const send = () => {
      this.#lastSync = Date.now();
      const w = this.#window();
      const keep = w.q.map((t, i) => (isLib(t) ? i : -1)).filter((i) => i >= 0);
      const remap = new Map(keep.map((i, k) => [i, k]));
      const q = keep.map((i) => w.q[i]);
      const original = w.original.map((i) => remap.get(i)).filter((i) => i != null);
      const index = remap.get(this.index - w.start) ?? 0;
      const body = JSON.stringify({
        queue: q.map((t) => t.id), original, index, time: this.audio.currentTime,
        shuffle: this.shuffle, repeat: this.repeat, volume: this.volume, muted: this.muted, rate: this.rate,
        device: `${deviceId}|${deviceName()}`,
      });
      fetch('/api/me/player', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body, keepalive: body.length < 60000, credentials: 'same-origin' })
        .then((r) => r.ok && r.json()).then((r) => { if (r?.updatedAt) prefs.set('playerSyncedAt', r.updatedAt); }).catch(() => {});
    };
    now ? send() : (this.#syncTimer = setTimeout(send, 2000));
  }

  #applyState(s, queue) {
    this.queue = queue;
    this.original = (s.original || []).map((i) => queue[i]).filter(Boolean);
    if (this.original.length !== this.queue.length) this.original = this.queue.slice();
    this.index = Math.min(Math.max(0, s.index), this.queue.length - 1);
    this.shuffle = !!s.shuffle;
    this.repeat = s.repeat || 'off';
    this.audio.preload = 'metadata';
    this.#load(false, s.time || 0);
    this.audio.preload = 'auto';
    this.emit('mode');
    this.emit('queue');
  }

  /** Restore the last session (paused): this browser's first, then the server's if it is newer. */
  async restore(user) {
    this.userId = user?.id ?? null;
    const local = prefs.get('player', null);
    const localOk = local?.queue?.length && (local.user == null || local.user === this.userId);
    if (localOk) this.#applyState(local, local.queue);

    let remote;
    try { remote = await api.get('/me/player'); } catch { return; }
    const s = remote?.state;
    if (!s) return;
    // Volume and speed follow the user from device to device.
    if (!localOk || remote.updatedAt > (local.savedAt || 0)) {
      this.volume = s.volume ?? this.volume;
      this.muted = !!s.muted;
      this.#volumeChanged();
      if (s.rate) this.setRate(s.rate);
    }
    const [devId, devName] = String(s.device || '').split('|');
    const newer = !localOk || remote.updatedAt > (local.savedAt || 0) + 5000;
    if (!s.queue?.length || !newer || this.playing) return;
    if (devId === deviceId && localOk) return;
    const found = await api.post('/tracks/lookup', { ids: s.queue }).catch(() => null);
    if (!found || this.playing) return;
    // Drop tracks that no longer exist, keeping the current one's position right.
    const cur = found[s.index];
    const map = [];
    const queue = [];
    found.forEach((t, i) => { if (t) { map[i] = queue.length; queue.push(t); } });
    if (!queue.length) return;
    const index = cur ? map[s.index] : Math.min(map.slice(0, s.index).filter((x) => x != null).length, queue.length - 1);
    this.#applyState({ ...s, index, time: cur ? s.time : 0, original: (s.original || []).map((i) => map[i]).filter((i) => i != null) }, queue);
    if (devId !== deviceId && devName) toast(t('Picked up where you left off on {name}', { name: devName }));
  }
}

export const player = new Player();
