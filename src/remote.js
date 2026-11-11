'use strict';

// Reaching Roost from outside the house, through Cloudflare. Roost does four
// small jobs itself instead of leaning on more outside software:
//   - knows which connections really come from Cloudflare (its published
//     address ranges), so it can trust the visitor's real address and, if the
//     admin wants, refuse outside traffic that skipped Cloudflare;
//   - keeps the domain's A record pointed at the home connection, since a home
//     address changes now and then;
//   - tests the whole route from outside (DNS, Cloudflare, the router's port
//     forward, the certificate) by asking for its own web address;
//   - says when the connection can't be reached from outside at all (CGNAT).
// The Cloudflare token is the one HTTPS already saved; nothing new is stored.

const net = require('net');
const crypto = require('crypto');
const { CloudflareDns } = require('./cloudflare');

// Cloudflare's published ranges (https://www.cloudflare.com/ips). They change
// about once every few years.
const CLOUDFLARE = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18',
  '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17',
  '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32',
  '2a06:98c0::/29', '2c0f:f248::/32',
];
// Addresses inside the home (and Tailscale's), which are always allowed in.
const HOME = [
  '127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '100.64.0.0/10',
  '::1/128', 'fc00::/7', 'fe80::/10',
];

function list(cidrs) {
  const l = new net.BlockList();
  for (const c of cidrs) {
    const [addr, bits] = c.split('/');
    l.addSubnet(addr, Number(bits), net.isIPv6(addr) ? 'ipv6' : 'ipv4');
  }
  return l;
}
const CF_LIST = list(CLOUDFLARE);
const HOME_LIST = list(HOME);
const CGNAT_LIST = list(['100.64.0.0/10']);

const plain = (ip) => String(ip || '').replace(/^::ffff:/, '');
const inList = (l, ip) => { const a = plain(ip); return net.isIP(a) > 0 && l.check(a, net.isIPv6(a) ? 'ipv6' : 'ipv4'); };

const isCloudflare = (ip) => inList(CF_LIST, ip);
const isHome = (ip) => inList(HOME_LIST, ip);
// A carrier-grade NAT address (100.64.0.0/10) as the *public* address means the
// internet service provider shares one address between many homes.
const isCgnat = (ip) => inList(CGNAT_LIST, ip);

const HOUR = 60 * 60 * 1000;
// The one tunnel Roost makes, and the test name used before the real switch.
const TUNNEL_NAME = 'roost';
const TEST_LABEL = 'try';
const STREAM_LABEL = 'stream';
const sameNames = (a = [], b = []) => a.length === b.length && a.every((n, i) => n === b[i]);

class RemoteAccess {
  constructor({ getSettings, patch, getTls, extraNames = () => [], greyNames = () => [], origin = 'http://roost:8081', fetchImpl = fetch, cloudflareApi, traceUrl = 'https://1.1.1.1/cdn-cgi/trace', now = Date.now, intervalMs = 5 * 60 * 1000, firstMs = 20 * 1000, timeoutMs = 8000 }) {
    this.getSettings = getSettings;
    this.patch = patch;
    this.getTls = getTls;
    this.extraNames = extraNames;
    this.greyNames = greyNames;
    this.origin = origin;
    this.fetch = fetchImpl;
    this.cloudflareApi = cloudflareApi;
    this.traceUrl = traceUrl;
    this.now = now;
    this.intervalMs = intervalMs;
    this.firstMs = firstMs;
    this.timeoutMs = timeoutMs;
    // Answered by GET /api/remote/ping so a check can tell it reached this Roost.
    this.nonce = crypto.randomBytes(16).toString('hex');
    this.busy = null;
    this.timer = null;
    this.first = null;
  }

  settings() {
    return this.getSettings() || {};
  }

  // True when the connection itself (not a header anyone could send) comes from Cloudflare.
  viaCloudflare(req) {
    return isCloudflare(req.socket && req.socket.remoteAddress);
  }

  // The visitor's real address, which Cloudflare passes along. Only believed
  // when the connection really is from Cloudflare.
  visitor(req) {
    const given = String(req.headers['cf-connecting-ip'] || '').trim();
    return this.viaCloudflare(req) && net.isIP(given) ? plain(given) : null;
  }

  // Outside HTTPS traffic that skipped Cloudflare is refused when asked for.
  // The home network always gets in, so a wrong setting can't lock you out.
  blocks(req) {
    if (!this.settings().cloudflareOnly || !(req.socket && req.socket.encrypted)) return false;
    const ip = req.socket.remoteAddress;
    return !isCloudflare(ip) && !isHome(ip);
  }

  async homeIp() {
    const res = await this.fetch(this.traceUrl, { signal: AbortSignal.timeout(this.timeoutMs) });
    const text = await res.text();
    const m = text.match(/^ip=(.+)$/m);
    const ip = m && m[1].trim();
    if (!ip || net.isIP(ip) !== 4) throw new Error(net.isIP(ip) === 6 ? 'Your connection answers on IPv6 only; Roost keeps an IPv4 address for now' : 'Roost couldn’t work out its public address');
    return ip;
  }

