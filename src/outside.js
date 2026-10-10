'use strict';

// "Outside services" on the status page, for admins: the few things Roost
// leans on that it doesn't run itself. Each gets one calm line, so a problem
// outside the house (a tunnel that dropped, a certificate that didn't renew)
// shows up here instead of as a mystery.
//
// It costs almost nothing: the tunnel comes from the container list the status
// page already reads, the certificate from what Roost already keeps about it,
// and the two things that need the internet (Docker Hub, the Cloudflare token)
// are checked once a day and the answer is remembered.

const DAY = 24 * 60 * 60 * 1000;
// Renewal starts at 30 days left, so under this many means it isn't working.
const CERT_WATCH_DAYS = 14;

async function timed(fetchImpl, url, init, timeoutMs) {
  const start = Date.now();
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
  return { res, ms: Date.now() - start };
}

class OutsideServices {
  constructor({ fetchImpl = fetch, timeoutMs = 6000, now = Date.now, firstCheckMs = 30 * 1000, tokenOf = () => '' } = {}) {
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.firstCheckMs = firstCheckMs;
    this.tokenOf = tokenOf;
    this.checks = { dockerHub: null, cloudflare: null };
    this.busy = null;
    this.timer = null;
    this.first = null;
  }

  // Docker Hub answers 401 ("sign in to read") to an anonymous hello: still proof it is up.
  async checkDockerHub() {
    try {
      const { res, ms } = await timed(this.fetch, 'https://registry-1.docker.io/v2/', { method: 'GET' }, this.timeoutMs);
      return { ok: res.status === 200 || res.status === 401, ms, detail: res.status === 200 || res.status === 401 ? '' : `Docker Hub answered ${res.status}`, at: this.now() };
    } catch {
      return { ok: false, ms: null, detail: 'Roost couldn’t reach Docker Hub', at: this.now() };
    }
  }

  // Asks Cloudflare whether the saved token still works: the same token Roost
  // uses for the certificate, so no new setup and nothing new stored.
  async checkCloudflare(token) {
    if (!token) return null;
    try {
      const { res } = await timed(this.fetch, 'https://api.cloudflare.com/client/v4/user/tokens/verify', { headers: { Authorization: `Bearer ${token}` } }, this.timeoutMs);
      const body = await res.json().catch(() => ({}));
      const active = res.ok && body.success !== false && (!body.result || body.result.status === 'active');
      return { ok: active, detail: active ? '' : res.status === 401 || res.status === 403 ? 'Cloudflare no longer accepts the saved token' : `Cloudflare answered ${res.status}`, at: this.now() };
    } catch {
      return { ok: false, detail: 'Roost couldn’t reach Cloudflare', at: this.now(), unreachable: true };
    }
  }

  // One round of the slow checks. Only one runs at a time.
  check() {
    if (this.busy) return this.busy;
    this.busy = (async () => {
      const [dockerHub, cloudflare] = await Promise.all([this.checkDockerHub(), this.checkCloudflare(this.tokenOf())]);
      this.checks = { dockerHub, cloudflare };
    })().finally(() => { this.busy = null; });
    return this.busy;
  }

  // First check shortly after start (not in the middle of booting), then daily.
  start() {
    this.first = setTimeout(() => this.check(), this.firstCheckMs);
    this.first.unref();
    this.timer = setInterval(() => this.check(), DAY);
    this.timer.unref();
  }

  stop() {
    clearTimeout(this.first);
    clearInterval(this.timer);
  }

  // Forget a stale Cloudflare answer when the token changes or goes away.
  forgetCloudflare() {
    this.checks.cloudflare = null;
  }

  // containers: Docker's list (or null when Docker isn't connected).
  // cert: CertManager.status().  → [{ id, name, state, headline, detail, checkedAt }]
  view({ containers, cert }) {
    return [this.tunnel(containers, cert), this.letsEncrypt(cert), this.dockerHubLine()];
  }

