'use strict';

// "Away from home": a WireGuard server inside Roost so a phone or PC outside the
// house can reach the home network (SSH to the server, Roost's Admin, the router).
// Roost makes the server key and one key pair per device; a device's private key
// is shown once in its QR code / config file and never kept. Only the home
// network goes through the tunnel (split tunnel), so browsing stays on the
// device's own connection. WireGuard answers nobody it doesn't know, so the one
// open UDP port is invisible to scans.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { makeKeys, publicOf, validKey } = require('./wireguard');

const IFACE = 'wg1';
const PORT = 51821;
const NET = '10.78.0.0/24';
const ADDRESS = '10.78.0.1';
const DEFAULT_LAN = '192.168.4.0/24';
const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,198}[A-Za-z0-9])?$/;
const MAX_DEVICES = 20;

// "192.168.4.0/24" → itself when it is a private IPv4 range of /8 to /29; null otherwise.
function cleanLan(v) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(String(v || '').trim());
  if (!m) return null;
  const o = m.slice(1, 5).map(Number);
  const bits = Number(m[5]);
  if (o.some((n) => n > 255) || bits < 8 || bits > 29) return null;
  const privateRange = o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168);
  if (!privateRange) return null;
  // The tunnel's own range can't also be the home network.
  if (o[0] === 10 && o[1] === 78) return null;
  const ip = ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const net = (ip & mask) >>> 0;
  return `${net >>> 24}.${(net >>> 16) & 255}.${(net >>> 8) & 255}.${net & 255}/${bits}`;
}

// A name or address for the tunnel's outside end (no port, no path).
function cleanHost(v) {
  const s = String(v || '').trim().toLowerCase();
  return HOST_RE.test(s) ? s : null;
}

function cleanName(v) {
  return String(v || '').replace(/[^\p{L}\p{N} ._'-]/gu, '').trim().slice(0, 40);
}

function nextAddress(devices) {
  const used = new Set(devices.map((d) => d.address));
  for (let i = 2; i < 255; i++) if (!used.has(`10.78.0.${i}`)) return `10.78.0.${i}`;
  return null;
}

function serverConfig({ privateKey, devices }) {
  const peers = devices.map((d) => `
# ${d.name.replace(/[\r\n]/g, ' ')}
[Peer]
PublicKey = ${d.publicKey}
AllowedIPs = ${d.address}/32
`).join('');
  // Traffic from a device is passed on to the home network and made to look like
  // it comes from this server, so the machines there need no setup at all.
  return `[Interface]
Address = ${ADDRESS}/24
ListenPort = ${PORT}
PrivateKey = ${privateKey}
PostUp = iptables -A FORWARD -i %i -j ACCEPT; iptables -A FORWARD -o %i -j ACCEPT; iptables -t nat -A POSTROUTING -s ${NET} ! -o %i -j MASQUERADE
PostDown = iptables -D FORWARD -i %i -j ACCEPT; iptables -D FORWARD -o %i -j ACCEPT; iptables -t nat -D POSTROUTING -s ${NET} ! -o %i -j MASQUERADE
${peers}`;
}

// What the device imports (as a file or from the QR code). Kept short so it fits a QR code.
function deviceConfig({ privateKey, address, serverPublicKey, host, lan }) {
  return `[Interface]
PrivateKey = ${privateKey}
Address = ${address}/32

[Peer]
PublicKey = ${serverPublicKey}
Endpoint = ${host}:${PORT}
AllowedIPs = ${lan}, ${NET}
PersistentKeepalive = 25
`;
}

class Away {
  constructor(dir, { run = execFile } = {}) {
    this.dir = dir;
    this.keyFile = path.join(dir, 'away-privatekey');
    this.confFile = path.join(dir, `${IFACE}.conf`);
    this.run = run;
  }

  privateKey() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(this.keyFile)) fs.writeFileSync(this.keyFile, makeKeys().privateKey + '\n', { mode: 0o600 });
    return fs.readFileSync(this.keyFile, 'utf8').trim();
  }

  publicKey() {
    return publicOf(this.privateKey());
  }

  // A new device's keys, its address and the config it will import. Nothing is stored here.
  newDevice(devices, { host, lan }) {
    const address = nextAddress(devices);
    if (!address || devices.length >= MAX_DEVICES) return null;
    const keys = makeKeys();
    const config = deviceConfig({ privateKey: keys.privateKey, address, serverPublicKey: this.publicKey(), host, lan });
    return { id: crypto.randomBytes(6).toString('hex'), publicKey: keys.publicKey, address, config };
  }

  // Writes the server's config; with the switch off (or no devices) there is none and the link stays down.
  write({ enabled, devices }) {
    if (!enabled) return fs.rmSync(this.confFile, { force: true });
    fs.writeFileSync(this.confFile, serverConfig({ privateKey: this.privateKey(), devices }), { mode: 0o600 });
  }

  // Never throws: a container without the tools (or the right to manage links) still saves its settings.
  apply() {
    const call = (args, cmd = 'wg-quick') => new Promise((resolve) => this.run(cmd, args, { timeout: 15000 }, (err, out, stderr) => resolve({ err, out: String(out || ''), stderr: String(stderr || '') })));
    return (async () => {
      await call(['down', this.confFile]);
      if (!fs.existsSync(this.confFile)) return { ok: true, note: 'Away from home is off' };
      const { err, stderr } = await call(['up', this.confFile]);
      if (!err) return { ok: true, note: '' };
      if (err.code === 'ENOENT') return { ok: false, note: 'This Roost has no WireGuard tools. Rebuild it from the latest compose file, then save again' };
      if (/Operation not permitted|Permission denied|RTNETLINK/.test(stderr)) return { ok: false, note: 'The container may not manage network links. Add cap_add: NET_ADMIN to Roost in the compose file' };
      if (/iptables|ip_forward|nft|Table does not exist/i.test(stderr)) return { ok: false, note: 'The container could not set up forwarding. Rebuild it from the latest compose file (it needs the iptables package and net.ipv4.ip_forward)' };
      return { ok: false, note: `WireGuard said: ${stderr.trim().split('\n').pop() || err.message}` };
    })();
  }

  // When each device last connected: { publicKey: epoch seconds }. Asked only when Admin is opened.
  handshakes() {
    return new Promise((resolve) => {
      this.run('wg', ['show', IFACE, 'latest-handshakes'], { timeout: 5000 }, (err, out) => {
        const map = {};
        if (!err) {
          for (const line of String(out || '').split('\n')) {
            const [key, at] = line.trim().split(/\s+/);
            if (validKey(key) && Number(at) > 0) map[key] = Number(at);
          }
        }
        resolve(map);
      });
    });
  }
}

module.exports = { Away, cleanLan, cleanHost, cleanName, nextAddress, serverConfig, deviceConfig, PORT, NET, ADDRESS, DEFAULT_LAN, IFACE, MAX_DEVICES };
