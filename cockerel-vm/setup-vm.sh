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
# If any step fails, say which one last, so Roost can show it instead of the end of apt's chatter.
trap 'echo "SETUP FAILED at line $LINENO: $BASH_COMMAND" >&2' ERR
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
cp "$HERE"/*.js "$HERE"/*.sh "$HERE"/live.html "$HERE"/nftables.conf.template /opt/cockerel/
cp "$HERE/CLAUDE.md" /home/cockerel/cockerel/CLAUDE.md
chown cockerel:cockerel /home/cockerel/cockerel/CLAUDE.md
chmod +x /opt/cockerel/*.sh /opt/cockerel/tool.js
ln -sf /opt/cockerel/tool.js /usr/local/bin/cockerel-tool
ln -sf /opt/cockerel/watch.sh /usr/local/bin/cockerel-watch
cp "$HERE/cockerel.service" "$HERE/cockerel-update.service" "$HERE/cockerel-update.path" /etc/systemd/system/
install -d -m 755 /etc/xdg/autostart
cp "$HERE/cockerel-watch.desktop" /etc/xdg/autostart/cockerel-watch.desktop
cp "$HERE/cockerel-watch.desktop" /usr/share/applications/cockerel-watch.desktop
cp "$HERE/claude-code.desktop" "$HERE/claude-remote.desktop" /usr/share/applications/
cp "$HERE/claude-code-autostart.desktop" /etc/xdg/autostart/claude-code.desktop
# Undo the earlier cockerel auto-login: the desktop is Raven's own login.
rm -f /etc/lightdm/lightdm.conf.d/50-cockerel-autologin.conf

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
# Cockerel's own Claude (his service) stays as it was. Drop the deny rules the earlier version put in his settings.
sudo -u cockerel -H node -e '
const fs=require("fs"),p=process.env.HOME+"/.claude/settings.json";
try{const o=JSON.parse(fs.readFileSync(p,"utf8"));
const rm=new Set(["Read(/etc/wireguard/**)","Read(/etc/cockerel/**)","Read(/home/cockerel/.ssh/**)","Bash(sudo:*)"]);
if(o.permissions&&o.permissions.deny){o.permissions.deny=o.permissions.deny.filter(x=>!rm.has(x));fs.writeFileSync(p,JSON.stringify(o,null,2))}}catch{}
' || true

# Raven's own Claude Code (his login on the VM desktop, separate from Cockerel's).
RAVEN_USER="$(grep '^RAVEN_USER=' /etc/cockerel/env 2>/dev/null | cut -d= -f2- || true)"
RAVEN_USER="${RAVEN_USER:-raven}"
if id "$RAVEN_USER" >/dev/null 2>&1; then
  if [ ! -x "/home/$RAVEN_USER/.local/bin/claude" ]; then
    sudo -u "$RAVEN_USER" -H bash -lc 'curl -fsSL https://claude.ai/install.sh | bash' || echo "Claude Code did not install for $RAVEN_USER."
  else
    sudo -u "$RAVEN_USER" -H bash -lc '"$HOME/.local/bin/claude" update' >/dev/null 2>&1 || true
  fi
  sudo -u "$RAVEN_USER" -H mkdir -p "/home/$RAVEN_USER/claude-work" "/home/$RAVEN_USER/Desktop"
  # Icons on his desktop, so they are there without logging out and in.
  for f in claude-code claude-remote; do
    D="/home/$RAVEN_USER/Desktop/$f.desktop"
    install -m 755 -o "$RAVEN_USER" -g "$RAVEN_USER" "$HERE/$f.desktop" "$D"
    sudo -u "$RAVEN_USER" -H gio set "$D" metadata::xfce-exe-checksum "$(sha256sum "$D" | cut -d' ' -f1)" >/dev/null 2>&1 || true
  done
  # Safety rails for his session: never read the VPN or Cockerel secrets, never sudo, stay out of the media share.
  sudo -u "$RAVEN_USER" -H node -e '
const fs=require("fs"),p=process.env.HOME+"/.claude/settings.json";
let o={};try{o=JSON.parse(fs.readFileSync(p,"utf8"))}catch{}
o.permissions=o.permissions||{};
const deny=new Set(o.permissions.deny||[]);
["Read(/etc/wireguard/**)","Read(/etc/cockerel/**)","Read(/home/cockerel/**)","Read(/srv/media/**)","Bash(sudo:*)"].forEach(x=>deny.add(x));
o.permissions.deny=[...deny];
fs.mkdirSync(require("path").dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(o,null,2));
' || true
else
  echo "No '$RAVEN_USER' user on this VM, so no desktop Claude was set up. Set RAVEN_USER=<name> in /etc/cockerel/env and run this again."
fi

systemctl daemon-reload
systemctl enable --now cockerel-update.path
echo
echo "Installed. Next steps are in README.md. Your shared secret is:"
grep COCKEREL_SECRET /etc/cockerel/env
