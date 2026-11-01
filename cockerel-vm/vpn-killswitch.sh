#!/usr/bin/env bash
# Sets up the Windscribe WireGuard tunnel and the kill switch in Cockerel's VM.
# Run as root, after saving the config you made on windscribe.com
# (Account → Config Generators → WireGuard) as /etc/wireguard/wg0.conf:
#
#   sudo bash vpn-killswitch.sh <roost-ip> [home-network]
#   e.g. sudo bash vpn-killswitch.sh 192.168.4.35 192.168.4.0/24
#
# Afterwards run leak-test.sh. Windscribe keys are tied to your account, so
# the config never goes into Roost or Git.
set -euo pipefail

ROOST="${1:-}"
LAN="${2:-192.168.4.0/24}"
CONF=/etc/wireguard/wg0.conf
[ "$(id -u)" = 0 ] || { echo "Run this as root (sudo)."; exit 1; }
[ -n "$ROOST" ] || { echo "Usage: sudo bash $0 <roost-ip> [home-network]"; exit 1; }
[ -f "$CONF" ] || { echo "Save your Windscribe WireGuard config as $CONF first."; exit 1; }
chmod 600 "$CONF"

ENDPOINT="$(awk -F'[= :]+' '/^Endpoint/ {print $2; exit}' "$CONF")"
case "$ENDPOINT" in
  *[a-zA-Z]*) ENDPOINT="$(getent ahostsv4 "$ENDPOINT" | awk '{print $1; exit}')" ;;
esac
[ -n "$ENDPOINT" ] || { echo "No Endpoint found in $CONF."; exit 1; }
PORT="$(awk -F'[= :]+' '/^Endpoint/ {print $3; exit}' "$CONF")"
case "$PORT" in ''|*[!0-9]*) echo "No port found on the Endpoint line in $CONF."; exit 1 ;; esac
# The firewall blocks DNS outside the tunnel, so the tunnel must start from an
# address, not a name. Keep a copy of the original config.
if grep -qE '^Endpoint[[:space:]]*=[[:space:]]*[^0-9]' "$CONF"; then
  cp -n "$CONF" "$CONF.orig"
  sed -i -E "s|^Endpoint[[:space:]]*=.*|Endpoint = $ENDPOINT:$PORT|" "$CONF"
fi

# Let the firewall's rules replace the file in place, and remember the old one.
[ -f /etc/nftables.conf ] && cp -n /etc/nftables.conf /etc/nftables.conf.before-cockerel
sed -e "s#@LAN@#$LAN#g" -e "s#@ROOST@#$ROOST#g" -e "s#@ENDPOINT@#$ENDPOINT#g" -e "s#@PORT@#$PORT#g" "$(dirname "$0")/nftables.conf.template" > /etc/nftables.conf
nft -c -f /etc/nftables.conf
nft -f /etc/nftables.conf

systemctl enable --now nftables
systemctl enable --now wg-quick@wg0
echo "Tunnel and kill switch are on. Endpoint $ENDPOINT, home network $LAN, Roost $ROOST."
echo "Now run: sudo bash $(dirname "$0")/leak-test.sh <your-home-public-ip>"