  dns() {
    const { domain, token } = this.getTls() || {};
    return domain && token ? new CloudflareDns({ token, domain, ...(this.cloudflareApi ? { apiBase: this.cloudflareApi } : {}), fetchImpl: this.fetch }) : null;
  }

  // True when the tunnel carries the main address.
  tunnelOn() {
    return this.settings().route === 'tunnel';
  }

  // Where Roostflix answers while the main address is on the tunnel.
  streamHost() {
    const { domain } = this.getTls() || {};
    return domain ? `${STREAM_LABEL}.${domain}` : '';
  }

  // Points the domain at the current home address (a proxied A record). While
  // the tunnel carries the main address, the domain is left alone and only the
  // direct names (Roostflix's, Coffee Galaxy's) follow the home address.
  async sync({ force = false } = {}) {
    const s = this.settings();
    const { domain } = this.getTls() || {};
    const dns = this.dns();
    const last = s.dns || {};
    let result;
    try {
      if (!dns) throw new Error('Save a domain and Cloudflare token under Secure connection first');
      const ip = await this.homeIp();
      // The domain itself, plus any other names Roost answers (Coffee Galaxy's).
      const tunnel = this.tunnelOn();
      const names = tunnel ? [this.streamHost(), ...this.extraNames()] : [domain, ...this.extraNames()];
      // Roostflix's name stays grey: video must not pass through Cloudflare. So do names
      // that carry something other than web traffic (the Away from home tunnel is UDP).
      const grey = this.greyNames();
      const proxiedOf = (name) => name !== this.streamHost() && !grey.includes(name);
      // Nothing to do while the address hasn't moved, apart from a daily look.
      if (!force && last.ok && last.ip === ip && last.domain === domain && Boolean(last.tunnel) === tunnel && sameNames(last.names, names) && this.now() - last.at < 24 * HOUR) {
        result = { ...last };
      } else {
        let changed = false;
        for (const name of names) changed = (await dns.upsert({ type: 'A', name, content: ip, proxied: proxiedOf(name) })).changed || changed;
        result = { ok: true, ip, domain, names, tunnel, at: this.now(), changed, cgnat: isCgnat(ip) };
      }
    } catch (err) {
      result = { ok: false, ip: last.ip || '', domain, at: this.now(), error: err.message };
    }
    this.patch({ dns: result });
    return result;
  }

  // Makes (or fixes) one grey A record for a name under the domain, pointing at the home address.
  async pointGrey(name) {
    const ip = await this.homeIp();
    await this.needDns().upsert({ type: 'A', name, content: ip, proxied: false });
    return ip;
  }

  // ---------- Cloudflare Tunnel ----------

  tunnelInfo() {
    return this.settings().tunnel || null;
  }

  needDns() {
    const dns = this.dns();
    if (!dns) throw new Error('Save a domain and Cloudflare token under Secure connection first');
    return dns;
  }

  // Makes the tunnel (or finds the one made before), tells it which names it
  // answers for, and points the test name at it. Returns the connector token
  // the tunnel container needs. The main name is not touched.
  async createTunnel() {
    const dns = this.needDns();
    const { domain } = this.getTls();
    const test = `${TEST_LABEL}.${domain}`;
    const existing = await dns.findTunnel(TUNNEL_NAME);
    const found = existing || (await dns.createTunnel(TUNNEL_NAME));
    await dns.configureTunnel(found.id, [test, domain], this.origin);
    await dns.pointAtTunnel(test, found.id);
    this.patch({ tunnel: { ...(this.tunnelInfo() || {}), id: found.id, test, createdAt: (this.tunnelInfo() || {}).createdAt || this.now() } });
    await this.refreshTunnel();
    // A tunnel made just now has a token Roost wrote itself; an older one is asked for.
    if (!existing) return { token: found.token };
    try {
      return { token: await dns.tunnelToken(found.id) };
    } catch (err) {
      return { token: '', note: err.message };
    }
  }

  async tunnelToken() {
    const t = this.tunnelInfo();
    if (!t || !t.id) throw new Error('Create the tunnel first');
    return this.needDns().tunnelToken(t.id);
  }

  // Asks Cloudflare whether the tunnel container is connected.
  async refreshTunnel() {
    const t = this.tunnelInfo();
    if (!t || !t.id) return null;
    let next;
    try {
      const { status, connections } = await this.needDns().tunnelStatus(t.id);
      next = { ...t, status, connections, checkedAt: this.now(), error: '' };
    } catch (err) {
      next = { ...t, status: 'unknown', connections: 0, checkedAt: this.now(), error: err.message };
    }
    this.patch({ tunnel: next });
    // Tell someone only when it stops (healthy before, down now), not on every look.
    const was = t.status;
    if (this.tunnelOn() && this.onTunnelDown && (was === 'healthy' || was === 'degraded') && (next.status === 'down' || next.status === 'inactive')) this.onTunnelDown();
    return next;
  }

