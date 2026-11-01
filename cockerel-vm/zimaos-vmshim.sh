#!/usr/bin/env bash
# Run on the ZimaOS host (not in the VM): lets Roost reach Cockerel's VM.
# A bridged VM and its own host cannot talk directly; this adds a small link
# on the host that can. Safe to run again. Usage: sudo bash zimaos-vmshim.sh <vm-ip>
set -euo pipefail
VM="${1:?Usage: sudo bash $0 <vm-ip>}"
ip link show vmshim >/dev/null 2>&1 || ip link add vmshim link eth0 type macvlan mode bridge
ip addr show dev vmshim | grep -q 192.168.7.250 || ip addr add 192.168.7.250/32 dev vmshim
ip link set vmshim up
ip route replace "$VM/32" dev vmshim
echo "vmshim ready for $VM. It does not survive a ZimaOS reboot: run this again after one."
