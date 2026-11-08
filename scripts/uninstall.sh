#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  Sonara uninstaller for Linux and macOS
#
#  Removes the background service and installed dependencies.
#  Your music files are NEVER touched. Your Sonara data (database, logins,
#  playlists, cover cache) is kept unless you pass --purge or confirm deletion.
#
#  Usage:  bash scripts/uninstall.sh [--purge] [--yes] [--remove-app]
#          [--data-dir /absolute/path/to/data]
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# The whole script lives in a { } block so bash parses it fully before running.
# (it may delete its own folder while running.)
{

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SERVICE=sonara
LAUNCHD_LABEL=com.sonara.server
PURGE=0
ASSUME_YES=0
REMOVE_APP=0
DATA="${SONARA_DATA_DIR:-$APP_DIR/data}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --purge) PURGE=1 ;;
    -y|--yes) ASSUME_YES=1 ;;
    --remove-app) REMOVE_APP=1 ;;
    --data-dir)
      [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || { echo "--data-dir requires a path" >&2; exit 1; }
      DATA="$2"; shift ;;
    -h|--help)
      echo "Usage: bash scripts/uninstall.sh [--purge] [--yes] [--remove-app] [--data-dir PATH]"
      echo "--purge deletes Sonara data; --remove-app deletes the checkout (requires --purge)."
      echo "--yes uses prompt defaults (keeps data and app unless explicitly requested)."
      echo "Data defaults to SONARA_DATA_DIR or the checkout's data directory."
      exit 0 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
  shift
done

# Validate deletion targets before stopping the service or deleting anything.
[[ $REMOVE_APP -eq 0 || $PURGE -eq 1 ]] || { echo "--remove-app requires --purge" >&2; exit 1; }
[[ "$APP_DIR" != / && -f "$APP_DIR/package.json" && -f "$APP_DIR/server/index.js" ]] || { echo "Cannot identify the Sonara app directory" >&2; exit 1; }
# Sonara resolves relative SONARA_DATA_DIR values from its working directory.
[[ "$DATA" == /* ]] || DATA="$APP_DIR/$DATA"
if [[ -L "$DATA" ]]; then
  echo "Refusing a symlink data directory; specify its real path with --data-dir" >&2; exit 1
fi
if [[ -d "$DATA" ]]; then
  DATA="$(cd "$DATA" && pwd -P)"
  [[ "$DATA" != / ]] || { echo "Refusing to use the filesystem root as a data directory" >&2; exit 1; }
  case "$APP_DIR/" in
    "$DATA/"*) echo "Data directory must not contain the app directory" >&2; exit 1 ;;
  esac
fi

if [[ -t 1 ]]; then
  B=$'\e[1m'; D=$'\e[2m'; R=$'\e[0m'; P=$'\e[38;5;141m'; G=$'\e[38;5;114m'; Y=$'\e[38;5;221m'; E=$'\e[38;5;203m'
else B= D= R= P= G= Y= E=; fi
step() { echo; echo "${P}${B}▸ $*${R}"; }
ok()   { echo "  ${G}✓${R} $*"; }
warn() { echo "  ${Y}!${R} $*"; }
as_root() { if [[ $EUID -eq 0 ]]; then "$@"; else sudo "$@"; fi; }
as_user() { if [[ $EUID -eq 0 && -n "${SUDO_USER:-}" ]]; then sudo -u "$SUDO_USER" -H "$@"; else "$@"; fi; }
confirm() {
  local q="$1" def="${2:-N}" ans
  if [[ $ASSUME_YES -eq 1 || ! -t 0 ]]; then [[ "$def" =~ ^[Yy] ]]; return; fi
  read -r -p "  $q (y/n) ${D}[${def}]${R} " ans </dev/tty || true
  [[ "${ans:-$def}" =~ ^[Yy] ]]
}

echo; echo "${P}${B}   ▂▅█▅▂  Uninstalling Sonara${R}  ${D}${APP_DIR}${R}"
echo "  ${D}Your music files will not be touched.${R}"

# ───────── Service ─────────
step "Removing the background service"
RUN_USER="${SUDO_USER:-$(id -un)}"
if [[ "$(uname -s)" == "Linux" ]] && command -v systemctl >/dev/null 2>&1 && [[ -f "/etc/systemd/system/${SERVICE}.service" ]]; then
  # Never delete data if stopping the server fails.
  as_root systemctl stop "${SERVICE}.service"
  as_root systemctl disable "${SERVICE}.service"
  as_root rm -f "/etc/systemd/system/${SERVICE}.service"
  as_root systemctl daemon-reload
  ok "systemd service removed"
elif [[ "$(uname -s)" == "Darwin" ]]; then
  USER_HOME="$(eval echo "~$RUN_USER")"
  PLIST="$USER_HOME/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"
  as_user launchctl bootout "gui/$(id -u "$RUN_USER")/${LAUNCHD_LABEL}" >/dev/null 2>&1 || true
  if [[ -f "$PLIST" ]]; then rm -f "$PLIST"; ok "launchd agent removed"; else ok "No launchd agent found"; fi
else
  ok "No service found"
fi

# ───────── Dependencies ─────────
step "Removing dependencies"
rm -rf "$APP_DIR/node_modules"
ok "node_modules removed"

# ───────── Data ─────────
step "Your Sonara data"
if [[ -d "$DATA" ]]; then
  if [[ $PURGE -eq 1 ]] || confirm "Delete Sonara's database, logins, playlists and cover cache in $DATA?" N; then
    rm -rf "$DATA"
    ok "Data deleted"
  else
    ok "Data kept in $DATA (reinstall any time to pick up where you left off)"
  fi
else
  ok "No data folder"
fi

# ───────── App folder ─────────
# Keeping data inside the checkout is incompatible with deleting the checkout.
if [[ -e "$APP_DIR/data" || -L "$APP_DIR/data" ]]; then
  warn "Keeping the app folder because it still contains data. Use --purge to remove it."
elif [[ $REMOVE_APP -eq 1 ]] || confirm "Also delete the Sonara app folder itself ($APP_DIR)?" N; then
  cd /
  rm -rf "$APP_DIR"
  echo; echo "${G}${B}  ✓ Sonara has been completely removed.${R}"; echo
  exit 0
fi

echo; echo "${G}${B}  ✓ Sonara has been uninstalled.${R}  ${D}Run scripts/install.sh to reinstall.${R}"; echo
exit 0
}
