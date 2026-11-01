#!/bin/sh
# Keeps the "vmshim" link alive on the ZimaOS host so Roost can reach Cockerel's
# bridged VM (a bridged VM and its own host cannot talk directly). Checks once a
# minute and only changes anything that is missing, so it is safe to restart.
VM_IP="${VM_IP:-192.168.4.148}"
PARENT="${PARENT:-eth0}"
SHIM_IP="${SHIM_IP:-192.168.7.250}"
while true; do
  ip link show vmshim >/dev/null 2>&1 || ip link add vmshim link "$PARENT" type macvlan mode bridge
  ip addr show dev vmshim | grep -q "$SHIM_IP" || ip addr add "$SHIM_IP/32" dev vmshim
  ip link set vmshim up
  ip route replace "$VM_IP/32" dev vmshim
  sleep 60
done
