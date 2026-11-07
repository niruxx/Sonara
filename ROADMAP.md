# Sonara Roadmap

This roadmap lays out the stages for bringing Sonara up to feature parity with established self-hosted music servers (Navidrome, Jellyfin, Funkwhale, Airsonic/Gonic, Plex/Plexamp) and with mainstream music players in general.

Stages are ordered by impact and by dependency: later stages build on earlier ones. Within a stage, items are roughly in priority order.

**Legend:** `[x]` done · `[ ]` planned · 🔌 needs a new dependency or external tool

---

## Stage 0: Current baseline (v0.1)

What Sonara already ships:

- [x] Library scanning of local folders (scheduled, incremental: new, changed and removed files)
- [x] Browse by albums, artists, songs and genres, with search
- [x] Embedded cover art extraction and caching
- [x] Direct streaming with HTTP range requests (browser-native formats only)
- [x] Queue: play next, add to queue, shuffle, repeat, drag-to-reorder
- [x] Per-user favorites, playlists (drag-to-reorder) and play history
- [x] Multiple users with an admin role and login rate limiting
- [x] Full-screen Now Playing view, audio visualizer, album-art-driven theming
- [x] Media Session API (media keys, lock-screen controls) and keyboard shortcuts
- [x] Responsive layout and installable PWA
- [x] Cross-platform installers, updater with DB snapshots, and uninstaller

---

## Stage 1: Core playback and library quality ✅

*Goal: everyday listening feels as solid as any desktop player.* **Status: complete.**

### Playback
- [x] **Gapless playback** (the next track is pre-buffered on a second audio element and handed over at the boundary)
- [x] **Crossfade** with a configurable duration
- [x] **ReplayGain / volume normalization** (track and album mode, read from tags; fallback pre-amp)
- [x] Persist the queue, position and playback state across reloads and devices
- [x] Playback speed control (useful for audiobooks and podcasts later)
- [x] Sleep timer
- [x] Remember volume per user

### Metadata and scanning
- [x] **Multi-artist support** (split `ARTISTS` and featured artists; `feat.` parsing)
- [x] Compilation / "Various Artists" handling via `COMPILATION` and album-artist tags
- [x] MusicBrainz IDs (`MUSICBRAINZ_ALBUMID`, etc.) for stable grouping
- [x] Multi-genre tags and genre splitting on separators
- [x] Folder-based cover art (`cover.jpg`, `folder.jpg`, `front.png`) in addition to embedded art
- [x] Artist images (local `artist.jpg`)
- [x] Original vs. release year, release type (album, EP, single, live, compilation)
- [x] Filesystem watching (inotify / FSEvents / ReadDirectoryChangesW) for near-instant updates
- [x] Scan progress and error report in the UI (files skipped and why)

### Browsing
- [x] Sorting and filtering everywhere (by year, date added, play count, rating, name)
- [x] Multi-disc album display with disc headers
- [x] Recently added, recently played, most played, and random album views
- [x] Track details panel (codec, bitrate, sample rate, file path, tags)
- [x] Ratings (1–5 stars) alongside favorites

---

## Stage 2: Format support and transcoding ✅

*Goal: play anything in the library on any device and connection.* **Status: complete.**

- [x] 🔌 **On-the-fly transcoding** via ffmpeg (Opus/AAC/MP3 at configurable bitrates)
- [x] Per-user and per-client max bitrate (for mobile data)
- [x] Support formats browsers can't play natively: ALAC, WMA, APE, WavPack, DSD, AIFF
- [x] Transcode cache with size limits
- [x] Seeking within transcoded streams (playback starts while converting; seeking works once the converted file is ready, usually within seconds)
- [x] Downloads: single track, full album, or playlist as a zip (original or transcoded)
- [x] Cue sheet support (split single-file albums into tracks)

---

## Stage 3: Ecosystem compatibility (client apps)

*Goal: use Sonara from the native mobile and desktop apps people already use. This is the biggest parity step versus Navidrome.*

- [ ] **Subsonic / OpenSubsonic API** (`/rest/*`): browsing, streaming, search, playlists, starring, scrobbling, cover art
  - Unlocks clients such as Symfonium, DSub, Ultrasonic, Substreamer, play:Sub, Feishin, Sonixd, Supersonic
