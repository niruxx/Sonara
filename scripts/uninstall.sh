#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  Sonara uninstaller for Linux and macOS
#
#  Removes the background service and installed dependencies.
#  Your music files are NEVER touched. Your Sonara data (database, logins,
#  playlists, cover cache) is kept unless you pass --purge or confirm deletion.
#
#  Usage:  ./scripts/uninstall.sh [--purge] [--yes]
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# The whole script lives in a { } block so bash parses it fully before running.
# (it may delete its own folder while running.)
{

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE=sonara
LAUNCHD_LABEL=com.sonara.server
PURGE=0
ASSUME_YES=0
for a in "$@"; do
  case "$a" in
    --purge) PURGE=1 ;;
    -y|--yes) ASSUME_YES=1 ;;
    -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $a"; exit 1 ;;
  esac
done

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
  as_root systemctl disable --now "$SERVICE" >/dev/null 2>&1 || true
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
DATA="$APP_DIR/data"
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
if confirm "Also delete the Sonara app folder itself ($APP_DIR)?" N; then
  cd /
  rm -rf "$APP_DIR"
  echo; echo "${G}${B}  ✓ Sonara has been completely removed.${R}"; echo
  exit 0
fi

echo; echo "${G}${B}  ✓ Sonara has been uninstalled.${R}  ${D}Run scripts/install.sh to reinstall.${R}"; echo
exit 0
}
