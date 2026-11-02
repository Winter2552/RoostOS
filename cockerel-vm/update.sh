#!/usr/bin/env bash
# Checks for, and installs, Cockerel VM updates. Started as root by
# cockerel-update.service when Roost leaves /var/lib/cockerel/update-request
# ({"action":"check"} or {"action":"apply"}). It reports in
# /var/lib/cockerel/update-status.json, which Roost reads through /status.
set -u
export DIR=/var/lib/cockerel
ACTION="$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.env.DIR+"/update-request","utf8")).action||"apply")}catch{console.log("apply")}')"
rm -f "$DIR/update-request"

# st '{"state":"running"}': merges the fields into the status file.
st() {
  node -e 'const fs=require("fs");const p=process.env.DIR+"/update-status.json";let o={};try{o=JSON.parse(fs.readFileSync(p,"utf8"))}catch{}
const patch=JSON.parse(process.argv[1]);if(patch.detail)patch.detail=String(patch.detail).slice(-300);
fs.writeFileSync(p+".tmp",JSON.stringify({...o,...patch,at:new Date().toISOString()}));fs.renameSync(p+".tmp",p)' "$1" 2>/dev/null
}
js() { node -e 'console.log(JSON.stringify(process.argv[1]))' "$1"; }

REPO="$(grep '^UPDATE_REPO=' /etc/cockerel/env 2>/dev/null | cut -d= -f2-)"
if [ -z "$REPO" ]; then
  for d in /home/*/RoostOS /root/RoostOS /root/roost; do [ -d "$d/.git" ] && { REPO="$d"; break; }; done
fi
[ -n "$REPO" ] && [ -d "$REPO/.git" ] || { st "{\"state\":\"failed\",\"detail\":\"Can't find the RoostOS folder on this VM. Set UPDATE_REPO in /etc/cockerel/env.\"}"; exit 1; }
OWNER="$(stat -c %U "$REPO")"
as() { runuser -u "$OWNER" -- "$@"; }

# What is new for the VM: commits that touch cockerel-vm/ and aren't here yet.
check() {
  if ! OUT="$(as git -C "$REPO" fetch --quiet origin 2>&1)"; then st "{\"state\":\"failed\",\"detail\":$(js "$OUT")}"; return 1; fi
  local BEHIND COMMITS
  BEHIND="$(as git -C "$REPO" rev-list --count 'HEAD..@{u}' -- cockerel-vm)"
  COMMITS="$(as git -C "$REPO" log --format='%h%x09%s' -n 15 'HEAD..@{u}' -- cockerel-vm | node -e 'const l=require("fs").readFileSync(0,"utf8").split("\n").filter(Boolean).map(x=>{const[a,...b]=x.split("\t");return{sha:a,subject:b.join(" ")}});console.log(JSON.stringify(l))')"
  st "{\"state\":\"idle\",\"behind\":$BEHIND,\"commits\":$COMMITS,\"head\":\"$(as git -C "$REPO" rev-parse --short HEAD)\",\"checkedAt\":\"$(date -u +%FT%TZ)\"}"
}

if [ "$ACTION" = check ]; then check; exit 0; fi

st '{"state":"running","detail":"Fetching the new version"}'
FROM="$(as git -C "$REPO" rev-parse --short HEAD)"
if ! OUT="$(as git -C "$REPO" pull --ff-only 2>&1)"; then st "{\"state\":\"failed\",\"detail\":$(js "$OUT"),\"from\":\"$FROM\"}"; exit 1; fi
TO="$(as git -C "$REPO" rev-parse --short HEAD)"
if [ "$FROM" = "$TO" ]; then st "{\"state\":\"current\",\"behind\":0,\"commits\":[],\"from\":\"$FROM\",\"to\":\"$TO\"}"; exit 0; fi

st "{\"state\":\"running\",\"detail\":\"Installing the new version\",\"from\":\"$FROM\",\"to\":\"$TO\"}"
if ! OUT="$(bash "$REPO/cockerel-vm/setup-vm.sh" --no-desktop 2>&1)"; then st "{\"state\":\"failed\",\"detail\":$(js "$OUT"),\"from\":\"$FROM\",\"to\":\"$TO\"}"; exit 1; fi
systemctl daemon-reload
st "{\"state\":\"done\",\"detail\":\"Updated\",\"behind\":0,\"commits\":[],\"head\":\"$TO\",\"checkedAt\":\"$(date -u +%FT%TZ)\"}"
systemctl restart cockerel
