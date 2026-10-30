#!/usr/bin/env bash
# Installs Cockerel inside a fresh Debian 12 VM. Run as root:
#
#   sudo bash setup-vm.sh [--no-desktop]
#
# It installs the packages, makes the `cockerel` user, puts the code in
# /opt/cockerel and the service in systemd. It does NOT start the service or
# turn on the VPN: follow README.md for the rest (Windscribe, Claude sign-in,
# the shared folders, then linking him in Roost).
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run this as root (sudo)."; exit 1; }
DESKTOP=1
[ "${1:-}" = "--no-desktop" ] && DESKTOP=0
HERE="$(cd "$(dirname "$0")" && pwd)"

export DEBIAN_FRONTEND=noninteractive
apt-get update
# Small and boring: Node for his service, aria2 to download, ffmpeg for a sanity check, WireGuard + nftables for the VPN.
apt-get install -y --no-install-recommends ca-certificates curl nodejs aria2 ffmpeg wireguard-tools openresolv nftables cifs-utils sudo openssh-server qemu-guest-agent
if [ "$DESKTOP" = 1 ]; then
  # A light desktop (XFCE) with a browser, shown in the ZimaOS VM console.
  apt-get install -y --no-install-recommends xfce4 xfce4-terminal lightdm chromium dbus-x11 xserver-xorg
fi

id cockerel >/dev/null 2>&1 || useradd --create-home --shell /bin/bash cockerel
install -d -o cockerel -g cockerel -m 700 /home/cockerel/cockerel /home/cockerel/cockerel/state
install -d -m 755 /opt/cockerel /srv/media
install -d -m 750 -o root -g cockerel /etc/cockerel
cp "$HERE"/*.js "$HERE"/*.sh "$HERE"/nftables.conf.template /opt/cockerel/
cp "$HERE/CLAUDE.md" /home/cockerel/cockerel/CLAUDE.md
chown cockerel:cockerel /home/cockerel/cockerel/CLAUDE.md
chmod +x /opt/cockerel/*.sh /opt/cockerel/tool.js
ln -sf /opt/cockerel/tool.js /usr/local/bin/cockerel-tool
cp "$HERE/cockerel.service" /etc/systemd/system/cockerel.service

if [ ! -f /etc/cockerel/env ]; then
  SECRET="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  cat > /etc/cockerel/env <<ENV
# Cockerel's settings. Paste COCKEREL_SECRET into Roost (Admin → Server → Cockerel).
COCKEREL_SECRET=$SECRET
ROOST_URL=http://192.168.4.35:8080
MEDIA_ROOT=/srv/media
INCOMING_DIR=/srv/media/incoming
MAX_RUNS_PER_DAY=60
ENV
  chown root:cockerel /etc/cockerel/env
  chmod 640 /etc/cockerel/env
fi

# Claude Code, for his user only (his sign-in lives in /home/cockerel).
if ! sudo -u cockerel -H bash -lc 'command -v claude' >/dev/null 2>&1; then
  sudo -u cockerel -H bash -lc 'curl -fsSL https://claude.ai/install.sh | bash' || echo "Claude Code did not install; see README.md step 4."
fi
ln -sf /home/cockerel/.local/bin/claude /usr/local/bin/claude

systemctl daemon-reload
echo
echo "Installed. Next steps are in README.md. Your shared secret is:"
grep COCKEREL_SECRET /etc/cockerel/env
