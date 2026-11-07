// Audio engine: queue management, shuffle/repeat, gapless playback and
// crossfade (two alternating <audio> "decks"), ReplayGain, playback speed,
// sleep timer, persistence (locally and on the server, so playback can resume
// on another device), Media Session, and a Web Audio analyser for the visualizers.
import { api } from './api.js';
import { Emitter, shuffleArray, prefs, coverUrl } from './util.js';
import { toast } from './ui.js';

const MAX_PERSIST = 2000;
const PRELOAD_BEFORE_END = 30;   // seconds before the end to start buffering the next track
const GAPLESS_LEAD = 0.3;        // seconds before the end to schedule the gapless hand-over
const SERVER_SYNC_MS = 15000;    // how often to push the playback position while playing
const SLEEP_FADE = 8;            // seconds of fade-out when the sleep timer fires

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

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

const deviceId = (() => {
  let id = prefs.get('deviceId', null);
  if (!id) { id = Math.random().toString(36).slice(2, 10); prefs.set('deviceId', id); }
  return id;
})();
const deviceName = () => {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Browser';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return `${br ? br + ' on ' : ''}${os}`;
};

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
      on('playing', () => { this.#errors = 0; this.#state(); });
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
    addEventListener('pagehide', () => { this.#save(true); this.#syncServer(true); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.#syncServer(true); });
  }

  /** The active <audio> element. */
  get audio() { return this.decks[this.active]; }
  get other() { return this.decks[1 - this.active]; }
  get current() { return this.queue[this.index] || null; }
  get playing() { return !this.audio.paused; }
  get duration() { return Number.isFinite(this.audio.duration) ? this.audio.duration : this.current?.duration || 0; }
  get time() { return this.audio.currentTime; }
  get upNext() { return this.queue.slice(this.index + 1); }

  // ───────── Queue ─────────

  /** Replace the queue and start playing at `start`. */
  playList(tracks, start = 0, { shuffle = false } = {}) {
    if (!tracks?.length) return;
    tracks = tracks.slice();
    this.original = tracks;
    if (shuffle) this.shuffle = true;
    if (this.shuffle) {
      const first = shuffle && start === 0 ? Math.floor(Math.random() * tracks.length) : start;
      const rest = tracks.filter((_, i) => i !== first);
      this.queue = [tracks[first], ...shuffleArray(rest)];
      this.index = 0;
    } else {
      this.queue = tracks;
      this.index = Math.min(Math.max(0, start), tracks.length - 1);
    }
    this.emit('mode');
    this.#load(true);
    this.#queueChanged();
  }

  playNext(tracks) {
    tracks = [].concat(tracks);
    if (!this.current) return this.playList(tracks);
    this.queue.splice(this.index + 1, 0, ...tracks);
    const oi = this.original.indexOf(this.current);
    this.original.splice(oi + 1, 0, ...tracks);
    this.#queueChanged();
    toast(tracks.length === 1 ? `“${tracks[0].title}” plays next` : `${tracks.length} songs play next`, { type: 'success' });
  }

  addToQueue(tracks) {
    tracks = [].concat(tracks);
    if (!this.current) return this.playList(tracks);
    this.queue.push(...tracks);
    this.original.push(...tracks);
    this.#queueChanged();
    toast(tracks.length === 1 ? `Added “${tracks[0].title}” to queue` : `Added ${tracks.length} songs to queue`, { type: 'success' });
  }

  jump(i) {
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
    if (!this.current) return;
    this.#ensureAudioGraph();
    try {
      await this.audio.play();
    } catch (err) {
      if (err.name !== 'AbortError') console.warn(err);
    }
  }
  pause() {
    this.#cancelTransition(true);
    this.audio.pause();
  }
  toggle() { this.playing ? this.pause() : this.play(); }

  next(auto = false) {
    if (!this.queue.length) return;
    if (this.index < this.queue.length - 1) this.index++;
    else if (this.repeat === 'all' || !auto) this.index = 0;
    else { this.pause(); this.audio.currentTime = 0; return; }
    this.#load(true);
    this.#queueChanged();
  }

  prev() {
    if (this.audio.currentTime > 3 || this.index <= 0) { this.seek(0); return; }
    this.index--;
    this.#load(true);
    this.#queueChanged();
  }

  seek(sec) {
    if (!this.current) return;
    this.#cancelTransition(true);
    this.audio.currentTime = Math.max(0, Math.min(sec, this.duration || sec));
  }

  setVolume(v) {
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
    for (const d of this.decks) d.playbackRate = this.rate;
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
    this.shuffle = !this.shuffle;
    const cur = this.current;
    if (cur) {
      if (this.shuffle) {
        const rest = this.original.filter((t) => t !== cur);
        this.queue = [cur, ...shuffleArray(rest)];
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
    const g = useAlbum ? t.rgAlbumGain ?? t.rgTrackGain : t.rgTrackGain ?? t.rgAlbumGain;
    const p = useAlbum ? t.rgAlbumPeak ?? t.rgTrackPeak : t.rgTrackPeak ?? t.rgAlbumPeak;
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
    d.src = api.streamUrl(n.track.id);
    d.playbackRate = this.rate;
    d.load();
    this.#preloaded = { track: n.track, deck: d };
  }

  #loop() {
    clearInterval(this.#tick);
    this.#tick = setInterval(() => {
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
      toast('Sleep timer: playback paused');
    };
    requestAnimationFrame(step);
  }

  // ───────── Internals ─────────

  #load(autoplay, startAt = 0) {
    const t = this.current;
    if (!t) return;
    this.#cancelTransition(true);
    this.#scrobbled = false;
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
      this.audio.src = api.streamUrl(t.id);
    }
    this.audio._track = t;
    this.audio.playbackRate = this.rate;
    if (startAt) {
      const once = () => { this.audio.currentTime = startAt; };
      this.audio.addEventListener('loadedmetadata', once, { once: true });
    }
    this.#applyVolume();
    this.emit('track', t);
    this.#updateMediaSession();
    if (autoplay) this.play();
  }

  #state() {
    document.body.classList.toggle('playing', this.playing);
    this.emit('state', this.playing, false);
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = this.playing ? 'playing' : 'paused';
    if (this.playing) this.#loop();
    this.#save();
    this.#syncServer();
  }

  #onTime() {
    const a = this.audio;
    this.emit('time', a.currentTime, this.duration);
    const d = this.duration;
    if (!this.#scrobbled && d && a.currentTime >= Math.min(30, d / 2)) {
      this.#scrobbled = true;
      api.post(`/tracks/${this.current.id}/play`).catch(() => {});
    }
    if ('mediaSession' in navigator && d && navigator.mediaSession.setPositionState) {
      try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(a.currentTime, d), playbackRate: a.playbackRate }); } catch { /* ignore */ }
    }
    this.#save();
    if (Date.now() - this.#lastSync > SERVER_SYNC_MS) this.#syncServer();
  }

  #onEnded() {
    if (this.sleep?.endOfTrack) {
      this.sleep = null;
      this.emit('sleep', null);
      this.audio.currentTime = 0;
      this.#state();
      toast('Sleep timer: stopped after this song');
      return;
    }
    if (this.repeat === 'one') { this.seek(0); this.play(); return; }
    this.next(true);
  }

  #onError() {
    if (!this.audio.src || !this.current) return;
    this.#errors++;
    toast(`Couldn't play “${this.current.title}”`, { type: 'error' });
    if (this.#errors < 5 && this.index < this.queue.length - 1) setTimeout(() => this.next(true), 800);
  }

  #queueChanged() {
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
    if (prefs.get('visualizer', true) === false && !eq.enabled) return false;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx();
      this.eqInput = this.ctx.createGain();
      this.eqFilters = EQ_BANDS.map((f, i) => {
        const n = this.ctx.createBiquadFilter();
        n.type = i === 0 ? 'lowshelf' : i === EQ_BANDS.length - 1 ? 'highshelf' : 'peaking';
        n.frequency.value = f;
        n.Q.value = 1.1;
        return n;
      });
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.8;
      for (const d of this.decks) this.ctx.createMediaElementSource(d).connect(this.eqInput);
      [this.eqInput, ...this.eqFilters, this.analyser, this.ctx.destination].reduce((a, b) => (a.connect(b), b));
      this.applyEq();
      return true;
    } catch (err) {
      console.warn('Web Audio unavailable', err);
      return false;
    }
  }

  /** Push the saved EQ settings into the filters (smoothly). */
  applyEq() {
    if (!this.ctx) {
      // Turning the EQ on mid-song: build the graph now so it takes effect immediately.
      if (eq.enabled && this.current) this.#ensureAudioGraph();
      if (!this.ctx) return;
    }
    const on = eq.enabled;
    const gains = eq.gains;
    const t = this.ctx.currentTime;
    this.eqFilters.forEach((f, i) => f.gain.setTargetAtTime(on ? gains[i] : 0, t, 0.03));
    // Pre-amp, plus automatic headroom so boosted bands don't clip.
    const boost = on ? Math.max(0, ...gains) : 0;
    const db = on ? eq.preamp - (eq.autoHeadroom ? boost * 0.6 : 0) : 0;
    this.eqInput.gain.setTargetAtTime(10 ** (db / 20), t, 0.03);
  }

  #setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const h = {
      play: () => this.play(), pause: () => this.pause(),
      previoustrack: () => this.prev(), nexttrack: () => this.next(),
      seekto: (d) => this.seek(d.seekTime),
      seekbackward: (d) => this.seek(this.time - (d.seekOffset || 10)),
      seekforward: (d) => this.seek(this.time + (d.seekOffset || 10)),
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
    if (!this.userId || !this.current) return;
    clearTimeout(this.#syncTimer);
    const send = () => {
      this.#lastSync = Date.now();
      const { start, q, original } = this.#window();
      const body = JSON.stringify({
        queue: q.map((t) => t.id), original, index: this.index - start, time: this.audio.currentTime,
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
    if (devId !== deviceId && devName) toast(`Picked up where you left off on ${devName}`);
  }
}

export const player = new Player();
