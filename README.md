# Sonara

**A beautiful, self-hosted music player for your own library.** Point it at your music folders and listen from any browser on your network: desktop, phone or tablet.

- 🎨 **Colors that follow the music.** The whole interface takes its palette from the album art, with an animated glow that pulses to the beat.
- 🌊 **Full-screen Now Playing view** with a live audio visualizer, 3D-tilt artwork and a blurred-cover backdrop.
- 📚 **Library browsing** by albums, artists, songs and genres, with instant search.
- ❤️ **Per-user favorites, playlists and listening history.** Playlists support drag-to-reorder.
- 🎛️ **Queue** with play next, add to queue, shuffle, repeat and drag-to-reorder. It's saved on the server, so you can pick up on another device.
- 🎚️ **Gapless playback, crossfade and ReplayGain** volume normalization, a **10-band equalizer** with presets, playback speed and a sleep timer.
- 🏷️ **Rich tags.** Multiple artists and "feat." credits, compilations, multi-genre tags, MusicBrainz IDs, original year and release type (album, EP, single, live...).
- ⭐ **Ratings**, play counts, and sorting and filtering by year, genre, rating, plays and date added.
- 🔐 **Multiple user accounts** with an admin role.
- ⌨️ **Keyboard shortcuts**, plus media keys and lock-screen controls (Media Session API).
- 🔄 **Automatic library scanning.** Folders are watched, so changes show up within seconds, and a scheduled scan catches anything missed. Files that can't be read are listed in Settings.
- 📱 **Works on phones.** The layout is responsive and the app can be installed as a PWA.

- 🗂️ **File management (admins).** Edit tags, move files, and organize folders by artist/album, genre, year or playlist from a template you can preview first.
- ⬇️ **Inbox.** Download audio with [yt-dlp](https://github.com/yt-dlp/yt-dlp), convert videos to audio, or upload files. Everything waits in the Inbox until you tag it and choose where it goes.

It runs anywhere Node.js runs (Linux, macOS, Windows), uses an embedded SQLite database, and has **no native dependencies and no build step**.

---

## Requirements

- **Node.js 22.13 or newer** (the installers can install it for you)
- **git** (needed for updates)
- Music in formats browsers can play: MP3, FLAC, M4A/AAC, OGG/Opus, WAV, WebM

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

### First run

Open `http://localhost:7700` (or `http://<server-ip>:7700` from another device). The first visit asks you to **create the admin account**. Then go to **Settings → Music folders** to add or browse for folders. The scan starts right away.

## Optional tools

Some features use external programs. Sonara finds them on the `PATH`, and the related buttons are disabled when they're missing:

| Tool | Used for | Install |
| --- | --- | --- |
| [ffmpeg](https://ffmpeg.org) | Editing tags, converting video to audio, extracting audio from downloads | `sudo apt install ffmpeg`, `brew install ffmpeg`, `winget install ffmpeg` |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | Downloading from YouTube and other sites | `pip install yt-dlp`, `brew install yt-dlp`, `winget install yt-dlp` |

To use a copy that isn't on the `PATH`, set `"ffmpegPath"` or `"ytdlpPath"` in `data/config.json`.

Changing files (editing tags, moving, organizing, importing from the Inbox) is **off by default**. Turn on **Settings → File management → Allow Sonara to change files** to use it. Downloads go to `data/downloads/` unless you choose another folder there. That folder must be outside your music folders.

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
| `data/backups/` | Database snapshots taken before each update (or with `npm run backup`) |

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
