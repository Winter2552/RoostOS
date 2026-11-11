'use strict';

// The scanning half of the Device finder. It runs in the roost-lan helper
// container (src/lan-helper.js), which sits on the host's network so it can see
// the real home network. Nothing here logs in to anything, guesses a password or
// reads more than "is this port open" and a device's own announced name.
//
// A sweep:
//   1. sends one empty UDP packet to every address in the local range, which
//      makes the kernel ask "who has this address?" (ARP) for each
//   2. reads the kernel's ARP table (/proc/net/arp) to see who answered
//   3. tries a short list of well-known TCP ports on those devices
//   4. asks each for the name it announces (mDNS), and the router's DNS for one
//
// Only private ranges, never wider than a /22, never an internet address.

const dgram = require('dgram');
const dns = require('dns');
const fs = require('fs');
const net = require('net');
const os = require('os');

const PORTS = [21, 22, 23, 25, 53, 80, 111, 139, 443, 445, 515, 554, 631, 1883, 2375, 3389, 5000, 5900, 8000, 8080, 8096, 8097, 8123, 8443, 9000, 9100, 32400, 62078];
const MAX_HOSTS = 1022; // a /22
const CONNECT_MS = 700;
const CONCURRENCY = 64;

const ipToInt = (ip) => ip.split('.').reduce((n, p) => (n * 256) + Number(p), 0);
const intToIp = (n) => [24, 16, 8, 0].map((s) => Math.floor(n / (2 ** s)) % 256).join('.');

function isPrivate(ip) {
  if (net.isIPv4(ip) === false) return false;
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// "192.168.4.0/24" → every host address in it, or null when it is not a private
// range or is wider than a /22.
function hostsOf(cidr) {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(String(cidr || ''));
  if (!m || net.isIPv4(m[1]) === false) return null;
  const bits = Number(m[2]);
  if (bits < 22 || bits > 30 || !isPrivate(m[1])) return null;
  const size = 2 ** (32 - bits);
  const base = Math.floor(ipToInt(m[1]) / size) * size;
  const out = [];
  for (let i = 1; i < size - 1; i++) out.push(intToIp(base + i));
  return out.length <= MAX_HOSTS ? out : null;
}

function maskBits(mask) {
  return mask.split('.').reduce((n, p) => n + Number(p).toString(2).split('1').length - 1, 0);
}

// The network cards that are the home network, not Docker's own, VPNs or loopback.
const SKIP_CARD = /^(lo|docker|br-|veth|virbr|zt|wg|tailscale|tun|tap)/;

// The card and range to sweep: LAN_CIDR when it is set, else the first ordinary
// private card. A card bigger than a /22 sweeps the /24 around its own address.
function pickNetwork(interfaces = os.networkInterfaces(), forced = '') {
  const cards = [];
  for (const [name, list] of Object.entries(interfaces)) {
    if (SKIP_CARD.test(name)) continue;
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal && isPrivate(a.address)) cards.push({ name, ip: a.address, mac: a.mac, bits: maskBits(a.netmask) });
  }
  const card = cards[0];
  if (!card) return null;
  const bits = forced ? Number((/\/(\d+)$/.exec(forced) || [])[1]) : card.bits < 22 ? 24 : card.bits;
  const cidr = forced || `${card.ip}/${bits}`;
  const hosts = hostsOf(cidr);
  return hosts ? { name: card.name, ip: card.ip, mac: card.mac, cidr, hosts } : null;
}

// /proc/net/arp → [{ ip, mac, card }] for complete entries only.
function parseArp(text) {
  const out = [];
  for (const line of String(text).split('\n').slice(1)) {
    const [ip, , flags, mac, , card] = line.trim().split(/\s+/);
    if (!ip || net.isIPv4(ip) === false || flags !== '0x2' || !mac || mac === '00:00:00:00:00:00') continue;
    out.push({ ip, mac: mac.toLowerCase(), card });
  }
  return out;
}

// /proc/net/route → the default gateway's address, or null.
function parseGateway(text) {
  for (const line of String(text).split('\n').slice(1)) {
    const [, dest, gw, flags] = line.trim().split(/\s+/);
    if (dest !== '00000000' || !gw || !(parseInt(flags, 16) & 2)) continue;
    const n = parseInt(gw, 16);
    return [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255].join('.');
  }
  return null;
}

// A DNS question for the name behind an address (PTR), as mDNS and DNS both take it.
function ptrQuery(ip) {
  const labels = `${ip.split('.').reverse().join('.')}.in-addr.arpa`.split('.');
  const parts = [Buffer.from([0x12, 0x34, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0])];
  for (const l of labels) parts.push(Buffer.from([l.length]), Buffer.from(l));
  parts.push(Buffer.from([0, 0, 12, 0, 1]));
  return Buffer.concat(parts);
}

// The first name in a PTR answer, or null. Handles name compression.
function readName(buf, at) {
  const labels = [];
  let pos = at;
  let jumps = 0;
  while (pos < buf.length && jumps < 10) {
    const len = buf[pos];
    if (len === 0) break;
    if ((len & 0xc0) === 0xc0) { pos = ((len & 0x3f) << 8) | buf[pos + 1]; jumps++; continue; }
    labels.push(buf.toString('utf8', pos + 1, pos + 1 + len));
    pos += len + 1;
  }
  return labels.join('.');
}