  tunnel(containers, cert) {
    const base = { id: 'cloudflare', name: 'Cloudflare', role: 'Tunnel and DNS' };
    const cf = this.checks.cloudflare;
    const tunnel = (containers || []).filter((c) => /cloudflared/i.test(`${c.name} ${c.image}`));
    const lines = [];
    let state = 'good';
    let headline = 'Tunnel running';
    if (!containers) {
      return { ...base, state: 'unset', headline: 'Can’t see Docker', detail: 'Connect Docker to see the tunnel', checkedAt: null };
    }
    if (!tunnel.length) {
      if (!cert.domain && !cf) return { ...base, state: 'unset', headline: 'Not set up yet', detail: 'Add a domain under Admin → Secure connection', checkedAt: null };
      state = 'watch';
      headline = 'No tunnel container found';
      lines.push('Roost can’t see a cloudflared container, so it can’t tell if the tunnel is up');
    } else {
      const worst = tunnel.find((c) => c.state !== 'running') || tunnel.find((c) => c.health === 'unhealthy') || tunnel[0];
      if (worst.state === 'restarting') { state = 'bad'; headline = 'Tunnel keeps restarting'; }
      else if (worst.state !== 'running') { state = 'bad'; headline = 'Tunnel stopped'; }
      else if (worst.health === 'unhealthy') { state = 'bad'; headline = 'Tunnel unhealthy'; }
      lines.push(`${worst.name}${worst.restarts ? ` · ${worst.restarts} restart${worst.restarts > 1 ? 's' : ''}` : ''}`);
    }
    if (cf && !cf.ok && !cf.unreachable) {
      if (state === 'good') { state = 'watch'; headline = 'Token needs attention'; }
      lines.unshift(cf.detail);
    } else if (cf && cf.ok) {
      lines.push('Saved token works');
    }
    return { ...base, state, headline, detail: lines.join(' · '), checkedAt: cf ? new Date(cf.at).toISOString() : null };
  }

  letsEncrypt(cert) {
    const base = { id: 'letsencrypt', name: 'Let’s Encrypt', role: 'HTTPS certificate' };
    if (!cert || cert.state === 'off') return { ...base, state: 'unset', headline: 'Not set up yet', detail: 'Turn on HTTPS under Admin → Secure connection', checkedAt: null };
    const c = cert.certificate;
    const days = c ? c.daysLeft : null;
    const lastTry = cert.lastAttemptAt ? new Date(cert.lastAttemptAt).toISOString() : null;
    if (cert.state === 'working') return { ...base, state: 'watch', headline: 'Getting a certificate', detail: cert.step || '', checkedAt: lastTry };
    if (cert.state === 'pending') return { ...base, state: 'watch', headline: 'Waiting to get one', detail: cert.domain, checkedAt: lastTry };
    if (cert.state === 'error' || !c) return { ...base, state: 'bad', headline: 'No certificate', detail: cert.lastError || 'Couldn’t get one', checkedAt: lastTry };
    const until = new Date(c.expiresAt).toISOString();
    const expired = days < 0;
    const low = days < CERT_WATCH_DAYS;
    return {
      ...base,
      state: expired ? 'bad' : low ? 'watch' : 'good',
      headline: expired ? 'Expired' : low ? `Runs out in ${days} day${days === 1 ? '' : 's'}` : 'Certificate valid',
      detail: low && cert.lastError ? `Renewing isn’t working: ${cert.lastError}` : `${cert.staging ? 'Test certificate · ' : ''}${cert.domain}`,
      expiresAt: until,
      daysLeft: days,
      checkedAt: lastTry,
    };
  }

  dockerHubLine() {
    const base = { id: 'dockerhub', name: 'Docker Hub', role: 'Where app images come from' };
    const h = this.checks.dockerHub;
    if (!h) return { ...base, state: 'unset', headline: 'Not checked yet', detail: 'Checked once a day', checkedAt: null };
    return {
      ...base,
      state: h.ok ? 'good' : 'watch',
      headline: h.ok ? 'Reachable' : 'Can’t reach it',
      // Only matters when installing or updating an app, so a miss is a nudge, not an alarm.
      detail: h.ok ? `${h.ms} ms` : `${h.detail}. Running apps keep working; installs and updates wait`,
      checkedAt: new Date(h.at).toISOString(),
    };
  }
}

module.exports = { OutsideServices, CERT_WATCH_DAYS };
