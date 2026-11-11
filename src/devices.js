'use strict';

// The Device finder, Roost's side. The roost-lan helper (src/lan-helper.js)
// sweeps the home network now and then and leaves lan.json in a shared folder.
// This reads it, remembers each device by its network card address in
// devices.json (its own file, apart from the accounts), and turns what it finds
// into a list Raven can name, plus a few alerts. Reading costs a stat call
// unless the helper wrote something new; nothing here runs on a timer.
//
// What it can honestly say about a device: whether it is on, who made it,
// which common ports are open, and, from what Roost itself sees, what it is
// doing (see doingMap in the server). It cannot see another device's internet
// traffic.

const fs = require('fs');
const path = require('path');
const { vendorOf, isPrivateMac } = require('./oui');

const TYPES = ['phone', 'tablet', 'computer', 'tv', 'console', 'printer', 'camera', 'home', 'server', 'router', 'other'];
const TAGS = ['raven', 'family', 'guest', 'server', 'other'];
const KEEP_MAX = 500;
const STALE_AFTER_SCANS = 2.5;
const AUTO_SCAN_MS = 5 * 60 * 1000;
const ASK_GAP_MS = 15 * 1000;

const PORT_NAMES = {
  21: 'FTP', 22: 'SSH', 23: 'Telnet', 25: 'Mail', 53: 'DNS', 80: 'Web', 111: 'RPC', 139: 'Windows sharing', 443: 'Secure web', 445: 'Windows sharing',
  515: 'Printing', 554: 'Video stream', 631: 'Printing', 1883: 'Smart home (MQTT)', 2375: 'Docker', 3389: 'Remote Desktop', 5000: 'Web', 5900: 'VNC',
  8000: 'Web', 8080: 'Roost', 8096: 'Jellyfin', 8097: 'Jellyfin', 8123: 'Home Assistant', 8443: 'Secure web', 9000: 'Web admin', 9100: 'Printing', 32400: 'Plex', 62078: 'iPhone/iPad',
};
// Doors that should rarely be open on a home device.
const RISKY = { 21: 'FTP', 23: 'Telnet', 2375: 'Docker', 3389: 'Remote Desktop', 5900: 'VNC' };

const ipNum = (ip) => String(ip || '0.0.0.0').split('.').reduce((n, p) => (n * 256) + Number(p), 0);

function cleanMac(mac) {
  const m = String(mac || '').toLowerCase().replace(/-/g, ':');
  return /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(m) ? m : null;
}

// A best guess at what a device is, from its name, maker and open ports.
function guessType({ names = [], vendor = null, ports = [] }) {
  const n = names.join(' ').toLowerCase();
  const has = (...p) => p.some((x) => ports.includes(x));
  if (/ipad|tablet|galaxy-tab/.test(n)) return 'tablet';
  if (/iphone|android|pixel|galaxy|phone/.test(n) || has(62078)) return 'phone';
  if (/xbox|playstation|ps[345]|nintendo|switch/.test(n) || vendor === 'Nintendo' || vendor === 'Sony') return /tv|bravia/.test(n) ? 'tv' : 'console';
  if (/tv|bravia|roku|chromecast|firetv|fire-tv|appletv|apple-tv|hisense|webos/.test(n) || vendor === 'Roku' || vendor === 'LG') return 'tv';
  if (/printer|laserjet|officejet|deskjet|envy|pixma|brother|epson|canon/.test(n) || has(631, 9100, 515) || ['Canon', 'Brother', 'Epson'].includes(vendor)) return 'printer';
  if (/cam|doorbell|ring/.test(n) || vendor === 'Hikvision' || has(554)) return 'camera';
  if (vendor === 'Espressif' || vendor === 'Signify' || vendor === 'Sonos' || has(1883, 8123) || /hue|sonos|echo|alexa|nest|plug|bulb|sensor/.test(n)) return 'home';
  if (/macbook|laptop|desktop|pc|imac|mac-mini|windows|ubuntu|linux/.test(n) || has(3389, 445, 139) || ['Dell', 'HP', 'Intel', 'Asus', 'Microsoft'].includes(vendor)) return 'computer';
  if (has(22) && vendor === 'Raspberry Pi') return 'server';
  if (vendor === 'Amazon') return 'home';
  return 'other';
}