function parsePtrAnswer(buf) {
  try {
    if (buf.length < 12 || buf.readUInt16BE(6) < 1) return null;
    let pos = 12;
    for (let q = buf.readUInt16BE(4); q > 0; q--) {
      while (buf[pos] !== 0) pos += (buf[pos] & 0xc0) === 0xc0 ? 2 : buf[pos] + 1;
      pos += 5;
    }
    // Skip the answer's own name, then type, class, ttl, length.
    while (buf[pos] !== 0 && (buf[pos] & 0xc0) !== 0xc0) pos += buf[pos] + 1;
    pos += (buf[pos] & 0xc0) === 0xc0 ? 2 : 1;
    if (buf.readUInt16BE(pos) !== 12) return null;
    const name = readName(buf, pos + 10);
    return name ? name.replace(/\.(local|lan|home|localdomain)$/i, '') : null;
  } catch {
    return null;
  }
}

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sweepPackets(hosts) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    socket.on('error', () => {});
    let left = hosts.length;
    const one = Buffer.alloc(1);
    for (const ip of hosts) socket.send(one, 9, ip, () => { if (--left === 0) socket.close(); });
    setTimeout(() => { try { socket.close(); } catch { /* already closed */ } resolve(); }, 1500);
  });
}

function probe(ip, port, ms = CONNECT_MS) {
  return new Promise((resolve) => {
    const s = net.connect({ host: ip, port }); // code-check: ok (the address comes from the local range the helper picked, never from a request)
    const done = (open) => { s.destroy(); resolve(open); };
    s.setTimeout(ms, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

async function openPorts(ips, ports = PORTS, { connect = probe, concurrency = CONCURRENCY } = {}) {
  const found = new Map(ips.map((ip) => [ip, []]));
  const jobs = [];
  for (const ip of ips) for (const port of ports) jobs.push([ip, port]);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const [ip, port] = jobs[next++];
      if (await connect(ip, port)) found.get(ip).push(port);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  for (const list of found.values()) list.sort((a, b) => a - b);
  return found;
}

// Each device's own announced name (mDNS PTR sent straight to it).
function mdnsNames(ips, ms = 1200) {
  return new Promise((resolve) => {
    const names = new Map();
    const socket = dgram.createSocket('udp4');
    socket.on('error', () => {});
    socket.on('message', (msg, rinfo) => {
      const name = parsePtrAnswer(msg);
      if (name && !names.has(rinfo.address)) names.set(rinfo.address, name);
    });
    for (const ip of ips) socket.send(ptrQuery(ip), 5353, ip, () => {});
    setTimeout(() => { try { socket.close(); } catch { /* already closed */ } resolve(names); }, ms);
  });
}

async function dnsName(ip) {
  try {
    const names = await Promise.race([dns.promises.reverse(ip), pause(1000).then(() => [])]);
    const first = names && names[0];
    return first ? first.replace(/\.(lan|home|localdomain|home\.arpa)$/i, '') : null;
  } catch {
    return null;
  }
}

// One full sweep → the object the helper saves as lan.json.
async function scan({ network = pickNetwork(os.networkInterfaces(), process.env.LAN_CIDR || ''), arpFile = '/proc/net/arp', routeFile = '/proc/net/route', now = Date.now } = {}) {
  if (!network) return { at: new Date(now()).toISOString(), error: 'No home network found to scan', hosts: [] };
  const started = now();
  await sweepPackets(network.hosts);
  const inRange = new Set(network.hosts);
  let seen = [];
  try { seen = parseArp(fs.readFileSync(arpFile, 'utf8')).filter((h) => inRange.has(h.ip)); } catch { /* no ARP table */ }
  // This machine does not appear in its own ARP table.
  if (network.mac && !seen.some((h) => h.ip === network.ip)) seen.push({ ip: network.ip, mac: network.mac.toLowerCase(), card: network.name, self: true });
  const ips = seen.map((h) => h.ip);
  const [ports, mdns] = await Promise.all([openPorts(ips), mdnsNames(ips)]);
  const reverse = new Map();
  await Promise.all(ips.map(async (ip) => { const n = await dnsName(ip); if (n) reverse.set(ip, n); }));
  let gateway = null;
  try { gateway = parseGateway(fs.readFileSync(routeFile, 'utf8')); } catch { /* no route table */ }
  return {
    at: new Date(now()).toISOString(),
    took: now() - started,
    cidr: network.cidr,
    card: network.name,
    gateway,
    self: network.ip,
    hosts: seen.map((h) => ({ ip: h.ip, mac: h.mac, ports: ports.get(h.ip) || [], mdns: mdns.get(h.ip) || null, dns: reverse.get(h.ip) || null })),
  };
}

module.exports = { scan, pickNetwork, hostsOf, parseArp, parseGateway, ptrQuery, parsePtrAnswer, openPorts, isPrivate, PORTS };
