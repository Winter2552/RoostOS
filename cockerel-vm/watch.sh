#!/usr/bin/env bash
# Shows what Cockerel is doing, live. Opens by itself on the VM desktop
# (see cockerel-watch.desktop); you can also run it in any terminal.
LOG=/var/log/cockerel/live.log
clear
echo "=== Cockerel, live (Ctrl+C to close) ==="
if ip link show wg0 >/dev/null 2>&1; then echo "VPN: up"; else echo "VPN: DOWN"; fi
if systemctl is-active --quiet cockerel; then echo "Service: running"; else echo "Service: NOT running"; fi
echo "-----------------------------------------"
[ -f "$LOG" ] || echo "Nothing yet. He wakes when Roost sends him something."
exec tail -n 40 -F "$LOG" 2>/dev/null
