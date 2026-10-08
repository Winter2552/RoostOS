'use strict';

// "Update available" for the status page. For each image a container runs,
// Roost asks the image's registry for the current digest of its tag (one
// anonymous HEAD request, nothing downloaded) and compares it with the digest
// Docker pulled. It also notices a newer image that is already pulled but not
// running yet ("restart"), which needs no network at all.
//
// Nothing runs on a timer: a check starts only when an admin opens the status
// page and the saved result is over 12 hours old, and the page never waits
// for it. Roost never pulls or updates anything; updates happen in ZimaOS.

const fs = require('fs');
const path = require('path');
const { inspectImage } = require('./docker');

const MAX_AGE_MS = 12 * 60 * 60 * 1000;
const CHECK_NOW_GAP_MS = 60 * 1000;

// Ask for the multi-arch index first, so the digest matches the one Docker
// recorded when it pulled the tag, not one platform's manifest.
const ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
].join(', ');

// "jellyfin/jellyfin:latest" → { host: 'registry-1.docker.io', repo: 'jellyfin/jellyfin', tag: 'latest' }
// Pinned digests (name@sha256:…) and bare image IDs can't change, so → null.
function parseRef(ref) {
  let rest = String(ref || '');
  if (!rest || rest.includes('@') || rest.startsWith('sha256:')) return null;
  let registry = 'docker.io';
  const slash = rest.indexOf('/');
  if (slash > 0) {
    const first = rest.slice(0, slash);
    if (first.includes('.') || first.includes(':') || first === 'localhost') {
      registry = first;
      rest = rest.slice(slash + 1);
    }
  }
  let tag = 'latest';
  const colon = rest.lastIndexOf(':');
  if (colon > rest.lastIndexOf('/')) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  if (registry === 'docker.io') {
    if (!rest.includes('/')) rest = `library/${rest}`;
    return { host: 'registry-1.docker.io', repo: rest, tag };
  }
  return { host: registry, repo: rest, tag };
}

// Public registries answer a first request with 401 and where to get a free
// anonymous token for this one image.
async function anonToken(challenge, fetchFn, timeoutMs) {
  const m = /^Bearer\s+(.*)$/i.exec(challenge || '');
  if (!m) return null;
  const params = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
  let url;
  try {
    url = new URL(params.realm);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  for (const k of ['service', 'scope']) if (params[k]) url.searchParams.set(k, params[k]);
  const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) return null;
  const body = await res.json();
  return body.token || body.access_token || null;
}

async function remoteDigest(p, fetchFn, timeoutMs) {
  const url = `https://${p.host}/v2/${p.repo}/manifests/${encodeURIComponent(p.tag)}`;
  const head = (auth) => fetchFn(url, {
    method: 'HEAD',
    headers: { Accept: ACCEPT, ...(auth ? { Authorization: auth } : {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  let res = await head();
  if (res.status === 401) {
    const token = await anonToken(res.headers.get('www-authenticate'), fetchFn, timeoutMs);
    if (!token) return null;
    res = await head(`Bearer ${token}`);
  }
  return res.ok ? res.headers.get('docker-content-digest') : null;
}

const keyOf = (c) => `${c.imageRef}|${c.imageId}`;

class UpdateChecker {
  constructor({ dataDir, dockerHost, fetch: fetchFn = globalThis.fetch, timeoutMs = 10000, now = Date.now }) {
    this.file = path.join(dataDir, 'updates.json');
    this.dockerHost = dockerHost;
    this.fetch = fetchFn;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.running = null;
    this.lastCheckNow = 0;
    // { "image:tag|sha256:…": { state: 'current' | 'update' | 'restart' | null, checkedAt } }
    this.results = {};
    try {
      this.results = JSON.parse(fs.readFileSync(this.file, 'utf8')).results || {};
    } catch {
      // First run, or an unreadable file: everything gets checked.
    }
  }

  stale(containers) {
    return containers.some((c) => {
      const r = this.results[keyOf(c)];
      return !r || this.now() - new Date(r.checkedAt).getTime() > MAX_AGE_MS;
    });
  }

  // What the status page shows, from saved results: { containerId: { state, checkedAt } }.
  // Starts a check in the background when something is missing or old.
  view(containers) {
    const list = containers.filter((c) => c.imageRef && c.imageId);
    if (this.dockerHost && !this.running && this.stale(list)) {
      this.check(list).catch((err) => console.error('Update check failed:', err.message));
    }
    const out = {};
    for (const c of list) {
      const r = this.results[keyOf(c)];
      if (r && (r.state === 'update' || r.state === 'restart')) out[c.id] = r;
    }
    return out;
  }

  // The admin's "Check now", at most once a minute. → false when too soon.
  async checkNow(containers) {
    if (this.now() - this.lastCheckNow < CHECK_NOW_GAP_MS) return false;
    this.lastCheckNow = this.now();
    if (this.running) await this.running.catch(() => {});
    await this.check(containers.filter((c) => c.imageRef && c.imageId));
    return true;
  }

  check(list) {
    if (this.running) return this.running;
    this.running = (async () => {
      // One lookup per image, however many containers run it.
      const unique = [...new Map(list.map((c) => [keyOf(c), c])).values()];
      const fresh = {};
      await Promise.all(unique.map(async (c) => {
        const key = keyOf(c);
        const before = this.results[key];
        let state = null;
        try {
          state = await this.stateOf(c);
        } catch {
          // Registry unreachable: keep what we knew rather than guess.
          state = before ? before.state : null;
        }
        fresh[key] = { state, checkedAt: new Date(this.now()).toISOString() };
      }));
      // Keep only images still in use, so the file doesn't grow.
      this.results = fresh;
      this.save();
    })().finally(() => { this.running = null; });
    return this.running;
  }

  async stateOf(c) {
    const img = await inspectImage(this.dockerHost, c.imageRef);
    if (!img) return null;
    // The tag now points at a different image than the one running.
    if (img.id !== c.imageId) return 'restart';
    const p = parseRef(c.imageRef);
    const digests = img.repoDigests.map((d) => d.slice(d.indexOf('@') + 1));
    // Built on this machine (like Roost itself) or pinned: nothing to compare.
    if (!p || !digests.length) return null;
    const remote = await remoteDigest(p, this.fetch, this.timeoutMs);
    if (!remote) throw new Error('no digest');
    return digests.includes(remote) ? 'current' : 'update';
  }

  save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify({ results: this.results }));
    } catch (err) {
      console.error('Could not save update checks:', err.message);
    }
  }
}

module.exports = { UpdateChecker, parseRef, remoteDigest, MAX_AGE_MS };
