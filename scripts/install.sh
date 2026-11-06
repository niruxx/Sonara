#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  Sonara installer for Linux and macOS
#
#  • Checks for / installs Node.js (>= 22.13) and git
#  • Installs npm dependencies
#  • Creates data/config.json (port + music folder)
#  • Registers a background service that starts on boot:
#       Linux → systemd unit  (sonara.service)
#       macOS → launchd agent (com.sonara.server)
#
#  Usage:  ./scripts/install.sh [--port 7700] [--music /path/to/music] [--no-service] [--yes]
#  Run it as your normal user; it will ask for sudo only when needed.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE=sonara
LAUNCHD_LABEL=com.sonara.server
NODE_MIN_MAJOR=22
NODE_MIN_MINOR=13

PORT=""
MUSIC=""
INSTALL_SERVICE=1
ASSUME_YES=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --music) MUSIC="$2"; shift 2 ;;
    --no-service) INSTALL_SERVICE=0; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# ───────── Pretty output ─────────
if [[ -t 1 ]]; then
  B=$'\e[1m'; D=$'\e[2m'; R=$'\e[0m'; P=$'\e[38;5;141m'; G=$'\e[38;5;114m'; Y=$'\e[38;5;221m'; E=$'\e[38;5;203m'
else B= D= R= P= G= Y= E=; fi
step() { echo; echo "${P}${B}▸ $*${R}"; }
ok()   { echo "  ${G}✓${R} $*"; }
warn() { echo "  ${Y}!${R} $*"; }
die()  { echo; echo "  ${E}✗ $*${R}" >&2; exit 1; }
ask() { # ask "Question" default → echoes answer
  local q="$1" def="${2:-}" ans
  if [[ $ASSUME_YES -eq 1 || ! -t 0 ]]; then echo "$def"; return; fi
  read -r -p "  $q ${D}[${def}]${R} " ans </dev/tty || true
  echo "${ans:-$def}"
}
confirm() { # confirm "Question" Y|N
  local a; a="$(ask "$1 (y/n)" "${2:-Y}")"; [[ "$a" =~ ^[Yy] ]]
}

OS="$(uname -s)"
RUN_USER="${SUDO_USER:-$(id -un)}"
as_root() { if [[ $EUID -eq 0 ]]; then "$@"; else sudo "$@"; fi; }
as_user() { if [[ $EUID -eq 0 && -n "${SUDO_USER:-}" ]]; then sudo -u "$SUDO_USER" -H "$@"; else "$@"; fi; }

cat <<EOF

${P}${B}   ▂▅█▅▂  Sonara${R}  ${D}— self-hosted music, beautifully.${R}
${D}   Installing into ${APP_DIR}${R}
EOF

[[ "$OS" == "Linux" || "$OS" == "Darwin" ]] || die "Unsupported OS: $OS (use scripts/install.ps1 on Windows)"
if [[ $EUID -eq 0 && -z "${SUDO_USER:-}" ]]; then
  warn "Running as root. Sonara will run as root too — consider a regular user instead."
fi

# ───────── Node.js ─────────
step "Checking Node.js"

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local v; v="$(node -p 'process.versions.node' 2>/dev/null)" || return 1
  local major="${v%%.*}" rest="${v#*.}"; local minor="${rest%%.*}"
  (( major > NODE_MIN_MAJOR || (major == NODE_MIN_MAJOR && minor >= NODE_MIN_MINOR) ))
}

install_node() {
  if [[ "$OS" == "Darwin" ]]; then
    command -v brew >/dev/null 2>&1 || die "Homebrew not found. Install Node.js ${NODE_MIN_MAJOR}+ from https://nodejs.org and re-run."
    as_user brew install node
  elif command -v apt-get >/dev/null 2>&1; then
    as_root apt-get update -y
    as_root apt-get install -y ca-certificates curl gnupg
    curl -fsSL https://deb.nodesource.com/setup_24.x | as_root bash -
    as_root apt-get install -y nodejs
  elif command -v dnf >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_24.x | as_root bash -
    as_root dnf install -y nodejs
  elif command -v yum >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_24.x | as_root bash -
    as_root yum install -y nodejs
  elif command -v pacman >/dev/null 2>&1; then
    as_root pacman -Sy --noconfirm nodejs npm
  elif command -v zypper >/dev/null 2>&1; then
    as_root zypper --non-interactive install nodejs24 npm24 || as_root zypper --non-interactive install nodejs npm
  elif command -v apk >/dev/null 2>&1; then
    as_root apk add --no-cache nodejs npm
  else
    die "Couldn't detect a package manager. Install Node.js ${NODE_MIN_MAJOR}.${NODE_MIN_MINOR}+ from https://nodejs.org and re-run."
  fi
}

if node_ok; then
  ok "Node.js $(node -v) found at $(command -v node)"
else
  if command -v node >/dev/null 2>&1; then warn "Node.js $(node -v) is too old (need ${NODE_MIN_MAJOR}.${NODE_MIN_MINOR}+)."
  else warn "Node.js is not installed."; fi
  confirm "Install Node.js now?" Y || die "Node.js ${NODE_MIN_MAJOR}.${NODE_MIN_MINOR}+ is required."
  install_node
  hash -r
  node_ok || die "Node.js install finished but a suitable version still isn't on PATH. Install Node ${NODE_MIN_MAJOR}+ manually and re-run."
  ok "Node.js $(node -v) installed"
