'use strict';

// The few Cloudflare DNS calls Roost needs: find the zone, add a TXT record to
// prove it owns the domain (and remove it again), and keep an A record pointed
// at home. Uses an API token that
// only needs "Zone · DNS · Edit" on the one domain.

const API = 'https://api.cloudflare.com/client/v4';

class CloudflareDns {
  constructor({ token, domain, apiBase = API, fetchImpl = fetch }) {
    this.token = token;
    this.domain = domain;
    this.apiBase = apiBase;
    this.fetch = fetchImpl;
    this.zoneId = null;
  }

  async call(method, path, body, need = 'Zone · DNS · Edit for this domain') {
    const res = await this.fetch(this.apiBase + path, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
      const msg = (data.errors && data.errors[0] && data.errors[0].message) || `HTTP ${res.status}`;
      throw new Error(res.status === 401 || res.status === 403
        ? `Cloudflare refused the token. It needs ${need}.`
        : `Cloudflare: ${msg}`);
    }
    return data.result;
  }

  async zone() {
    if (!this.zoneId) {
      const zones = await this.call('GET', `/zones?name=${encodeURIComponent(this.domain)}`);
      if (!zones || !zones.length) throw new Error(`Cloudflare has no domain called ${this.domain} on this account`);
      this.zoneId = zones[0].id;
      this.account = (zones[0].account && zones[0].account.id) || null;
    }
    return this.zoneId;
  }

  async accountId() {
    await this.zone();
    if (!this.account) throw new Error('Cloudflare didn’t say which account owns this domain');
    return this.account;
  }

  // ---------- Cloudflare Tunnel (remotely managed) ----------

  tunnelCall(method, path, body) {
    return this.accountId().then((acct) => this.call(method, `/accounts/${acct}/cfd_tunnel${path}`, body, 'Account · Cloudflare Tunnel · Edit'));
  }

  // The tunnel called `name`, or null.
  async findTunnel(name) {
    const found = await this.tunnelCall('GET', `?name=${encodeURIComponent(name)}&is_deleted=false`);
    return (found && found[0]) || null;
  }

  async createTunnel(name) {
    return this.tunnelCall('POST', '', { name, config_src: 'cloudflare' });
  }

  // Which names the tunnel answers for, and the address it hands them to
  // (inside Docker, so no certificate is needed on that last step).
  async configureTunnel(id, hostnames, service) {
    const ingress = [...hostnames.map((hostname) => ({ hostname, service })), { service: 'http_status:404' }];
    await this.tunnelCall('PUT', `/${id}/configurations`, { config: { ingress } });
  }

  async tunnelToken(id) {
    return this.tunnelCall('GET', `/${id}/token`);
  }

  // → { status: healthy | degraded | down | inactive, connections: n }
  async tunnelStatus(id) {
    const t = await this.tunnelCall('GET', `/${id}`);
    return { status: t.status || 'inactive', connections: (t.connections || []).length };
  }

  // Makes `name` a CNAME to the tunnel, removing any A/AAAA record it replaces
  // (Cloudflare refuses a CNAME next to another record).
  async pointAtTunnel(name, id) {
    const zone = await this.zone();
    const target = `${id}.cfargotunnel.com`;
    const found = await this.call('GET', `/zones/${zone}/dns_records?name=${encodeURIComponent(name)}`);
    for (const r of found || []) {
      if (r.type === 'CNAME' && r.content === target && r.proxied) return { id: r.id, changed: false };
      if (['A', 'AAAA', 'CNAME'].includes(r.type)) await this.remove(r.id);
    }
    const made = await this.call('POST', `/zones/${zone}/dns_records`, { type: 'CNAME', name, content: target, ttl: 1, proxied: true });
    return { id: made.id, changed: true };
  }

  // The other way: drop a CNAME on `name`, then make it an ordinary A record.
  async pointAtAddress(name, ip, proxied) {
    const zone = await this.zone();
    const found = await this.call('GET', `/zones/${zone}/dns_records?name=${encodeURIComponent(name)}`);
    for (const r of found || []) if (r.type === 'CNAME') await this.remove(r.id);
    return this.upsert({ type: 'A', name, content: ip, proxied });
  }

  async set(name, content) {
    const zone = await this.zone();
    const rec = await this.call('POST', `/zones/${zone}/dns_records`, { type: 'TXT', name, content, ttl: 60 });
    return rec.id;
  }

  // Makes one DNS record say `content`, adding it or fixing it. Returns
  // whether anything had to change. `proxied` is Cloudflare's orange cloud.
  async upsert({ type, name, content, proxied = true }) {
    const zone = await this.zone();
    const found = await this.call('GET', `/zones/${zone}/dns_records?type=${type}&name=${encodeURIComponent(name)}`);
    const body = { type, name, content, ttl: 1, proxied };
    if (found && found.length) {
      const now = found[0];
      if (now.content === content && Boolean(now.proxied) === proxied) return { id: now.id, changed: false };
      await this.call('PUT', `/zones/${zone}/dns_records/${now.id}`, body);
      return { id: now.id, changed: true };
    }
    const made = await this.call('POST', `/zones/${zone}/dns_records`, body);
    return { id: made.id, changed: true };
  }

  async remove(id) {
    await this.call('DELETE', `/zones/${await this.zone()}/dns_records/${id}`);
  }
}

module.exports = { CloudflareDns };
