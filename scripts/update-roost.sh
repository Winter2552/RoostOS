#!/usr/bin/env bash
# Updates Roost on the server, from SSH. Run it as the user you use for docker:
#
#   curl -fsSL https://raw.githubusercontent.com/Winter2552/RoostOS/main/scripts/update-roost.sh -o update-roost.sh
#   bash update-roost.sh            # shows what is new, asks, then updates
#
# Options:  -y  don't ask         --check  only show what is new
# Optional: a folder as the first word (default: the folder you are in if it is
# Roost's, else /DATA/AppData/roost-src). Environment: ROOST_DIR, ROOST_REPO,
# ROOST_BRANCH, ROOST_HEALTH_WAIT (seconds to wait for Roost to start, 150).
#
# What it does, in order, stopping with a message if anything looks wrong:
#   1. finds Docker and the Roost folder (cloning it first if it isn't there yet)
#   2. looks at GitHub and lists what is new
#   3. brings the new code in (fast-forward only), keeping edits you made by hand
#   4. rebuilds and restarts Roost and its services with docker compose
#   5. waits for Roost to report healthy, and goes back to the old version if not
# Your accounts, files and settings live outside this folder and are not touched.
# After the first run, updates can be done from Roost: Admin → Updates.

set -uo pipefail

REPO_URL="${ROOST_REPO:-https://github.com/Winter2552/RoostOS}"
BRANCH="${ROOST_BRANCH:-main}"
HEALTH_WAIT="${ROOST_HEALTH_WAIT:-150}"
DEFAULT_DIR="/DATA/AppData/roost-src"
PROJECT="roost"
ASSUME_YES=0
CHECK_ONLY=0
DIR="${ROOST_DIR:-}"

for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    --check) CHECK_ONLY=1 ;;
    -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "Unknown option $arg (try --help)"; exit 2 ;;
    *) DIR="$arg" ;;
  esac
done

say() { printf '%s\n' "$*"; }
fail() { printf '\nStopped: %s\n' "$*" >&2; exit 1; }
nap() { sleep "${ROOST_SLEEP:-3}"; }

# ---------- 1. Docker and the folder ----------

command -v git >/dev/null 2>&1 || fail "git isn't installed on this server."
command -v docker >/dev/null 2>&1 || fail "docker isn't installed on this server."

DOCKER=(docker)
if ! docker info >/dev/null 2>&1; then
  if command -v sudo >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
    DOCKER=(sudo docker)
  elif command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
    DOCKER=(sudo docker)
  else
    fail "this user can't use Docker. Log in as the user ZimaOS gives Docker access, or run this with sudo."
  fi
fi
compose() { "${DOCKER[@]}" compose -p "$PROJECT" "$@"; }

if [ -z "$DIR" ]; then
  if [ -f docker-compose.yml ] && grep -q '^name: roost' docker-compose.yml; then DIR="$PWD"; else DIR="$DEFAULT_DIR"; fi
fi

if [ ! -e "$DIR" ] || [ -z "$(ls -A "$DIR" 2>/dev/null)" ]; then
  say "Roost's files aren't at $DIR yet, getting them from $REPO_URL ..."
  mkdir -p "$DIR" 2>/dev/null || { sudo mkdir -p "$DIR" && sudo chown "$(id -u):$(id -g)" "$DIR"; } || fail "couldn't create $DIR."
  git clone --quiet --branch "$BRANCH" "$REPO_URL" "$DIR" || fail "couldn't download Roost from $REPO_URL."
fi

cd "$DIR" || fail "can't open $DIR."
DIR="$PWD"
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1 || [ "$(git rev-parse --show-toplevel)" != "$DIR" ]; then
  fail "$DIR isn't a git copy of Roost, so it can't be updated safely.
  Keep your old folder, then get a git copy next to it:
    mv $DIR $DIR.old
    git clone $REPO_URL $DIR
  and copy the lines you changed in the old docker-compose.yml (drive folders, time zone)
  into a new $DIR/docker-compose.override.yml. Then run this script again."
fi
[ -f docker-compose.yml ] && grep -q '^name: roost' docker-compose.yml || fail "$DIR doesn't look like Roost's folder (no docker-compose.yml named roost)."