fi
NODE_BIN="$(command -v node)"
NODE_BIN="$(cd "$(dirname "$NODE_BIN")" && pwd -P)/$(basename "$NODE_BIN")"

if command -v git >/dev/null 2>&1; then ok "git $(git --version | awk '{print $3}') found"
else warn "git not found — you'll need it for scripts/update.sh (install it with your package manager)."; fi

# ───────── Dependencies ─────────
step "Installing dependencies"
cd "$APP_DIR"
if [[ -f package-lock.json ]]; then as_user npm ci --omit=dev --no-audit --no-fund
else as_user npm install --omit=dev --no-audit --no-fund; fi
ok "Dependencies installed"

# ───────── Configuration ─────────
step "Configuring"
as_user mkdir -p "$APP_DIR/data"
CURRENT_PORT="$(as_user "$NODE_BIN" --disable-warning=ExperimentalWarning scripts/configure.js --get port)"
[[ -n "$PORT" ]] || PORT="$(ask "Port to listen on?" "${CURRENT_PORT:-7700}")"
as_user "$NODE_BIN" --disable-warning=ExperimentalWarning scripts/configure.js --port "$PORT" >/dev/null
ok "Port: $PORT"

if [[ -z "$MUSIC" ]]; then
  DEFAULT_MUSIC=""
  for d in "$HOME/Music" "/home/$RUN_USER/Music" "/Users/$RUN_USER/Music" /srv/music /mnt/music; do
    [[ -d "$d" ]] && { DEFAULT_MUSIC="$d"; break; }
  done
  MUSIC="$(ask "Music folder? (leave empty to add later in Settings)" "$DEFAULT_MUSIC")"
fi
if [[ -n "$MUSIC" ]]; then
  if [[ -d "$MUSIC" ]]; then
    as_user "$NODE_BIN" --disable-warning=ExperimentalWarning scripts/configure.js --add-music "$MUSIC" >/dev/null
    ok "Music folder: $MUSIC"
  else
    warn "Folder '$MUSIC' doesn't exist — skipped. Add it later in Settings → Music folders."
  fi
fi
ok "User data lives in $APP_DIR/data (database, logins, playlists, cover art)"

# ───────── Service ─────────
if [[ $INSTALL_SERVICE -eq 1 ]]; then
  step "Setting up the background service"
  if [[ "$OS" == "Linux" ]] && command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
    UNIT="/etc/systemd/system/${SERVICE}.service"
    as_root tee "$UNIT" >/dev/null <<EOF
[Unit]
Description=Sonara music server
Documentation=file://${APP_DIR}/README.md
After=network-online.target remote-fs.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${APP_DIR}
ExecStart="${NODE_BIN}" --disable-warning=ExperimentalWarning "${APP_DIR}/server/index.js"
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
# Hardening
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
    as_root systemctl daemon-reload
    as_root systemctl enable "$SERVICE" >/dev/null 2>&1
    as_root systemctl restart "$SERVICE"
    ok "systemd service '${SERVICE}' enabled and started"
    echo "  ${D}Logs: journalctl -u ${SERVICE} -f   ·   Status: systemctl status ${SERVICE}${R}"

  elif [[ "$OS" == "Darwin" ]]; then
    USER_HOME="$(eval echo "~$RUN_USER")"
    PLIST="$USER_HOME/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"
    as_user mkdir -p "$USER_HOME/Library/LaunchAgents" "$APP_DIR/data/logs"
    as_user tee "$PLIST" >/dev/null <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>--disable-warning=ExperimentalWarning</string>
    <string>${APP_DIR}/server/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>${APP_DIR}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${APP_DIR}/data/logs/launchd.out.log</string>
  <key>StandardErrorPath</key><string>${APP_DIR}/data/logs/launchd.err.log</string>
  <key>EnvironmentVariables</key><dict><key>NODE_ENV</key><string>production</string></dict>
</dict>
</plist>
EOF
    UID_NUM="$(id -u "$RUN_USER")"
    as_user launchctl bootout "gui/${UID_NUM}/${LAUNCHD_LABEL}" >/dev/null 2>&1 || true
    as_user launchctl bootstrap "gui/${UID_NUM}" "$PLIST"
    ok "launchd agent '${LAUNCHD_LABEL}' loaded (starts when you log in)"
    echo "  ${D}Logs: ${APP_DIR}/data/logs/sonara.log${R}"
    warn "macOS may ask to allow Node.js access to your Music folder or external drives the first time."

  else
    warn "No systemd found — skipping service setup."
    echo "  Start Sonara manually with:  ${B}cd \"$APP_DIR\" && npm start${R}"
  fi
else
  ok "Skipped service setup (--no-service). Start with: cd \"$APP_DIR\" && npm start"
fi

# ───────── Done ─────────
IP=""
if [[ "$OS" == "Darwin" ]]; then IP="$(ipconfig getifaddr en0 2>/dev/null || true)"
else IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"; fi

cat <<EOF

${G}${B}  ✓ Sonara is installed!${R}

    Open  ${B}http://localhost:${PORT}${R}$( [[ -n "$IP" ]] && echo "   or   ${B}http://${IP}:${PORT}${R}" )
    The first visit lets you create the admin account.

    ${D}Update:     ./scripts/update.sh
    Uninstall:  ./scripts/uninstall.sh${R}

EOF