  // The toggle. 'tunnel': the main name goes through the tunnel and Roostflix
  // moves to its own direct name. 'direct': the main name goes back to an
  // ordinary record pointing at home. Neither touches the router or the tunnel.
  async setRoute(route) {
    if (route !== 'tunnel' && route !== 'direct') throw new Error('Route must be tunnel or direct');
    const dns = this.needDns();
    const { domain } = this.getTls();
    if (route === this.settings().route || (route === 'direct' && !this.settings().route)) {
      return this.settings().route || 'direct';
    }
    if (route === 'tunnel') {
      const t = await this.refreshTunnel();
      if (!t || !t.id) throw new Error('Create the tunnel first');
      if (t.status !== 'healthy' && t.status !== 'degraded') throw new Error('The tunnel isn’t connected yet. Start the tunnel container, check the test address, then switch');
      const ip = await this.homeIp();
      await dns.upsert({ type: 'A', name: this.streamHost(), content: ip, proxied: false });
      await dns.pointAtTunnel(domain, t.id);
      this.patch({ route: 'tunnel' });
      await this.sync({ force: true });
    } else {
      const ip = await this.homeIp();
      await dns.pointAtAddress(domain, ip, Boolean(this.settings().ddns));
      this.patch({ route: 'direct' });
      // With "keep pointed home" on, that job owns the record (orange cloud); otherwise leave it as set.
      if (this.settings().ddns) await this.sync({ force: true });
    }
    return route;
  }

  // Asks for Roost's own web address from the outside, the way a visitor would.
  async ping() {
    const { domain } = this.getTls() || {};
    let result;
    try {
      if (!domain) throw new Error('Set the domain under Secure connection first');
      const started = this.now();
      const res = await this.fetch(`https://${domain}/api/remote/ping`, { signal: AbortSignal.timeout(this.timeoutMs), redirect: 'manual' });
      const body = res.ok ? await res.json().catch(() => ({})) : {};
      if (body.nonce !== this.nonce) {
        throw new Error(res.ok
          ? 'Something answered at that address, but it isn’t this Roost. Check the router’s port forward and the DNS record'
          : `The address answered ${res.status}. Check the router’s port forward and the Cloudflare SSL mode (it should be Full (strict))`);
      }
      result = { ok: true, at: this.now(), ms: this.now() - started };
    } catch (err) {
      result = { ok: false, at: this.now(), error: /fetch failed|timeout|aborted/i.test(err.message) ? 'Nothing answered from outside. Check the router forwards port 443 to this server, and that your internet provider gives you a public address' : err.message };
    }
    this.patch({ reach: result });
    return result;
  }

  // Both checks, one at a time.
  check() {
    if (!this.busy) {
      this.busy = (async () => {
        if (this.settings().ddns || this.tunnelOn()) await this.sync({ force: true });
        if (this.tunnelOn()) await this.refreshTunnel();
        await this.ping();
      })().finally(() => { this.busy = null; });
    }
    return this.busy;
  }

  start() {
    this.first = setTimeout(() => this.tick(), this.firstMs);
    this.first.unref();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref();
  }

  tick() {
    const tunnel = this.tunnelOn();
    if (!(this.settings().ddns || tunnel) || this.busy) return;
    this.busy = (async () => {
      await this.sync();
      if (tunnel) await this.refreshTunnel();
    })().finally(() => { this.busy = null; });
  }

  stop() {
    clearTimeout(this.first);
    clearInterval(this.timer);
  }

  view() {
    const s = this.settings();
    const { domain, token } = this.getTls() || {};
    const dns = s.dns || null;
    return {
      domain: domain || '',
      tokenSaved: Boolean(token),
      ddns: Boolean(s.ddns),
      cloudflareOnly: Boolean(s.cloudflareOnly),
      dns,
      route: s.route === 'tunnel' ? 'tunnel' : 'direct',
      tunnel: s.tunnel ? { created: Boolean(s.tunnel.id), test: s.tunnel.test || '', status: s.tunnel.status || 'inactive', connections: s.tunnel.connections || 0, checkedAt: s.tunnel.checkedAt || null, error: s.tunnel.error || '' } : null,
      streamHost: this.streamHost(),
      reach: s.reach || null,
      cgnat: Boolean(dns && dns.cgnat),
    };
  }
}

// What an admin may save.
function clean(input) {
  return { ddns: input.ddns === true, cloudflareOnly: input.cloudflareOnly === true };
}

module.exports = { RemoteAccess, clean, isCloudflare, isHome, isCgnat, CLOUDFLARE };
