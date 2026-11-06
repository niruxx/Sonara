// Audio engine: queue management, shuffle/repeat, persistence, Media Session,
// and a Web Audio analyser for the visualizers.
import { api } from './api.js';
import { Emitter, shuffleArray, prefs, coverUrl } from './util.js';
import { toast } from './ui.js';

const MAX_PERSIST = 2000;

class Player extends Emitter {
  audio = new Audio();
  queue = [];      // play order
  original = [];   // order before shuffling
  index = -1;
  shuffle = false;
  repeat = 'off';  // off | all | one
  ctx = null;
  analyser = null;
  #scrobbled = false;
  #errors = 0;
  #saveTimer = null;

  constructor() {
    super();
    const a = this.audio;
    a.preload = 'auto';
    a.crossOrigin = 'anonymous';
    a.volume = prefs.get('volume', 0.8);
    a.muted = prefs.get('muted', false);

    a.addEventListener('play', () => this.#state());
    a.addEventListener('pause', () => this.#state());
    a.addEventListener('playing', () => { this.#errors = 0; this.#state(); });
    a.addEventListener('waiting', () => this.emit('state', this.playing, true));
    a.addEventListener('timeupdate', () => this.#onTime());
    a.addEventListener('durationchange', () => this.emit('time', a.currentTime, this.duration));
    a.addEventListener('ended', () => this.#onEnded());
    a.addEventListener('volumechange', () => {
      prefs.set('volume', a.volume);
      prefs.set('muted', a.muted);
      this.emit('volume', a.volume, a.muted);
    });
    a.addEventListener('error', () => this.#onError());
    this.#setupMediaSession();
    addEventListener('pagehide', () => this.#save(true));
  }

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

  /** Update track objects in place (e.g. after favouriting). */
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
  pause() { this.audio.pause(); }
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
    this.audio.currentTime = Math.max(0, Math.min(sec, this.duration || sec));
  }

  setVolume(v) {
    this.audio.volume = Math.max(0, Math.min(1, v));
    if (this.audio.muted && v > 0) this.audio.muted = false;
  }
  toggleMute() { this.audio.muted = !this.audio.muted; }

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
    this.emit('mode');
    this.#save();
  }

  // ───────── Internals ─────────

  #load(autoplay, startAt = 0) {
    const t = this.current;
    if (!t) return;
    this.#scrobbled = false;
    this.audio.src = api.streamUrl(t.id);
    if (startAt) {
      const once = () => { this.audio.currentTime = startAt; };
      this.audio.addEventListener('loadedmetadata', once, { once: true });
    }
    this.emit('track', t);
    this.#updateMediaSession();
    if (autoplay) this.play();
  }

  #state() {
    document.body.classList.toggle('playing', this.playing);
    this.emit('state', this.playing, false);
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = this.playing ? 'playing' : 'paused';
    this.#save();
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
  }

  #onEnded() {
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
    this.emit('queue');
    this.#save();
  }

  #ensureAudioGraph() {
    if (this.ctx || prefs.get('visualizer', true) === false) {
      this.ctx?.state === 'suspended' && this.ctx.resume();
      return;
    }
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx();
      const src = this.ctx.createMediaElementSource(this.audio);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.8;
      src.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
    } catch (err) {
      console.warn('Visualizer unavailable', err);
    }
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

  #save(now = false) {
    clearTimeout(this.#saveTimer);
    const write = () => {
      const start = Math.max(0, this.index - 200);
      const q = this.queue.slice(start, start + MAX_PERSIST);
      const ids = new Set(q.map((t) => t.id));
      prefs.set('player', {
        queue: q,
        original: this.original.filter((t) => ids.has(t.id)).map((t) => q.indexOf(t)),
        index: this.index - start,
        time: this.audio.currentTime,
        shuffle: this.shuffle,
        repeat: this.repeat,
      });
    };
    now ? write() : (this.#saveTimer = setTimeout(write, 1000));
  }

  /** Restore the last session (paused). */
  restore() {
    const s = prefs.get('player', null);
    if (!s?.queue?.length) return;
    this.queue = s.queue;
    this.original = (s.original || []).map((i) => s.queue[i]).filter(Boolean);
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
}

export const player = new Player();
