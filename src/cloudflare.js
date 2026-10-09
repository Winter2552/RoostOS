'use strict';

// The few Cloudflare DNS calls Roost needs to prove it owns the domain:
// find the zone, add a TXT record, remove it again. Uses an API token that
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

  async call(method, path, body) {
    const res = await this.fetch(this.apiBase + path, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
      const msg = (data.errors && data.errors[0] && data.errors[0].message) || `HTTP ${res.status}`;
      throw new Error(res.status === 401 || res.status === 403
        ? 'Cloudflare refused the token. It needs Zone · DNS · Edit for this domain.'
        : `Cloudflare: ${msg}`);
    }
    return data.result;
  }

  async zone() {
    if (!this.zoneId) {
      const zones = await this.call('GET', `/zones?name=${encodeURIComponent(this.domain)}`);
      if (!zones || !zones.length) throw new Error(`Cloudflare has no domain called ${this.domain} on this account`);
      this.zoneId = zones[0].id;
    }
    return this.zoneId;
  }

  async set(name, content) {
    const zone = await this.zone();
    const rec = await this.call('POST', `/zones/${zone}/dns_records`, { type: 'TXT', name, content, ttl: 60 });
    return rec.id;
  }

  async remove(id) {
    await this.call('DELETE', `/zones/${await this.zone()}/dns_records/${id}`);
  }
}

module.exports = { CloudflareDns };
