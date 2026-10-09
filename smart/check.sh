#!/bin/sh
# Every CHECK_EVERY seconds, save `smartctl --json` for each drive the
# container was given as OUT/<drive>.json, for Roost to read.
#
# A drive that is asleep is left asleep (-n standby): its last reading stays
# and Roost marks it as resting. A drive smartctl can't read gets
# OUT/<drive>.error instead, so Roost can say so rather than show old data.

OUT=${OUT:-/out}
CHECK_EVERY=${CHECK_EVERY:-3600}
DEVICES=${DEVICES:-"/dev/sd? /dev/nvme?n1"}

mkdir -p "$OUT"
while true; do
  for dev in $DEVICES; do
    [ -e "$dev" ] || continue
    name=${dev##*/}
    smartctl --all --json -n standby,3 "$dev" > "$OUT/.$name.tmp" 2>&1
    code=$?
    if [ "$code" -eq 3 ]; then
      # Asleep: keep the last reading.
      rm -f "$OUT/.$name.tmp"
      touch "$OUT/$name.asleep"
    elif [ $((code & 3)) -ne 0 ]; then
      # Bits 0-1: smartctl couldn't run or couldn't open the drive.
      mv "$OUT/.$name.tmp" "$OUT/$name.error"
    else
      # Higher bits are findings about the drive; the reading itself is good.
      mv "$OUT/.$name.tmp" "$OUT/$name.json"
      rm -f "$OUT/$name.error" "$OUT/$name.asleep"
    fi
  done
  date -u +%Y-%m-%dT%H:%M:%SZ > "$OUT/.checked.tmp" && mv "$OUT/.checked.tmp" "$OUT/checked"
  [ -n "$ONCE" ] && exit 0
  sleep "$CHECK_EVERY"
done
