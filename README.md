# Sonara

**A beautiful, self-hosted music player for your own library.** Point it at your music folders and listen from any browser on your network: desktop, phone or tablet.

- 🎨 **Colors that follow the music.** The whole interface takes its palette from the album art, with an animated glow that pulses to the beat.
- 🌊 **Full-screen Now Playing view** with a live audio visualizer, 3D-tilt artwork and a blurred-cover backdrop.
- 📚 **Library browsing** by albums, artists, songs and genres, with instant search.
- ❤️ **Per-user favorites, playlists and listening history.** Playlists support drag-to-reorder.
- 🎛️ **Queue** with play next, add to queue, shuffle, repeat and drag-to-reorder. It's saved on the server, so you can pick up on another device.
- 🎚️ **Gapless playback, crossfade and ReplayGain** volume normalization, a **10-band equalizer** with presets, playback speed and a sleep timer.
- 🏷️ **Rich tags.** Multiple artists and "feat." credits, compilations, multi-genre tags, MusicBrainz IDs, original year and release type (album, EP, single, live...).
- 🎤 **Synced lyrics** that scroll with the song, from `.lrc` files, embedded tags, or (optionally) [LRCLIB](https://lrclib.net).
- ✨ **Smart playlists** built from rules, **radio** stations from any song, album, artist or genre, "Continue listening", "On this day" and "Rediscover" on the home page, and a **listening stats** page with a year in review.
- 📡 **Scrobbling** to Last.fm and ListenBrainz, plus optional artist bios and photos (MusicBrainz, Wikipedia) and missing cover art (Cover Art Archive). Every online feature is off by default.
- ⭐ **Ratings**, play counts, and sorting and filtering by year, genre, rating, plays and date added.
- 📲 **Sonara Connect.** Control playback on one device from another, move what's playing between devices, cast to a **Chromecast** or **DLNA/UPnP speakers**, or play through the server's own speakers (**jukebox mode**).
- 🎉 **Listening parties.** Share a link and friends with an account hear the same song at the same moment.
- 🔗 **Share links** for songs, albums and playlists that work without an account, with expiry and optional downloads. Playlists can be **shared or collaborative**, and imported or exported as M3U, M3U8 or XSPF. `.m3u` files in your music folders become playlists automatically.
- 🔐 **Multiple user accounts** with an admin role, per-user **permissions** and **folder access**, **two-factor sign-in**, and **single sign-on** (OpenID Connect) or reverse-proxy sign-in (Authelia, Authentik).
- 🩺 **Easy to run.** Docker image, health check, Prometheus metrics, JSON logs, an in-app log viewer and scan history, backups and restore from the UI, and duplicate / missing-metadata reports.
- ⌨️ **Keyboard shortcuts**, plus media keys and lock-screen controls (Media Session API).
- 🔄 **Automatic library scanning.** Folders are watched, so changes show up within seconds, and a scheduled scan catches anything missed. Files that can't be read are listed in Settings.
- 📱 **Works on phones.** The layout is responsive and the app can be installed as a PWA. Save albums and playlists **for offline** and they play without a connection (needs HTTPS or localhost).
- 🎙️ **Podcasts.** Follow shows by RSS feed (or search the Apple Podcasts directory), and episodes resume where you stopped, on any device. Skip 15 s back or 30 s ahead, mark episodes played, download them to the server (by hand or automatically), and import or export your subscriptions as OPML.
- 📻 **Internet radio.** Add Icecast and SHOUTcast streams (or `.pls` / `.m3u` links), or search [radio-browser.info](https://www.radio-browser.info). The song that's on air shows in the player.
- ♿ **Accessible and translated.** Works with a keyboard and screen readers (skip link, focus handling in menus and dialogs, announced track changes) and follows your system's reduced-motion setting. The interface is available in English, Spanish, French and German.
- 🪟 **Mini player** in an always-on-top window (press **P**), colour **themes** or your own accent colour, and a **high-contrast** mode. Admins can **change album covers** by uploading, pasting a link, or picking a picture from the album folder.

- 🔁 **Plays anything.** Formats browsers can't handle (ALAC, WMA, APE, WavPack, AIFF, DSD…) and single-file albums with a `.cue` sheet are converted on the fly. Lower the streaming quality to save mobile data, and download songs, albums or playlists as originals or converted.
- 🗂️ **File management (admins).** Edit tags, move files, and organize folders by artist/album, genre, year or playlist from a template you can preview first.
- ⬇️ **Inbox.** Download audio with [yt-dlp](https://github.com/yt-dlp/yt-dlp), convert videos to audio, or upload files. Everything waits in the Inbox until you tag it and choose where it goes.

It runs anywhere Node.js runs (Linux, macOS, Windows), uses an embedded SQLite database, and has **no native dependencies and no build step**.

---

## Requirements

- **Node.js 22.13 or newer** (the installers can install it for you)
- **git** (needed for updates)
- Music in formats browsers can play: MP3, FLAC, M4A/AAC, OGG/Opus, WAV, WebM. With [ffmpeg](https://ffmpeg.org) installed, Sonara also plays ALAC, WMA, APE, WavPack, AIFF, DSD and cue-sheet albums by converting them while they play.

## Install

Clone the repository wherever you want Sonara to live, then run the installer for your platform.

### Linux / macOS

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

### Windows

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

### Docker

```bash
docker compose up -d        # edit the music path in docker-compose.yml first
```

Or without compose: `docker build -t sonara . && docker run -d -p 7700:7700 -v sonara-data:/data -v /srv/music:/music:ro sonara`.
The image includes ffmpeg and yt-dlp. Data lives in the `/data` volume; mount music read-write only if you want tag editing and organizing. For DLNA speakers and Chromecast, use `network_mode: host` so Sonara can be found on your LAN. `/api/health` is used as the container health check.

### First run

Open `http://localhost:7700` (or `http://<server-ip>:7700` from another device). The first visit asks you to **create the admin account**. Then go to **Settings → Music folders** to add or browse for folders. The scan starts right away.

## Optional tools

Some features use external programs. Sonara finds them on the `PATH`, and the related buttons are disabled when they're missing:

| Tool | Used for | Install |
| --- | --- | --- |
| [ffmpeg](https://ffmpeg.org) | Playing formats browsers can't (and cue sheets), lower streaming bitrates, converted downloads, editing tags, converting video to audio | `sudo apt install ffmpeg`, `brew install ffmpeg`, `winget install ffmpeg` |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | Downloading from YouTube and other sites | `pip install yt-dlp`, `brew install yt-dlp`, `winget install yt-dlp` |

To use a copy that isn't on the `PATH`, set `"ffmpegPath"` or `"ytdlpPath"` in `data/config.json`.

Changing files (editing tags, moving, organizing, importing from the Inbox) is **off by default**. Turn on **Settings → File management → Allow Sonara to change files** to use it. Downloads go to `data/downloads/` unless you choose another folder there. That folder must be outside your music folders.

## Multi-device, sharing and sign-in

- **Play on another device:** click the cast icon in the player bar. Other open Sonara tabs, the server speakers and DLNA speakers are listed there. Picking one moves what you're playing to it and turns this tab into a remote; **Play here** brings it back.
- **Jukebox mode** (Settings → Sharing & speakers) needs [mpv](https://mpv.io) (recommended) or ffplay on the server. **Network speakers** are found with SSDP on the local network. Both are available to admins and to users given the "speakers" permission.
- **Chromecast** works in Chrome and Edge when Sonara is opened over HTTPS (or on `localhost`), because browsers only allow casting from secure pages. The Chromecast fetches audio from Sonara directly, so set **Public address** if Sonara is behind a proxy.
- **Single sign-on:** create an OpenID Connect client in your provider (Authentik, Authelia, Keycloak, …), use the redirect URI shown in Settings → Sign-in, and fill in the issuer, client ID and secret. **Proxy sign-in:** set the header your proxy sends (e.g. `Remote-User`) and the proxy's address; only requests from that address may use it.
- **Restart and restore:** "Restart Sonara" exits with code 75 so systemd, launchd and Docker start it again. On Windows, restart the Scheduled Task by hand. A restore is applied on the next start, after the current database is saved to `data/backups/`.
- **Metrics:** turn on Prometheus metrics in Settings → Operations and scrape `/metrics` (set a token to require `Authorization: Bearer <token>`).

## Update

```bash
./scripts/update.sh                                        # Linux / macOS
powershell -ExecutionPolicy Bypass -File scripts\update.ps1   # Windows (or double-click scripts\update.cmd)
```

The update script:

1. Refuses to run if you've edited Sonara's code locally. Pass `--force` / `-Force` to stash your edits instead.
2. Saves a **snapshot of your database** to `data/backups/`. The 10 most recent are kept.
3. Pulls the latest code with `git pull --ff-only`.
4. Reinstalls dependencies, but only if they changed.
5. Restarts the service. Database migrations run automatically on startup.

**Your data is never touched.** Everything user-specific lives in `data/`, which is git-ignored. Your music files stay wherever they already are.

## Uninstall

```bash
./scripts/uninstall.sh                                        # Linux / macOS
powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1   # Windows (or double-click scripts\uninstall.cmd)
```

This removes the service or Scheduled Task, the firewall rule and `node_modules`. Afterwards it asks before deleting your Sonara data (default: **keep it**) and before deleting the app folder itself. Pass `--purge` / `-Purge` to delete the data without being asked. **Music files are never deleted.**

## Your data

| Path | What it is |
| --- | --- |
| `data/sonara.db` | SQLite database: users, playlists, favorites, play history, library index |
| `data/config.json` | Port, music folders, scan schedule |
| `data/covers/` | Cover art cache (rebuilt automatically by a rescan) |
| `data/logs/sonara.log` | Server log |
| `data/downloads/` | The Inbox: downloads and conversions waiting to be filed |
| `data/podcasts/` | Podcast episodes downloaded to the server |
| `data/transcode-cache/` | Converted audio, reused on later plays (size limit in Settings) |
| `data/backups/` | Database snapshots taken before each update, from the Server page, on a schedule, or with `npm run backup` |
| `data/secret.key` | Random key that signs stream links for casting (keep it private) |

To move the data elsewhere, set `SONARA_DATA_DIR=/path/to/data`.

### Configuration

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

## Running manually

```bash
npm install
npm start          # production
npm run dev        # restarts on code changes
npm run backup     # snapshot the database
```

## Managing the service

| | Status / logs | Restart |
| --- | --- | --- |
| Linux | `systemctl status sonara` · `journalctl -u sonara -f` | `sudo systemctl restart sonara` |
| macOS | `launchctl print gui/$(id -u)/com.sonara.server` | `launchctl kickstart -k gui/$(id -u)/com.sonara.server` |
| Windows | Task Scheduler → `Sonara` · `data\logs\sonara.log` | `Stop-ScheduledTask Sonara; Start-ScheduledTask Sonara` |

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Space` | Play / pause |
| `←` `→` | Seek 5 seconds |
| `Shift` + `←` `→` | Previous / next track |
| `↑` `↓` | Volume |
| `M` / `S` / `R` | Mute / shuffle / cycle repeat |
| `F` | Full-screen Now Playing |
| `Q` | Queue |
| `/` | Search |

In menus, the arrow keys move between items and `Esc` closes them. In the queue, `Enter` plays the focused song and `Delete` removes it.

## Podcasts and radio

- **Podcasts** are shared between users: two people following the same feed share its episodes and downloads, but each has their own subscriptions and progress. Feeds are checked every 6 hours (`podcastRefreshHours`, 0 = only by hand). Admins can turn on automatic downloads per show; the largest episode the server will download is `podcastDownloadMB` (default 1024).
- **Radio** stations belong to each user. Sonara relays the stream (so it works over HTTPS and with the equalizer) and reads the station's "now playing" metadata. HLS streams (`.m3u8`) aren't supported yet.
- **Search** for podcasts (Apple Podcasts directory) and stations (radio-browser.info) is off by default; turn it on in Settings → Online services.
- **Local addresses:** Sonara only fetches podcast feeds and radio streams on your local network (for example a home Icecast server) when an admin adds them. Other users can only add public addresses.
- Podcasts and radio play in the browser you start them in; they aren't sent to other devices, Chromecast or listening parties.

## Translations

The interface is translated in `public/js/locales/`. Each file maps the English text to the translation, and anything missing falls back to English. To add a language, copy `es.js`, translate the values, and add it to `LANGUAGES` in `public/js/i18n.js`. Pick the language in Settings → Language (it follows the browser by default).

## Library tips

- Sonara reads standard tags (ID3, Vorbis, MP4) and embedded cover art. If a file has no embedded cover, it uses `cover.jpg`, `folder.jpg` or `front.jpg` from the same folder.
- Untagged files fall back to an `Artist/Album/01 Title.ext` folder layout.
- Use **Settings → Full rescan** after re-tagging files without changing their modification time.

## Reverse proxy and HTTPS

Sonara works behind nginx, Caddy or Traefik. Example `Caddyfile`:

```
music.example.com {
  reverse_proxy localhost:7700
}
```

## Project layout

```
server/          Express API, SQLite (node:sqlite), library scanner, auth
public/          The web app (vanilla ES modules, no build step)
scripts/         install / update / uninstall for Linux, macOS (bash) and Windows (PowerShell)
data/            Your data (created on first run, git-ignored)
```

## License

MIT
