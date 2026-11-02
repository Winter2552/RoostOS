#!/usr/bin/env bash
# Updates Cockerel's VM from GitHub. Started as root by cockerel-update.service
# when Roost's "Update all" button leaves /var/lib/cockerel/update-request.
# Reports in /var/lib/cockerel/update-status.json, which Roost reads.
set -u
DIR=/var/lib/cockerel
rm -f "$DIR/update-request"

st() { # state detail from to
  node -e 'const fs=require("fs");const [s,d,f,t]=process.argv.slice(1);const p=process.env.DIR+"/update-status.json";fs.writeFileSync(p+".tmp",JSON.stringify({state:s,detail:String(d).slice(-300),from:f,to:t,at:new Date().toISOString()}));fs.renameSync(p+".tmp",p)' "$1" "${2:-}" "${3:-}" "${4:-}" 2>/dev/null
}
export DIR

REPO="$(grep '^UPDATE_REPO=' /etc/cockerel/env 2>/dev/null | cut -d= -f2-)"
if [ -z "$REPO" ]; then
  for d in /home/*/RoostOS /root/RoostOS /root/roost; do [ -d "$d/.git" ] && { REPO="$d"; break; }; done
fi
[ -n "$REPO" ] && [ -d "$REPO/.git" ] || { st failed "Can't find the RoostOS folder on this VM. Set UPDATE_REPO in /etc/cockerel/env."; exit 1; }
OWNER="$(stat -c %U "$REPO")"
as() { runuser -u "$OWNER" -- "$@"; }

st running "Fetching the new version"
FROM="$(as git -C "$REPO" rev-parse --short HEAD)"
if ! OUT="$(as git -C "$REPO" pull --ff-only 2>&1)"; then st failed "$OUT" "$FROM"; exit 1; fi
TO="$(as git -C "$REPO" rev-parse --short HEAD)"
if [ "$FROM" = "$TO" ]; then st current "Already up to date" "$FROM" "$TO"; exit 0; fi

st running "Installing the new version" "$FROM" "$TO"
if ! OUT="$(bash "$REPO/cockerel-vm/setup-vm.sh" --no-desktop 2>&1)"; then st failed "$OUT" "$FROM" "$TO"; exit 1; fi
systemctl daemon-reload
st done "Updated" "$FROM" "$TO"
systemctl restart cockerel
