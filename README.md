<div align="center">

<img src="docs/banner.svg" alt="Sonara: a beautiful, self-hosted music player" width="100%">

<br>

[![Node.js 22.13+](https://img.shields.io/badge/node-22.13%2B-8b5cf6?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-ec4899?style=for-the-badge)](#-license)
[![Docker](https://img.shields.io/badge/docker-ready-0ea5e9?style=for-the-badge&logo=docker&logoColor=white)](#-docker)
[![Subsonic API](https://img.shields.io/badge/Subsonic-OpenSubsonic-a78bfa?style=for-the-badge)](#-client-apps-subsonic--opensubsonic)
[![No build step](https://img.shields.io/badge/build_step-none-22c55e?style=for-the-badge)](#%EF%B8%8F-project-layout)

**A beautiful, self-hosted music player for your own library.**<br>
Point it at your music folders and listen from any browser on your network, or from the apps you already love.

[✨ Features](#-features) · [🚀 Quick start](#-quick-start) · [📲 Apps](#-client-apps-subsonic--opensubsonic) · [📦 Install](#-install) · [⌨️ Shortcuts](#%EF%B8%8F-keyboard-shortcuts) · [🗺️ Roadmap](ROADMAP.md)

</div>

---

## 🌟 Highlights

<table>
<tr>
<td width="33%" valign="top">

### 🎨 Colours that follow the music
The whole interface takes its palette from the album art, with a glow that pulses to the beat and a full-screen Now Playing view.

</td>
<td width="33%" valign="top">

### 📲 Your favourite apps
Symfonium, Feishin, DSub, Substreamer and every other Subsonic app connect with their own revocable app password.

</td>
<td width="33%" valign="top">

### 🔁 Plays anything
FLAC, ALAC, WMA, APE, DSD, cue-sheet albums… converted on the fly when a browser or phone can't play them.

</td>
</tr>
<tr>
<td valign="top">

### 🌊 Smart about sound
Waveforms, tempo and key detection, loudness levelling, "Sounds like this" radio, mood mixes and headphone correction.

</td>
<td valign="top">

### 📡 Every room, every device
Move playback between devices, cast to Chromecast or DLNA speakers, play multi-room with Snapcast, or throw a listening party.

</td>
<td valign="top">

### 🪶 Light to run
Node.js and an embedded SQLite database. No native dependencies, no build step. Linux, macOS, Windows or Docker.

</td>
</tr>
</table>

---

## ✨ Features

### 🎧 Listening
- 🌈 **Colours from the album art** across the whole interface, with an animated glow that pulses to the beat.
- 🖼️ **Full-screen Now Playing** with a live audio visualizer, 3D-tilt artwork and a blurred-cover backdrop. Visualizer styles go from bars to Milkdrop presets.
- 🎚️ **Gapless playback, crossfade and ReplayGain**, a **10-band equalizer** with presets and a live response graph, playback speed and a sleep timer.
- 🎧 **Sound.** Headphone correction from the AutoEq database, night mode (gentle compression), mono, balance, and a **karaoke mode** that turns vocals down and shows big synced lyrics.
- 🎤 **Synced lyrics** that scroll with the song, from `.lrc` files, embedded tags, or (optionally) [LRCLIB](https://lrclib.net).
- 🎛️ **A queue** with play next, add to queue, shuffle, **smart shuffle** (no artist twice in a row), repeat and drag-to-reorder. It's saved on the server, so you can pick up on another device.
- 🔖 **Bookmarks and chapters.** Press **B** to mark a moment in a long mix or an episode.
- ⏰ **A wake-up alarm**, and a **mini player** in an always-on-top window (press **P**).

### 📚 Your library
- 🗂️ **Browse** by albums, artists, songs and genres, with instant search, and sorting and filtering by year, genre, rating, plays and date added.
- 🏷️ **Rich tags.** Multiple artists and "feat." credits, compilations, multi-genre tags, MusicBrainz IDs, original year and release type (album, EP, single, live…).
- ❤️ **Per-user favorites, ratings, playlists and listening history.** Playlists support drag-to-reorder.
- 🔄 **Automatic scanning.** Folders are watched, so changes show up within seconds, and a scheduled scan catches anything missed. Files that can't be read are listed in Settings.
- 🔁 **Plays anything.** Formats browsers can't handle (ALAC, WMA, APE, WavPack, AIFF, DSD…) and single-file albums with a `.cue` sheet are converted on the fly. Lower the streaming quality to save mobile data, and download songs, albums or playlists as originals or converted.
- 🔎 **Library tools.** Identify songs by their sound (AcoustID), see albums you're missing and new releases from your artists (MusicBrainz), import your history from Last.fm, ListenBrainz or Spotify, and import CSV playlists from Spotify or Apple Music.

### 🧭 Discovery
- ✨ **Smart playlists** built from rules, and **radio** from any song, album, artist or genre.
- 🌊 **Audio analysis.** A waveform seek bar, tempo and key (with Camelot codes), loudness levelling for files without ReplayGain tags, **"Sounds like this"** radio and daily mood mixes (Chill, Focus, Workout, Party, and one for this time of day).
- 🏠 **A home page** with "Continue listening", "On this day" and "Rediscover", and a **listening stats** page with a year in review.
- 📡 **Scrobbling** to Last.fm and ListenBrainz, plus optional artist bios and photos (MusicBrainz, Wikipedia) and missing cover art (Cover Art Archive). Every online feature is **off by default**.

### 📱 On every device
- 📲 **Subsonic / OpenSubsonic apps** can browse, stream, download for offline, star, rate, scrobble and edit playlists. Each app gets its own revocable **app password**.
- 📱 **Works on phones.** The layout is responsive and the app installs as a PWA. Save albums and playlists **for offline** (needs HTTPS or localhost).
- 🔀 **Sonara Connect.** Control playback on one device from another, move what's playing between devices, cast to a **Chromecast** or **DLNA/UPnP speakers**, or play through the server's own speakers (**jukebox mode**).
- 🏘️ **Multi-room** playback with Snapcast, **Home Assistant** over MQTT, and signed **webhooks**.
- ⌨️ **Keyboard shortcuts**, plus media keys and lock-screen controls.

### 🎉 Together
- 🥳 **Listening parties.** Share a link and friends with an account hear the same song at the same moment, request songs and vote.
- 👀 **Friend activity**, opt-in, so you can see what others on the server are playing.
- 🔗 **Share links** for songs, albums and playlists that work without an account, with expiry and optional downloads.
- 🤝 **Shared and collaborative playlists**, imported or exported as M3U, M3U8 or XSPF. `.m3u` files in your music folders become playlists automatically.

### 🎙️ Podcasts and radio
- 🎙️ **Podcasts.** Follow shows by RSS feed (or search the Apple Podcasts directory). Episodes resume where you stopped, on any device, with chapters and synced transcripts. Skip back 15 s or ahead 30 s, mark episodes played, download them to the server, and import or export OPML.
- 📻 **Internet radio.** Add Icecast and SHOUTcast streams (or `.pls` / `.m3u` links), or search [radio-browser.info](https://www.radio-browser.info). The song that's on air shows in the player.

### 🛡️ For admins
- 🔐 **Multiple accounts** with an admin role, per-user **permissions** and **folder access**, **two-factor sign-in**, and **single sign-on** (OpenID Connect) or reverse-proxy sign-in (Authelia, Authentik).
- 🗃️ **File management.** Edit tags, move files, and organize folders by artist/album, genre, year or playlist from a template you can preview first. Admins can also change album covers.
- ⬇️ **Inbox.** Download audio with [yt-dlp](https://github.com/yt-dlp/yt-dlp), convert videos to audio, or upload files. Everything waits in the Inbox until you tag it and choose where it goes.
- 🩺 **Easy to run.** Docker image, health check, Prometheus metrics, JSON logs, an in-app log viewer and scan history, backups and restore from the UI, and duplicate / missing-metadata reports.

### 🌍 For everyone
- ♿ **Accessible.** Works with a keyboard and screen readers (skip link, focus handling in menus and dialogs, announced track changes) and follows your system's reduced-motion setting. High-contrast mode included.
- 🗣️ **Translated** into English, Spanish, French and German.
- 🎨 **Make it yours** with colour themes, your own accent colour, and a flat or glass look.

---

## 🚀 Quick start

```bash
git clone <your-repo-url> sonara && cd sonara
docker compose up -d        # edit the music path in docker-compose.yml first
```

Then open **http://localhost:7700**, create the admin account, and add your music folder in **Settings → Music folders**. 🎶

Prefer a native install? See [📦 Install](#-install). It's one script on every platform.

---

## 📋 Requirements

- 🟢 **Node.js 22.13 or newer** (the installers can install it for you)
- 🌿 **git** (needed for updates)
- 🎵 Music in formats browsers can play: MP3, FLAC, M4A/AAC, OGG/Opus, WAV, WebM. With [ffmpeg](https://ffmpeg.org) installed, Sonara also plays ALAC, WMA, APE, WavPack, AIFF, DSD and cue-sheet albums by converting them while they play.

## 📦 Install

Clone the repository wherever you want Sonara to live, then run the installer for your platform.

### 🐧 Linux / 🍎 macOS

```bash
git clone <your-repo-url> sonara
cd sonara
./scripts/install.sh
```

The installer checks for and installs Node.js, installs dependencies, asks for a port and a music folder, and registers a background service:

- **Linux:** a `systemd` service called `sonara` (starts at boot)
- **macOS:** a `launchd` agent called `com.sonara.server` (starts at login)

Run it as your normal user. It asks for `sudo` only when it needs it.

Options: `--port 7700`, `--music /path/to/music`, `--no-service`, `--yes` (non-interactive).

### 🪟 Windows

```powershell
git clone <your-repo-url> sonara
cd sonara
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
```

Or double-click **`scripts\install.cmd`**.

The installer installs Node.js through `winget` if needed, installs dependencies, asks for a port and a music folder, and creates a **Scheduled Task** named `Sonara`. It will ask for administrator rights. It can also add a Windows Firewall rule so other devices on your network can connect.

Options: `-Port 7700`, `-Music "D:\Music"`, `-NoService`, `-Yes`, and `-RunAs System|User`:

- `System` (default) starts Sonara at boot, before anyone logs in.
- `User` starts Sonara when you log in. Choose this if your music is on a **mapped drive or network share**, because the SYSTEM account can't see those.

### 🐳 Docker

```bash
docker compose up -d        # edit the music path in docker-compose.yml first
```

Or without compose: `docker build -t sonara . && docker run -d -p 7700:7700 -v sonara-data:/data -v /srv/music:/music:ro sonara`.

The image includes ffmpeg and yt-dlp. Data lives in the `/data` volume; mount music read-write only if you want tag editing and organizing. For DLNA speakers and Chromecast, use `network_mode: host` so Sonara can be found on your LAN. `/api/health` is used as the container health check.

### 👋 First run

Open `http://localhost:7700` (or `http://<server-ip>:7700` from another device). The first visit asks you to **create the admin account**. Then go to **Settings → Music folders** to add or browse for folders. The scan starts right away.

## 🧰 Optional tools

Some features use external programs. Sonara finds them on the `PATH`, and the related buttons are disabled when they're missing:

| Tool | Used for | Install |
| --- | --- | --- |
| 🎬 [ffmpeg](https://ffmpeg.org) | Playing formats browsers can't (and cue sheets), lower streaming bitrates, converted downloads, editing tags, converting video to audio, background audio analysis | `sudo apt install ffmpeg`, `brew install ffmpeg`, `winget install ffmpeg` |
| 📥 [yt-dlp](https://github.com/yt-dlp/yt-dlp) | Downloading from YouTube and other sites | `pip install yt-dlp`, `brew install yt-dlp`, `winget install yt-dlp` |
| 🔍 [fpcalc](https://acoustid.org/chromaprint) (Chromaprint) | "Identify song…" (also needs a free [AcoustID API key](https://acoustid.org/new-application) in Settings → Online services) | `sudo apt install libchromaprint-tools`, `brew install chromaprint` |
| 🔊 [Snapcast](https://github.com/badaix/snapcast) | Multi-room playback (Sonara streams to it with ffmpeg) | see the Snapcast docs |
| 📢 [mpv](https://mpv.io) | Jukebox mode: playing through the server's own speakers (ffplay works too) | `sudo apt install mpv`, `brew install mpv`, `winget install mpv` |

To use a copy that isn't on the `PATH`, set `"ffmpegPath"`, `"ytdlpPath"`, `"fpcalcPath"` or `"mpvPath"` in `data/config.json`.

With ffmpeg, Sonara analyses the whole library in the background (one file at a time, at low priority; turn it off in Settings → Audio analysis). Without ffmpeg, songs are analysed in the browser the first time they're played (up to 20 minutes long).

> [!NOTE]
> Changing files (editing tags, moving, organizing, importing from the Inbox) is **off by default**. Turn on **Settings → File management → Allow Sonara to change files** to use it. Downloads go to `data/downloads/` unless you choose another folder there. That folder must be outside your music folders.

## 📲 Client apps (Subsonic / OpenSubsonic)

Sonara answers the Subsonic API (version 1.16.1, with the OpenSubsonic extensions `apiKeyAuthentication`, `formPost`, `songLyrics`, `getPodcastEpisode` and `indexBasedQueue`) at `/rest`.

| 📱 On phones | 💻 On computers |
| --- | --- |
| Symfonium · DSub · Ultrasonic · Substreamer · play:Sub · Tempo | Feishin · Supersonic · Sonixd |

1. In Sonara, open **Settings → Account → Apps** and create an **app password** for the app (for example "Symfonium on my phone"). It's shown once.
2. In the app, add a Subsonic (or OpenSubsonic / Navidrome) server with Sonara's address (the one in your browser, such as `https://music.example.com`), your username and the app password.

Good to know:
- 🔑 App passwords work with every sign-in method apps use (token, plain password or API key). Revoke one and only that app is signed out. Settings shows when and from which app each was last used.
- 🔐 Apps can also use your account password, unless an admin turns that off (Settings → Sign-in → Client apps) or your account has two-factor sign-in. Token sign-in always needs an app password, because Sonara doesn't store passwords in a form it could use for it.
- 👤 Everything follows your account: library folder limits, the maximum streaming bitrate, and download, playlist and sharing permissions. Stars, ratings, plays, playlists, bookmarks and the play queue are the same ones the web app uses, so you can start an album in an app and finish it in the browser.
- 🎚️ Streams are sent as the original file unless the app asks for a lower bitrate or another format (needs ffmpeg). Formats phones rarely play (APE, WavPack, DSD, cue-sheet albums) are converted automatically. Albums, artists, playlists, smart playlists (read-only), podcasts and internet radio stations all show up.
- 💾 Song IDs don't change when files are re-tagged, rescanned, or moved or renamed (even outside Sonara), so offline copies in apps stay valid. Streams carry ETags for cheap revalidation.

## 🔌 Sonara's own API

The web app's JSON API is described in OpenAPI 3.1 at **`/api/openapi.json`**. Import it into Postman, Insomnia or an OpenAPI viewer. Apps that keep their own copy of the library can call `GET /api/library/changes?since=<time of the last sync>` to get songs added or changed since then, songs removed, and your favorites. `node scripts/list-routes.js --check` confirms the description covers every route.

## 📡 Multi-device, sharing and sign-in

- 🔀 **Play on another device:** click the cast icon in the player bar. Other open Sonara tabs, the server speakers and DLNA speakers are listed there. Picking one moves what you're playing to it and turns this tab into a remote; **Play here** brings it back.
- 🔊 **Jukebox mode** (Settings → Sharing & speakers) needs [mpv](https://mpv.io) (recommended) or ffplay on the server. **Network speakers** are found with SSDP on the local network. Both are available to admins and to users given the "speakers" permission.
- 📺 **Chromecast** works in Chrome and Edge when Sonara is opened over HTTPS (or on `localhost`), because browsers only allow casting from secure pages. The Chromecast fetches audio from Sonara directly, so set **Public address** if Sonara is behind a proxy.
- 🔐 **Single sign-on:** create an OpenID Connect client in your provider (Authentik, Authelia, Keycloak, …), use the redirect URI shown in Settings → Sign-in, and fill in the issuer, client ID and secret. **Proxy sign-in:** set the header your proxy sends (e.g. `Remote-User`) and the proxy's address; only requests from that address may use it.
- ♻️ **Restart and restore:** "Restart Sonara" exits with code 75 so systemd, launchd and Docker start it again. On Windows, restart the Scheduled Task by hand. A restore is applied on the next start, after the current database is saved to `data/backups/`.
- 📈 **Metrics:** turn on Prometheus metrics in Settings → Operations and scrape `/metrics` (set a token to require `Authorization: Bearer <token>`).

## 🏘️ Multi-room, Home Assistant and webhooks

- 🔊 **Snapcast:** add a TCP source to `snapserver.conf` (`source = tcp://0.0.0.0:4953?name=Sonara&mode=server`), then turn on Snapcast in **Settings → Multi-room and home automation** and enter the server's address. "All rooms (Snapcast)" appears in the devices menu.
- 🏠 **Home Assistant:** enter your broker as `mqtt://user:password@host:1883` (or `mqtts://`). For everyone who shares their listening activity (Settings → Account), Sonara publishes `sonara/<user>/now_playing` and `sonara/<user>/state`, announces a sensor and play/pause, next and previous buttons through MQTT discovery, and listens on `sonara/<user>/command` (`toggle`, `play`, `pause`, `next`, `prev`).
- 🪝 **Webhooks** (Settings → Webhooks): Sonara POSTs `{ event, at, user, playing, position, track }` for `track.started`, `playback.paused` and `playback.resumed`. Check `X-Sonara-Signature: sha256=<hex>`, an HMAC-SHA256 of the raw body with the webhook's secret. Only admins can point webhooks at local-network addresses.

## 🎙️ Podcasts and radio

- 🎙️ **Podcasts** are shared between users: two people following the same feed share its episodes and downloads, but each has their own subscriptions and progress. Feeds are checked every 6 hours (`podcastRefreshHours`, 0 = only by hand). Admins can turn on automatic downloads per show; the largest episode the server will download is `podcastDownloadMB` (default 1024).
- 📻 **Radio** stations belong to each user. Sonara relays the stream (so it works over HTTPS and with the equalizer) and reads the station's "now playing" metadata. HLS streams (`.m3u8`) aren't supported yet.
- 🔎 **Search** for podcasts (Apple Podcasts directory) and stations (radio-browser.info) is off by default; turn it on in Settings → Online services.
- 🏠 **Local addresses:** Sonara only fetches podcast feeds and radio streams on your local network (for example a home Icecast server) when an admin adds them. Other users can only add public addresses.
- 🌐 Podcasts and radio play in the browser you start them in; they aren't sent to other devices, Chromecast or listening parties.

## ⌨️ Keyboard shortcuts

| Key | Action | | Key | Action |
| --- | --- | --- | --- | --- |
| `Space` | ⏯️ Play / pause | | `F` | 🖼️ Full-screen Now Playing |
| `←` `→` | ⏩ Seek 5 seconds | | `Q` | 📜 Queue |
| `Shift` + `←` `→` | ⏭️ Previous / next track | | `L` | 🎤 Lyrics |
| `↑` `↓` | 🔊 Volume | | `E` | 🎚️ Equalizer and sound |
| `M` | 🔇 Mute | | `P` | 🪟 Mini player |
| `S` / `R` | 🔀 Shuffle / 🔁 cycle repeat | | `B` | 🔖 Bookmark this moment |
| `<` `>` | 🐢 Slower / 🐇 faster | | `V` / `K` | 🌈 Visualizer style / 🎤 karaoke |
| `/` | 🔍 Search | | | |

In menus, the arrow keys move between items and `Esc` closes them. In the queue, `Enter` plays the focused song and `Delete` removes it.

## 🔄 Update

```bash
./scripts/update.sh                                        # Linux / macOS
powershell -ExecutionPolicy Bypass -File scripts\update.ps1   # Windows (or double-click scripts\update.cmd)
```

The update script:

1. 🛑 Refuses to run if you've edited Sonara's code locally. Pass `--force` / `-Force` to stash your edits instead.
2. 💾 Saves a **snapshot of your database** to `data/backups/`. The 10 most recent are kept.
3. ⬇️ Pulls the latest code with `git pull --ff-only`.
4. 📦 Reinstalls dependencies, but only if they changed.
5. ♻️ Restarts the service. Database migrations run automatically on startup.

> [!TIP]
> **Your data is never touched.** Everything user-specific lives in `data/`, which is git-ignored. Your music files stay wherever they already are.

## 🗑️ Uninstall

```bash
./scripts/uninstall.sh                                        # Linux / macOS
powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1   # Windows (or double-click scripts\uninstall.cmd)
```

This removes the service or Scheduled Task, the firewall rule and `node_modules`. Afterwards it asks before deleting your Sonara data (default: **keep it**) and before deleting the app folder itself. Pass `--purge` / `-Purge` to delete the data without being asked. **Music files are never deleted.**

## 💾 Your data

| Path | What it is |
| --- | --- |
| `data/sonara.db` | 🗄️ SQLite database: users, playlists, favorites, play history, library index |
| `data/config.json` | ⚙️ Port, music folders, scan schedule |
| `data/covers/` | 🖼️ Cover art cache (rebuilt automatically by a rescan) |
| `data/logs/sonara.log` | 📝 Server log |
| `data/downloads/` | 📥 The Inbox: downloads and conversions waiting to be filed |
| `data/podcasts/` | 🎙️ Podcast episodes downloaded to the server |
| `data/transcode-cache/` | 🔁 Converted audio, reused on later plays (size limit in Settings) |
| `data/backups/` | 💾 Database snapshots taken before each update, from the Server page, on a schedule, or with `npm run backup` |
| `data/secret.key` | 🔑 Random key that signs stream links for casting (keep it private) |

To move the data elsewhere, set `SONARA_DATA_DIR=/path/to/data`.

### ⚙️ Configuration

Edit `data/config.json` and restart Sonara, or change most settings from the web UI.

```json
{
  "port": 7700,
  "host": "0.0.0.0",
  "musicDirs": ["/srv/music"],
  "scanOnStartup": true,
  "scanIntervalMinutes": 60,
  "watch": true,
  "sessionDays": 30
}
```

Environment variables override the file: `SONARA_PORT`, `SONARA_HOST`, `SONARA_DATA_DIR`, and `SONARA_MUSIC_DIRS` (separated by `:` on Linux/macOS, `;` on Windows).

## 🖥️ Running manually

```bash
npm install
npm start          # production
npm run dev        # restarts on code changes
npm run backup     # snapshot the database
```

### 🛠️ Managing the service

| | Status / logs | Restart |
| --- | --- | --- |
| 🐧 Linux | `systemctl status sonara` · `journalctl -u sonara -f` | `sudo systemctl restart sonara` |
| 🍎 macOS | `launchctl print gui/$(id -u)/com.sonara.server` | `launchctl kickstart -k gui/$(id -u)/com.sonara.server` |
| 🪟 Windows | Task Scheduler → `Sonara` · `data\logs\sonara.log` | `Stop-ScheduledTask Sonara; Start-ScheduledTask Sonara` |

## 🌍 Translations

The interface is translated in `public/js/locales/`. Each file maps the English text to the translation, and anything missing falls back to English. To add a language, copy `es.js`, translate the values, and add it to `LANGUAGES` in `public/js/i18n.js`. Pick the language in Settings → Language (it follows the browser by default).

🇬🇧 English · 🇪🇸 Español · 🇫🇷 Français · 🇩🇪 Deutsch: translations for more languages are welcome!

## 💡 Library tips

- 🏷️ Sonara reads standard tags (ID3, Vorbis, MP4) and embedded cover art. If a file has no embedded cover, it uses `cover.jpg`, `folder.jpg` or `front.jpg` from the same folder.
- 📁 Untagged files fall back to an `Artist/Album/01 Title.ext` folder layout.
- 🔁 Use **Settings → Full rescan** after re-tagging files without changing their modification time.

## 🔒 Reverse proxy and HTTPS

Sonara works behind nginx, Caddy or Traefik. Example `Caddyfile`:

```
music.example.com {
  reverse_proxy localhost:7700
}
```

HTTPS also unlocks offline music, Chromecast and installing Sonara as an app.

## 🗺️ Roadmap

See **[ROADMAP.md](ROADMAP.md)** for what's done, what's next and how Sonara compares with Navidrome, Jellyfin and Plexamp.

## 🗂️ Project layout

```
server/          🖥️  Express API, SQLite (node:sqlite), library scanner, auth, Subsonic API
public/          🎨  The web app (vanilla ES modules, no build step)
scripts/         🧰  install / update / uninstall for Linux, macOS (bash) and Windows (PowerShell)
docs/            🖼️  Images for this README
data/            💾  Your data (created on first run, git-ignored)
```

## 📄 License

MIT. Made with 💜 for people who still own their music.