function nameOf(d) {
  if (d.label) return d.label;
  if (d.names && d.names[0]) return d.names[0];
  const vendor = vendorOf(d.mac);
  const kind = d.type && d.type !== 'other' ? d.type : '';
  if (vendor) return kind ? `${vendor} ${kind}` : `${vendor} device`;
  return isPrivateMac(d.mac) ? 'Unknown device (private address)' : 'Unknown device';
}

class Devices {
  // lanDir: where the helper leaves lan.json (empty = helper not set up).
  // raise(key, title, detail) and clear(key): alerts for the owner only.
  // finding(detail): also noted in Sentinel's list (owner's view only).
  constructor({ dataDir, lanDir = '', raise = () => {}, clear = () => {}, finding = () => {}, now = Date.now }) {
    this.file = path.join(dataDir, 'devices.json');
    this.lanDir = lanDir;
    this.raise = raise;
    this.clear = clear;
    this.finding = finding;
    this.now = now;
    this.mtime = 0;
    this.lastAsk = 0;
    this.watcher = null;
    this.error = null;
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* first run */ }
    this.baselined = Boolean(saved.baselined);
    this.rules = { newDevice: true, clash: true, riskyPorts: false, ...(saved.rules || {}) };
    this.gatewayMac = saved.gatewayMac || null;
    this.online = new Set(Array.isArray(saved.online) ? saved.online : []);
    this.scanAt = saved.scanAt || null;
    this.every = saved.every || null;
    this.devices = saved.devices && typeof saved.devices === 'object' ? saved.devices : {};
  }

  get configured() {
    return Boolean(this.lanDir);
  }

  // Watches the shared folder, so a new sweep is handled when it lands.
  start() {
    if (!this.configured) return;
    this.refresh();
    try {
      fs.mkdirSync(this.lanDir, { recursive: true });
      let timer = null;
      this.watcher = fs.watch(this.lanDir, (event, name) => {
        if (name && name !== 'lan.json') return;
        clearTimeout(timer);
        timer = setTimeout(() => this.refresh(), 500);
        timer.unref();
      });
      this.watcher.on('error', () => {});
    } catch { /* the folder isn't there yet; the page still refreshes on open */ }
  }

  stop() {
    if (this.watcher) this.watcher.close();
  }

  readLan() {
    if (!this.configured) return null;
    const file = path.join(this.lanDir, 'lan.json');
    try {
      const mtime = fs.statSync(file).mtimeMs;
      return { mtime, lan: JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch {
      return null;
    }
  }

  // Takes in the helper's latest sweep, if it is newer than the last one handled.
  refresh() {
    const got = this.readLan();
    if (!got || got.mtime === this.mtime) return false;
    this.mtime = got.mtime;
    if (got.lan.at === this.scanAt) return false;
    this.take(got.lan);
    return true;
  }

  take(lan) {
    this.error = lan.error || null;
    if (lan.error || !Array.isArray(lan.hosts) || !lan.hosts.length) return;
    const at = new Date(this.now()).toISOString();
    const previous = this.online;
    const online = new Set();
    for (const h of lan.hosts) {
      const mac = cleanMac(h.mac);
      if (!mac) continue;
      online.add(mac);
      let d = this.devices[mac];
      if (!d) {
        d = { mac, label: '', type: '', tag: '', known: false, firstSeen: at, scans: 0, names: [], ports: [] };
        // The router and this server are known from the start.
        if (h.ip === lan.self) Object.assign(d, { known: true, tag: 'server', type: 'server' });
        else if (h.ip === lan.gateway) Object.assign(d, { known: true, type: 'router' });
        this.devices[mac] = d;
      }
      d.ip = h.ip;
      d.lastSeen = at;
      d.scans = previous.has(mac) ? d.scans + 1 : 1;
      d.names = [...new Set([h.mdns, h.dns].filter(Boolean))].slice(0, 3);
      d.ports = Array.isArray(h.ports) ? h.ports.slice(0, 40) : [];
    }
    this.online = online;
    this.scanAt = lan.at;
    this.every = lan.every || this.every;
    this.trim();
    if (this.baselined) this.check(lan);
    this.save();
  }

  // Alerts for this sweep. Nothing fires until Raven has accepted the first list.
  check(lan) {
    const byMac = (mac) => this.devices[mac];
    for (const mac of this.online) {
      const d = byMac(mac);
      const name = nameOf(d);
      const maker = vendorOf(mac) || (isPrivateMac(mac) ? 'private address' : 'maker unknown');
      if (this.rules.newDevice && !d.known && d.scans >= 2 && !d.alerted) {
        d.alerted = true;
        this.raise(`dev:new:${mac}`, 'New device on your network', `${name} · ${d.ip} · ${maker}. Open Admin → Devices to name it or mark it not yours.`);
      }
      if (this.rules.riskyPorts) {
        const flagged = new Set(d.flaggedPorts || []);
        for (const port of d.ports) {
          if (!RISKY[port] || flagged.has(port)) continue;
          flagged.add(port);
          const text = `${d.ip} answers on port ${port} (${RISKY[port]}). That is rarely needed at home. Check it, or turn the device's setting off.`;
          this.raise(`dev:port:${mac}:${port}`, `${name} has ${RISKY[port]} open`, text);
          this.finding(`${name}: ${text}`);
        }
        d.flaggedPorts = [...flagged].filter((p) => d.ports.includes(p));
      }
    }
    if (this.rules.clash && lan.gateway) {
      const gate = lan.hosts.find((h) => h.ip === lan.gateway);
      const gmac = gate && cleanMac(gate.mac);
      if (gmac) {
        const twice = lan.hosts.filter((h) => cleanMac(h.mac) === gmac && h.ip !== lan.gateway);
        if (this.gatewayMac && this.gatewayMac !== gmac) {
          const text = `${lan.gateway} used to be ${this.gatewayMac} and is now ${gmac}. If you did not swap the router, something on the network may be pretending to be it.`;
          this.raise('dev:clash:gateway', 'Your router’s address now belongs to a different device', text);
          this.finding(text);
        } else if (twice.length) {
          const text = `${gmac} is at ${lan.gateway} and also ${twice.map((h) => h.ip).join(', ')}. That is how network spoofing looks. Check what it is.`;
          this.raise(`dev:clash:${gmac}`, 'One device is answering for the router and another address', text);
          this.finding(text);
        }
        this.gatewayMac = gmac;
      }
    }
  }

  // Keeps the file small: the longest-gone unknowns go first.
  trim() {
    const all = Object.values(this.devices);
    if (all.length <= KEEP_MAX) return;
    all.filter((d) => !d.label && !this.online.has(d.mac)).sort((a, b) => String(a.lastSeen).localeCompare(String(b.lastSeen))).slice(0, all.length - KEEP_MAX).forEach((d) => delete this.devices[d.mac]);
  }

  // ---------- helper status and asking for a sweep ----------

  helper() {
    if (!this.configured) return { state: 'off' };
    const got = this.readLan();
    if (!got) return { state: 'missing' };
    const age = this.now() - Date.parse(got.lan.at);
    const limit = (got.lan.every || 30 * 60 * 1000) * STALE_AFTER_SCANS + 2 * 60 * 1000;
    return { state: got.lan.error ? 'error' : age > limit ? 'stale' : 'ok', at: got.lan.at, error: got.lan.error || null, age };
  }

  // Leaves the helper a note to sweep now. Never more than one every 15 seconds.
  requestScan() {
    if (!this.configured || this.now() - this.lastAsk < ASK_GAP_MS) return false;
    this.lastAsk = this.now();
    try {
      fs.mkdirSync(this.lanDir, { recursive: true });
      fs.writeFileSync(path.join(this.lanDir, 'scan-now'), String(this.lastAsk));
      return true;
    } catch {
      return false;
    }
  }

  // Opening the page: refresh if the last sweep is a few minutes old.
  autoScan() {
    const h = this.helper();
    if (h.state === 'ok' && h.age > AUTO_SCAN_MS) this.requestScan();
  }

  // ---------- what the page shows ----------

  view(doing = new Map()) {
    const h = this.helper();
    const fresh = h.state === 'ok';
    const list = Object.values(this.devices).map((d) => {
      const vendor = vendorOf(d.mac);
      const type = d.type || guessType({ names: d.names, vendor, ports: d.ports });
      const online = fresh && this.online.has(d.mac);
      const risky = d.ports.filter((p) => RISKY[p]).map((p) => ({ port: p, name: RISKY[p] }));
      return {
        mac: d.mac, name: nameOf({ ...d, type }), label: d.label || '', type, guessed: !d.type, tag: d.tag || '', known: d.known,
        ip: d.ip, vendor, private: isPrivateMac(d.mac), online, firstSeen: d.firstSeen, lastSeen: d.lastSeen,
        ports: d.ports.map((p) => ({ port: p, name: PORT_NAMES[p] || 'Open' })), risky,
        doing: online ? doing.get(d.ip) || null : null,
      };
    });
    list.sort((a, b) => (a.known - b.known) || (b.online - a.online) || (ipNum(a.ip) - ipNum(b.ip)));
    const known = list.filter((d) => d.known);
    return {
      helper: h,
      scanAt: this.scanAt,
      baselined: this.baselined,
      rules: this.rules,
      devices: list,
      counts: {
        online: list.filter((d) => d.online).length,
        known: known.length,
        new: list.filter((d) => !d.known).length,
        away: known.filter((d) => !d.online).length,
        watch: list.filter((d) => d.risky.length).length,
      },
    };
  }

  // ---------- Raven's changes ----------

  find(mac) {
    const d = this.devices[cleanMac(mac)];
    if (!d) throw Object.assign(new Error('That device is not in the list'), { status: 404 });
    return d;
  }

  update(mac, patch) {
    const d = this.find(mac);
    if ('label' in patch) d.label = String(patch.label || '').trim().slice(0, 40);
    if ('type' in patch) {
      if (patch.type && !TYPES.includes(patch.type)) throw Object.assign(new Error('Unknown type'), { status: 400 });
      d.type = patch.type || '';
    }
    if ('tag' in patch) {
      if (patch.tag && !TAGS.includes(patch.tag)) throw Object.assign(new Error('Unknown tag'), { status: 400 });
      d.tag = patch.tag || '';
    }
    if ('known' in patch) {
      d.known = Boolean(patch.known);
      if (d.known) this.clear(`dev:new:${d.mac}`);
      else d.alerted = false;
    }
    // Naming a device means it is yours.
    if (patch.label && !('known' in patch)) { d.known = true; this.clear(`dev:new:${d.mac}`); }
    this.save();
    return d;
  }

  markAllKnown() {
    for (const d of Object.values(this.devices)) {
      if (!d.known) { d.known = true; this.clear(`dev:new:${d.mac}`); }
    }
    this.baselined = true;
    this.save();
  }

  forget(mac) {
    const d = this.find(mac);
    delete this.devices[d.mac];
    this.online.delete(d.mac);
    this.clear(`dev:new:${d.mac}`);
    this.save();
  }

  setRules(rules) {
    for (const k of ['newDevice', 'clash', 'riskyPorts']) if (k in rules) this.rules[k] = Boolean(rules[k]);
    this.save();
  }

  save() {
    try {
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ baselined: this.baselined, rules: this.rules, gatewayMac: this.gatewayMac, online: [...this.online], scanAt: this.scanAt, every: this.every, devices: this.devices }));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('Could not save the device list:', err.message);
    }
  }
}

module.exports = { Devices, guessType, nameOf, cleanMac, TYPES, TAGS, RISKY };
