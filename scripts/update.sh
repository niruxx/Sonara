#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  Sonara updater for Linux and macOS
#
#  Pulls the latest code from git, refreshes dependencies if they changed and
#  restarts the service. Your data is never touched:
#    • data/  (database, logins, playlists, favourites, cover art, config) is git-ignored
#    • your music folders live outside the app entirely
#  A database snapshot is saved to data/backups/ before every update.
#
#  Usage:  ./scripts/update.sh [--force]     (--force stashes local code edits)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# The whole script lives in a { } block so bash parses it fully before running.
# (git pull may replace this very file while it executes.)
{

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE=sonara
LAUNCHD_LABEL=com.sonara.server
FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

if [[ -t 1 ]]; then
  B=$'\e[1m'; D=$'\e[2m'; R=$'\e[0m'; P=$'\e[38;5;141m'; G=$'\e[38;5;114m'; Y=$'\e[38;5;221m'; E=$'\e[38;5;203m'
else B= D= R= P= G= Y= E=; fi
step() { echo; echo "${P}${B}▸ $*${R}"; }
ok()   { echo "  ${G}✓${R} $*"; }
warn() { echo "  ${Y}!${R} $*"; }
die()  { echo; echo "  ${E}✗ $*${R}" >&2; exit 1; }
as_root() { if [[ $EUID -eq 0 ]]; then "$@"; else sudo "$@"; fi; }
as_user() { if [[ $EUID -eq 0 && -n "${SUDO_USER:-}" ]]; then sudo -u "$SUDO_USER" -H "$@"; else "$@"; fi; }
git_() { as_user git -c safe.directory="$APP_DIR" -C "$APP_DIR" "$@"; }

echo; echo "${P}${B}   ▂▅█▅▂  Updating Sonara${R}  ${D}${APP_DIR}${R}"

command -v git >/dev/null 2>&1 || die "git is not installed."
command -v node >/dev/null 2>&1 || die "Node.js is not installed. Run scripts/install.sh first."
[[ -d "$APP_DIR/.git" ]] || die "$APP_DIR is not a git checkout, so it can't be updated with git. Re-install by cloning the repository."

# ───────── Safety checks ─────────
step "Checking your installation"
if [[ -n "$(git_ status --porcelain --untracked-files=no)" ]]; then
  if [[ $FORCE -eq 1 ]]; then
    git_ stash push -m "sonara-update-$(date +%Y%m%d-%H%M%S)" >/dev/null
    warn "Local code changes were stashed (see: git stash list)."
  else
    git_ status --short --untracked-files=no
    die "You have local changes to Sonara's code (shown above). Commit them, or re-run with --force to stash them."
  fi
fi
BRANCH="$(git_ rev-parse --abbrev-ref HEAD)"
ok "On branch ${BRANCH}"

# ───────── Backup ─────────
step "Backing up your database"
cd "$APP_DIR"
as_user node --disable-warning=ExperimentalWarning scripts/backup.js | sed 's/^/  /'

# ───────── Pull ─────────
step "Fetching updates"
OLD="$(git_ rev-parse HEAD)"
git_ fetch --prune --quiet
git_ pull --ff-only --quiet || die "Couldn't fast-forward. Your branch has diverged from upstream — resolve it with git manually."
NEW="$(git_ rev-parse HEAD)"

if [[ "$OLD" == "$NEW" ]]; then
  ok "Already up to date ($(git_ rev-parse --short HEAD))"
else
  ok "Updated $(git_ rev-parse --short "$OLD") → $(git_ rev-parse --short "$NEW")"
  git_ --no-pager log --oneline --no-decorate "$OLD..$NEW" | head -20 | sed 's/^/    • /'
fi

# ───────── Dependencies ─────────
if [[ "$OLD" != "$NEW" ]] && git_ diff --quiet "$OLD" "$NEW" -- package.json package-lock.json && [[ -d node_modules ]]; then
  ok "Dependencies unchanged"
elif [[ "$OLD" != "$NEW" || ! -d node_modules ]]; then
  step "Updating dependencies"
  as_user npm ci --omit=dev --no-audit --no-fund
  ok "Dependencies installed"
fi

# ───────── Restart ─────────
step "Restarting Sonara"
if [[ "$OLD" == "$NEW" ]]; then
  ok "No restart needed"
elif [[ -f "/etc/systemd/system/${SERVICE}.service" ]]; then
  as_root systemctl restart "$SERVICE"
  ok "systemd service restarted"
elif [[ "$(uname -s)" == "Darwin" ]] && launchctl print "gui/$(id -u "${SUDO_USER:-$(id -un)}")/${LAUNCHD_LABEL}" >/dev/null 2>&1; then
  as_user launchctl kickstart -k "gui/$(id -u "${SUDO_USER:-$(id -un)}")/${LAUNCHD_LABEL}"
  ok "launchd agent restarted"
else
  warn "No Sonara service found. If you run it manually, restart it now (npm start)."
fi

echo; echo "${G}${B}  ✓ Sonara is up to date.${R}  ${D}Database migrations run automatically on start.${R}"; echo
exit 0
}