- [ ] Per-user API tokens / app passwords (so client apps don't store the main password)
- [ ] Offline sync support for clients (stable IDs and ETags)
- [ ] Documented REST API for Sonara's own endpoints (OpenAPI spec)
- [ ] Optional: Jellyfin-compatible music endpoints (stretch goal)

---

## Stage 4: Lyrics, discovery and smart features ✅

*Goal: the "music player in general" features listeners expect from Spotify and Apple Music.* **Status: complete.**

### Lyrics
- [x] Embedded lyrics (`USLT`/`LYRICS` tags) and sidecar `.lrc` files
- [x] **Synced, scrolling lyrics** in the Now Playing view
- [x] 🔌 Optional online lyrics lookup (e.g. LRCLIB)

### Discovery
- [x] **Smart playlists** (rule-based: genre, year, rating, play count, last played, date added)
- [x] Artist radio / "play similar" (local: shared genres and artists; optional 🔌 Last.fm similar artists)
- [x] "Continue listening", "On this day", and "Rediscover" home sections
- [x] Year-in-review / listening stats page (top artists, albums and tracks; listening time)

### External metadata (all optional and off by default)
- [x] 🔌 Last.fm / ListenBrainz **scrobbling** per user
- [x] 🔌 Artist bios and images from MusicBrainz, Last.fm, Wikipedia, fanart.tv
- [x] 🔌 Missing cover art lookup from Cover Art Archive

---

## Stage 5: Multi-device and social ✅

*Goal: Sonara follows you around the house and can be shared.* **Status: complete.**

- [x] **Remote control / "Connect" mode**: control playback on one device from another (Server-Sent Events, no extra dependency)
- [x] Resume playback on another device from the same position ("Play here" pulls the queue over; picking a device moves it there)
- [x] Casting: Chromecast (Google Cast in Chrome/Edge, needs HTTPS or localhost) and 🔌 DLNA/UPnP renderers (SSDP discovery, signed stream links)
- [x] Jukebox mode (server-side playback through the host's audio output, via 🔌 mpv or ffplay)
- [x] Public share links for tracks, albums and playlists (with expiry, view counts and optional downloads)
- [x] Shared and collaborative playlists between users
- [x] Playlist import/export (M3U, M3U8, XSPF) and auto-import of `.m3u` files in music folders
- [x] Listening parties / synced group playback

---

## Stage 6: Administration, security and operations ✅

*Goal: comfortable to run long-term, for more than one household member.* **Status: complete.**

- [x] Per-user library access (restrict users to certain music folders)
- [x] User permissions: download, share, playlist editing, speakers; transcoding limits (max bitrate)
- [x] Reverse-proxy auth headers (Authelia, Authentik) and OIDC / SSO login (no extra dependency)
- [x] Two-factor authentication (TOTP)
- [x] Official **Docker image** and `docker-compose.yml`
- [x] Health endpoint, Prometheus metrics, and structured (JSON) logs
- [x] In-app log viewer and scan history
- [x] Database backup and restore from the UI (plus scheduled backups)
- [x] Tag editing from the UI (admin only, writes back to files via ffmpeg, single songs or whole albums) 🔌
- [x] Move files between folders and **organize** the library from a naming template (by artist/album, genre, year or playlist), with preview; favorites and playlists follow the files
- [x] **Inbox**: yt-dlp downloads 🔌, video → audio conversion 🔌 and uploads land in a downloads folder, then get tagged and filed into the library
- [x] Duplicate detection and a "missing metadata" report

---

## Stage 7: Beyond music and polish ✅

*Goal: round out the experience.* **Status: complete, apart from the two deferred items.**

- [x] Equalizer (10-band Web Audio EQ with presets, pre-amp and a live response curve)
- [x] **Podcasts**: RSS and Atom subscriptions shared between users, per-user resume position that follows you across devices, 15 s / 30 s skip, played / unplayed, server-side downloads (manual or automatic for the newest N), scheduled feed refresh, OPML import/export, and optional 🔌 Apple Podcasts directory search
- [x] **Internet radio**: per-user stations (Icecast, SHOUTcast, `.pls`, `.m3u`), relayed through Sonara with the on-air song read from ICY metadata, and optional 🔌 radio-browser.info search
- [x] Cover art editing (upload, paste a web address, or pick an image from the album's folder; survives rescans)
- [x] Mini player / picture-in-picture mode (Document Picture-in-Picture, with a video PiP fallback)
- [x] Customizable themes and accent overrides; high-contrast mode
- [x] **Accessibility pass**: skip link, landmarks and `aria-current`, focus moves to each new page's heading, visible keyboard focus everywhere, arrow-key menus that hand focus back when closed, focus-trapped dialogs, a keyboard-operable queue, track changes announced to screen readers, labelled sliders with spoken values, and the system's reduced-motion setting respected
- [x] **Internationalization**: translation layer with plural rules and locale-aware dates, a language picker (follows the browser by default), and Spanish, French and German for the main interface (navigation, player, queue, library, podcasts, radio, menus)
- [ ] Translate the remaining screens (Server, Inbox, file management, most admin settings)
- [x] Offline playback in the PWA (cache selected albums and playlists)
- [ ] *Deferred:* Audiobooks (chapters, per-book resume). Playback speed and podcast-style resume cover the basics; dedicated apps such as Audiobookshelf do the rest better
- [ ] *Deferred:* Desktop wrapper with OS-level media integration (stretch goal)

---

## Stage 8: Standing out ✅

*Goal: features that make Sonara stand out as a music player.* **Status: complete.** Items marked 🔌 need an optional tool or an opt-in online service; without them the rest of Sonara works as before.

### Listening
- [x] **Waveform seek bar**, from Sonara's own audio analysis (server with 🔌 ffmpeg, or in the browser as songs play)
- [x] **Headphone correction**: AutoEq / Equalizer APO parametric profiles, searchable from the AutoEq list on GitHub or pasted, applied before the EQ (per browser)
- [x] **Night mode** (dynamic range compression), **mono** downmix and **left/right balance**
- [x] **Loudness analysis** (EBU R128, measured by Sonara's analyser) for files without ReplayGain tags, with album gain once a whole album is measured; stored in the database, files untouched
- [x] **Wake-up alarm** that fades in a playlist, smart playlist, mix, station or the whole library (runs in an open browser tab)
- [x] **Bookmarks** in songs and episodes (press B), shown on the seek bar; **Podcasting 2.0 chapters** (and Podlove inline chapters) and **synced transcripts** (WebVTT, SRT, JSON) in the lyrics pane

### Library intelligence
- [x] **Acoustic fingerprinting** with 🔌 Chromaprint (fpcalc) and AcoustID: "Identify song…" suggests MusicBrainz matches and writes the chosen one into the tags
- [x] **BPM and key detection** (with Camelot codes), shown in track details and usable in smart playlist rules and sorting
- [x] **Missing albums** on artist pages and **new releases** on Home, from the 🔌 MusicBrainz discography (opt-in, cached two weeks)
- [x] **Import listening history** from 🔌 Last.fm, 🔌 ListenBrainz or a Spotify data export (read in the browser), matched by artist and title, without duplicates
- [x] **CSV / TSV playlists** from Spotify (Exportify), Apple Music, TuneMyMusic and others, matched tolerantly ("feat.", "Remastered", accents)

### Discovery
- [x] **"Sounds like this"**: radio from the nearest songs by analysed sound (tempo, energy, timbre, key), fully local
- [x] **Smart shuffle**: no artist twice in a row when avoidable; favourites and high ratings come up more often
- [x] **Mood and time-of-day mixes** on Home (Chill, Focus, Workout, Party, and what you usually play at this hour), new picks every day; genres fill in until songs are analysed

### Social and home
- [x] **Song requests and voting** in listening parties, live for everyone; the host plays requests next or declines them
- [x] **Friend activity** on Home (opt-in per user, respects folder access)
- [x] **Multi-room playback** through 🔌 Snapcast: Sonara streams the queue to a Snapcast TCP source and appears as "All rooms" in the devices menu (needs ffmpeg)
- [x] **Home Assistant over MQTT** (built-in client, discovery for a now-playing sensor and play/pause, next and previous buttons) and **signed webhooks** per user

### Fun
- [x] **Visualizer styles**: bars, oscilloscope wave, radial, and Milkdrop presets (🔌 butterchurn, downloaded from jsDelivr only after you agree)
- [x] **Karaoke mode** (press K): centre-channel vocal reduction and big, centred synced lyrics

### Also in this round
- [x] **Flat redesign** as the new default look (solid surfaces, one accent colour from the album art, no glass or glow); the classic glass look stays available in Settings → Appearance
- [x] Context menus: separators now sit between groups (they used to pile up at the bottom of long menus) and long menus scroll as one list

### Not built yet
- [ ] Stem separation for karaoke (true vocal removal needs a machine-learning model; the centre cut works on most studio mixes, not on mono or wide-panned vocals)
- [ ] Bookmarks and chapters synced to Chromecast / DLNA playback
- [ ] Server-side alarms (today the alarm needs an open browser tab; the jukebox or Snapcast could host them)

---

## Parity checklist at a glance

| Feature | Navidrome | Jellyfin | Plexamp | Sonara | Stage |
| --- | :-: | :-: | :-: | :-: | :-: |
| Web UI and multi-user | ✅ | ✅ | ✅ | ✅ | 0 |
| Gapless playback | ✅ | ✅ | ✅ | ✅ | 1 |
| ReplayGain | ✅ | ✅ | ✅ | ✅ | 1 |
| Multi-artist tags | ✅ | ✅ | ✅ | ✅ | 1 |
| Transcoding | ✅ | ✅ | ✅ | ✅ | 2 |
| Subsonic API | ✅ | ❌ | ❌ | ❌ | 3 |
| Synced lyrics | ✅ | ✅ | ✅ | ✅ | 4 |
| Smart playlists | ✅ | ❌ | ✅ | ✅ | 4 |
| Scrobbling | ✅ | ✅ (plugin) | ✅ | ✅ | 4 |
| Sharing links | ✅ | ❌ | ❌ | ✅ | 5 |
| Casting / remote control | ❌ | ✅ | ✅ | ✅ | 5 |
| Docker image | ✅ | ✅ | ✅ | ✅ | 6 |
| Album-art theming and visualizer | ❌ | ❌ | ✅ | ✅ | 0 |

---

## Guiding principles

- **Keep it simple to run.** No build step and no native dependencies by default. Heavier features (ffmpeg, external APIs) are optional and are detected at runtime.
- **Privacy first.** Every external service is opt-in.
- **Your files are read-only** unless an admin explicitly enables tag editing.
- **Migrations are automatic and safe.** Every schema change goes through `server/db.js` migrations and is covered by the pre-update backup.