# Roost must have been started from this folder's compose file, or the restart would clash.
owner=$("${DOCKER[@]}" inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' roost 2>/dev/null || true)
if [ -n "$owner" ] && [ "$owner" != "$PROJECT" ]; then
  fail "Roost is running as compose project \"$owner\" (probably imported through ZimaOS), so this script can't restart it safely.
  Remove that app in ZimaOS once (your data stays), then run this script again."
fi

# ---------- 2. what is new ----------

say "Looking at GitHub ..."
git fetch --quiet origin "$BRANCH" || fail "couldn't reach GitHub ($REPO_URL)."
old_head=$(git rev-parse HEAD)
behind=$(git rev-list --count "HEAD..origin/$BRANCH")
ahead=$(git rev-list --count "origin/$BRANCH..HEAD")
[ "$ahead" = 0 ] || fail "this folder has $ahead change(s) of its own that aren't on GitHub, so it can't be updated by fast-forward."

if [ "$behind" = 0 ]; then
  say "Roost's files are already up to date ($(git rev-parse --short HEAD))."
  [ "$CHECK_ONLY" = 1 ] && exit 0
else
  say "$behind change(s) waiting:"
  git log --format='  %h  %s' -n 25 "HEAD..origin/$BRANCH"
  [ "$behind" -gt 25 ] && say "  ... and $((behind - 25)) more"
fi
[ "$CHECK_ONLY" = 1 ] && exit 0

if [ "$ASSUME_YES" = 0 ]; then
  say ""
  say "Updating rebuilds Roost: it is unavailable for a minute or two."
  printf 'Update now? [y/N] '
  answer=n
  { read -r answer < /dev/tty; } 2>/dev/null || answer=n
  case "$answer" in y|Y|yes) ;; *) say "Okay, nothing changed."; exit 0 ;; esac
fi

# ---------- 3. bring in the new code, keeping hand edits ----------

stamp=$(date +%Y%m%d-%H%M%S)
stashed=0
if ! git diff --quiet HEAD; then
  patch="$(dirname "$DIR")/roost-local-changes-$stamp.patch"
  git diff HEAD > "$patch"
  say "You have edits in this folder ($(git diff --name-only HEAD | tr '\n' ' ')). A copy is saved at $patch."
  git stash push --quiet -m "update-roost $stamp" || fail "couldn't set your edits aside."
  stashed=1
fi

if [ "$behind" != 0 ]; then
  git merge --quiet --ff-only "origin/$BRANCH" || { [ "$stashed" = 1 ] && git stash pop --quiet; fail "couldn't bring in the new code."; }
fi

if [ "$stashed" = 1 ]; then
  if ! git stash pop --quiet; then
    # Back to exactly how it was, edits and all.
    git reset --quiet --hard "$old_head"
    git stash pop --quiet 2>/dev/null
    fail "your edits clash with this update, so nothing was changed.
  Your edits are saved at $patch. Keep your own settings (drive folders, time zone) in
  docker-compose.override.yml instead, put the original docker-compose.yml back
  (git checkout docker-compose.yml), and run this script again."
  fi
fi

# The updater service mounts this folder; if it isn't at the default place, say where.
if [ "$DIR" != "$DEFAULT_DIR" ] && [ ! -e docker-compose.override.yml ]; then
  printf 'services:\n  roost-updater:\n    volumes:\n      - %s:/src\n' "$DIR" > docker-compose.override.yml
  say "Wrote docker-compose.override.yml so Admin → Updates finds this folder ($DIR)."
elif [ "$DIR" != "$DEFAULT_DIR" ] && ! grep -q 'roost-updater' docker-compose.override.yml; then
  say "Note: add  $DIR:/src  to roost-updater's volumes in docker-compose.override.yml so Admin → Updates finds this folder."
fi

# ---------- 4. rebuild and restart ----------

for service in roost roost-backup; do
  ref=$("${DOCKER[@]}" inspect -f '{{.Config.Image}}' "$service" 2>/dev/null || true)
  [ -n "$ref" ] && "${DOCKER[@]}" tag "$ref" "${ref%%:*}:previous" >/dev/null 2>&1
  [ -n "$ref" ] && prev_refs="${prev_refs:-} ${ref%%:*}"
done

say ""
say "Building the new version (the first time takes a few minutes) ..."
if ! compose build; then
  git reset --quiet --keep "$old_head"
  fail "the new version didn't build. Nothing running was changed, and the files are back on the old version."
fi

say "Restarting ..."
rollback() {
  say "Putting the old version back ..."
  git reset --quiet --keep "$old_head"
  for repo in ${prev_refs:-}; do "${DOCKER[@]}" tag "$repo:previous" "$repo:latest" >/dev/null 2>&1; done
  compose up -d --no-build >/dev/null 2>&1
}

if ! compose up -d; then
  rollback
  fail "Roost couldn't be restarted on the new version. The old version was put back (check: docker ps)."
fi

# ---------- 5. wait for health ----------

say "Waiting for Roost to start ..."
waited=0
status=""
while [ "$waited" -lt "$HEALTH_WAIT" ]; do
  status=$("${DOCKER[@]}" inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' roost 2>/dev/null || true)
  case "$status" in healthy|running) break ;; unhealthy|exited|dead) break ;; esac
  nap
  waited=$((waited + 3))
done

case "$status" in
  healthy|running)
    say ""
    say "Done. Roost is running $(git rev-parse --short HEAD) ($behind change(s) installed)."
    say "From now on you can update from Roost: Admin → Updates."
    exit 0
    ;;
esac

say ""
say "The new version didn't start properly (${status:-no answer}). Its last log lines:"
"${DOCKER[@]}" logs --tail 15 roost 2>&1 | sed 's/^/  /'
rollback
fail "the new version didn't start, so the old one was put back. Send the log lines above to get it fixed."
