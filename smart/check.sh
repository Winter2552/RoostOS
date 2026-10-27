#!/bin/sh
# Every CHECK_EVERY seconds, save `smartctl --json` for each drive the
# container was given as OUT/<drive>.json, for Roost to read.
#
# It also writes OUT/sensors every SENSE_EVERY seconds: CPU power (from the
# processor's own energy counter), CPU temperature and a fan speed, whichever
# this machine has. Reading them is a few tiny file reads; nothing is spun up.
#
# A drive that is asleep is left asleep (-n standby): its last reading stays
# and Roost marks it as resting. A drive smartctl can't read gets
# OUT/<drive>.error instead, so Roost can say so rather than show old data.

OUT=${OUT:-/out}
CHECK_EVERY=${CHECK_EVERY:-3600}
SENSE_EVERY=${SENSE_EVERY:-60}
# The host's /sys, mounted read-only.
SYS=${SYS:-/hostsys}
DEVICES=${DEVICES:-"/dev/sd? /dev/nvme?n1"}

mkdir -p "$OUT"

# Writes OUT/sensors as key=value lines. A reading this machine can't give is
# left out, so Roost shows nothing rather than a made-up zero.
sense() {
  now=$(date +%s)
  lines="at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  # Power: the CPU package's energy counter (microjoules, ever-growing). Watts
  # are the change since the last reading, which is kept in OUT/.rapl.
  rapl=$SYS/class/powercap/intel-rapl:0
  if [ -r "$rapl/energy_uj" ]; then
    e=$(cat "$rapl/energy_uj" 2>/dev/null)
    if [ -n "$e" ]; then
      if read -r pe pt < "$OUT/.rapl" 2>/dev/null && [ "$now" -gt "$pt" ]; then
        d=$((e - pe))
        if [ "$d" -lt 0 ]; then
          # The counter wrapped around its maximum.
          max=$(cat "$rapl/max_energy_range_uj" 2>/dev/null || echo 0)
          d=$((d + max))
        fi
        [ "$d" -ge 0 ] && lines="$lines
power_mw=$((d / (now - pt) / 1000))"
      fi
      echo "$e $now" > "$OUT/.rapl"
    fi
  fi

  # Heat: the hottest CPU sensor, in millidegrees. Fan: the fastest one, in rpm.
  temp=; fan=
  for dir in "$SYS"/class/hwmon/hwmon*; do
    [ -d "$dir" ] || continue
    case $(cat "$dir/name" 2>/dev/null) in
      coretemp|k10temp|zenpower|cpu_thermal|acpitz)
        for f in "$dir"/temp*_input; do
          [ -r "$f" ] || continue
          t=$(cat "$f" 2>/dev/null)
          [ -n "$t" ] && { [ -z "$temp" ] || [ "$t" -gt "$temp" ]; } && temp=$t
        done ;;
    esac
    for f in "$dir"/fan*_input; do
      [ -r "$f" ] || continue
      r=$(cat "$f" 2>/dev/null)
      [ -n "$r" ] && [ "$r" -gt 0 ] && { [ -z "$fan" ] || [ "$r" -gt "$fan" ]; } && fan=$r
    done
  done
  [ -n "$temp" ] && lines="$lines
cpu_temp_mc=$temp"
  [ -n "$fan" ] && lines="$lines
fan_rpm=$fan"

  echo "$lines" > "$OUT/.sensors.tmp" && mv "$OUT/.sensors.tmp" "$OUT/sensors"
}

smart_round() {
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
}

last_smart=0
while true; do
  sense
  now=$(date +%s)
  if [ $((now - last_smart)) -ge "$CHECK_EVERY" ]; then
    smart_round
    last_smart=$now
  fi
  [ -n "$ONCE" ] && exit 0
  sleep "$SENSE_EVERY"
done
