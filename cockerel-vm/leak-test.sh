#!/usr/bin/env bash
# Proves the kill switch works. Run as root in the VM:  sudo bash leak-test.sh <home-public-ip>
#  1. with the tunnel up, the outside world must see a Windscribe address, not yours
#  2. with the tunnel taken down, nothing may get out at all
set -uo pipefail
HOME_IP="${1:-}"
[ -n "$HOME_IP" ] || { echo "Usage: sudo bash $0 <your-home-public-ip>   (find it at whatismyip.com on your PC)"; exit 1; }
fail=0

up="$(curl -s --max-time 15 https://api.ipify.org || true)"
if [ -z "$up" ]; then echo "FAIL: nothing got out with the tunnel up. Check wg-quick@wg0."; exit 1; fi
if [ "$up" = "$HOME_IP" ]; then echo "FAIL: traffic leaves from your home address ($up)."; fail=1; else echo "ok: tunnel up, outside sees $up (not $HOME_IP)"; fi

wg-quick down wg0 >/dev/null 2>&1
down="$(curl -s --max-time 8 https://api.ipify.org || true)"
if [ -n "$down" ]; then echo "FAIL: with the tunnel DOWN something still got out ($down)."; fail=1; else echo "ok: tunnel down, nothing leaves"; fi
if getent hosts example.com >/dev/null 2>&1; then echo "FAIL: DNS still answers with the tunnel down."; fail=1; else echo "ok: tunnel down, DNS is silent"; fi

wg-quick up wg0 >/dev/null 2>&1
[ "$fail" = 0 ] && echo "PASS: the kill switch holds." || echo "NOT SAFE: do not let Cockerel download until this passes."
exit "$fail"
