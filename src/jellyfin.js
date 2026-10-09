'use strict';

// Roost's link to Jellyfin: keeps Jellyfin accounts in step with Roost users,
// signs people in to Jellyfin when they sign in to Roost, and passes Jellyfin
// through under /jellyfin/ so its web page opens already signed in.
// Everything here is best effort: if Jellyfin is down or not set up, Roost
// works as before and Jellyfin just shows its own sign-in page.

const http = require('http');
const https = require('https');

const PREFIX = '/jellyfin';
const TIMEOUT_MS = 5000;
const USERS_CACHE_MS = 60 * 1000;
const RESUME_CACHE_MS = 30 * 1000;
const RESUME_LIMIT = 12;
const POSTER_WIDTH = 480;
const TICKS_PER_MINUTE = 600000000;
const CLIENT = 'Roost';
const VERSION = '1.0';

function authHeader({ token, device = 'Roost', deviceId = 'roost' } = {}) {
  const q = (v) => String(v).replace(/["\\,]/g, '');
  const parts = [`Client="${CLIENT}"`, `Device="${q(device)}"`, `DeviceId="${q(deviceId)}"`, `Version="${VERSION}"`];
  if (token) parts.push(`Token="${token}"`);
  return `MediaBrowser ${parts.join(', ')}`;
}

const safeId = (v) => (typeof v === 'string' && /^[A-Za-z0-9-]+$/.test(v) ? v : null);

// A wide picture for the row, in the order Jellyfin's own Continue watching
// prefers them. Images are fetched through /jellyfin, with the tag so the
// browser can keep them.
function picture(it) {
  const tags = it.ImageTags || {};
  const pick = [
    [it.Id, 'Thumb', tags.Thumb],
    it.Type === 'Episode' ? [it.Id, 'Primary', tags.Primary] : null,
    [it.ParentThumbItemId, 'Thumb', it.ParentThumbImageTag],
    [it.Id, 'Backdrop/0', (it.BackdropImageTags || [])[0]],
    [it.ParentBackdropItemId, 'Backdrop/0', (it.ParentBackdropImageTags || [])[0]],
    [it.Id, 'Primary', tags.Primary],
  ].find((c) => c && safeId(c[0]) && safeId(c[2]));
  return pick ? `${PREFIX}/Items/${pick[0]}/Images/${pick[1]}?fillWidth=${POSTER_WIDTH}&quality=80&tag=${pick[2]}` : null;
}

function resumeItem(it) {
  const id = safeId(it.Id);
  if (!id) return null;
  const data = it.UserData || {};
  const episode = it.Type === 'Episode';
  const left = it.RunTimeTicks && data.PlaybackPositionTicks ? Math.max(1, Math.round((it.RunTimeTicks - data.PlaybackPositionTicks) / TICKS_PER_MINUTE)) : null;
  const where = episode && it.ParentIndexNumber != null && it.IndexNumber != null ? `S${it.ParentIndexNumber} E${it.IndexNumber}` : null;
  return {
    id,
    serverId: safeId(it.ServerId),
    title: String((episode && it.SeriesName) || it.Name || ''),
    subtitle: episode ? String(it.Name || '') : '',
    where,
    minutesLeft: left,
    percent: Math.max(0, Math.min(100, Math.round(data.PlayedPercentage || 0))),
    image: picture(it),
  };
}

class Jellyfin {
  // config() returns { url, apiKey } from Roost's settings, or null.
  constructor(config) {
    this.config = config;
    this.cache = null;
    this.resumeCache = new Map();
    this.queue = Promise.resolve();
  }

  enabled() {
    const c = this.config();
    return Boolean(c && c.url && c.apiKey);
  }

  // Changes are sent one at a time: Jellyfin refuses overlapping updates to
  // the same account (for example signing out and switching it off at once).
  call(method, path, opts = {}) {
    if (method === 'GET') return this.send(method, path, opts);
    const run = this.queue.then(() => this.send(method, path, opts));
    this.queue = run.catch(() => {});
    return run;
  }

  async send(method, path, { body, token, device, deviceId } = {}) {
    const c = this.config();
    if (!c || !c.url) throw new Error('Jellyfin is not set up');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(c.url.replace(/\/+$/, '') + path, {
        method,
        headers: {
          Authorization: authHeader({ token: token === undefined ? c.apiKey : token, device, deviceId }),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const err = new Error(`Jellyfin answered ${res.status}`);
        err.status = res.status;
        throw err;
      }
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    } finally {
      clearTimeout(timer);
    }
  }

  // For the admin page: proves the address and API key work.
  async check() {
    const info = await this.call('GET', '/System/Info');
    const users = await this.users(true);
    return { serverName: info.ServerName, version: info.Version, accounts: users.length };
  }

  async users(fresh = false) {
    if (!fresh && this.cache && this.cache.until > Date.now()) return this.cache.list;
    const list = await this.call('GET', '/Users');
    this.cache = { list, until: Date.now() + USERS_CACHE_MS };
    return list;
  }

  async find(username) {
    const name = username.toLowerCase();
    return (await this.users()).find((u) => u.Name.toLowerCase() === name) || null;
  }

  async setDisabled(jfUser, disabled) {
    if (jfUser.Policy.IsDisabled === disabled) return;
    await this.call('POST', `/Users/${jfUser.Id}/Policy`, { body: { ...jfUser.Policy, IsDisabled: disabled } });
    jfUser.Policy.IsDisabled = disabled;
  }

  // Makes sure a Jellyfin account with this name exists, is switched on and
  // has this password. Jellyfin admin accounts are never changed: Roost only
  // tries the password on them.
  async ensureAccount(username, password) {
    let jfUser = await this.find(username);
    if (!jfUser) {
      jfUser = await this.call('POST', '/Users/New', { body: { Name: username, Password: password } });
      this.cache = null;
      return jfUser;
    }
    if (jfUser.Policy.IsAdministrator) return jfUser;
    await this.setDisabled(jfUser, false);
    await this.call('POST', `/Users/${jfUser.Id}/Password`, { body: { NewPw: password } });
    return jfUser;
  }

  // Signs in as the user. Each Roost sign-in is its own Jellyfin device, so
  // signing out of one doesn't touch the others.
  async signIn(username, password, { device, deviceId }) {
    const res = await this.call('POST', '/Users/AuthenticateByName', {
      token: null, device, deviceId, body: { Username: username, Pw: password },
    });
    return { token: res.AccessToken, userId: res.User.Id, serverId: res.ServerId };
  }

  async logout(token) {
    await this.call('POST', '/Sessions/Logout', { token });
  }

  // What this person was part way through, newest first, for the dashboard's
  // Continue watching row. Kept for a short while so reloading the dashboard
  // doesn't ask Jellyfin again each time.
  async resume(username) {
    const hit = this.resumeCache.get(username);
    if (hit && hit.until > Date.now()) return hit.items;
    const jfUser = await this.find(username);
    if (!jfUser || jfUser.Policy.IsDisabled) return [];
    const q = `userId=${jfUser.Id}&limit=${RESUME_LIMIT}&mediaTypes=Video&enableUserData=true&imageTypeLimit=1&enableImageTypes=Primary,Thumb,Backdrop`;
    let res;
    try {
      res = await this.call('GET', `/UserItems/Resume?${q}`);
    } catch (err) {
      // Jellyfin before 10.9 only has the older address.
      if (err.status !== 404) throw err;
      res = await this.call('GET', `/Users/${jfUser.Id}/Items/Resume?${q}`);
    }
    const items = ((res && res.Items) || []).map(resumeItem).filter(Boolean);
    this.resumeCache.set(username, { items, until: Date.now() + RESUME_CACHE_MS });
    return items;
  }

  // Someone was given Jellyfin access again. A new account can only be made
  // once Roost knows their password, at their next sign-in.
  async enable(username) {
    const jfUser = await this.find(username);
    if (jfUser && !jfUser.Policy.IsAdministrator) await this.setDisabled(jfUser, false);
  }

  // Someone lost access to Jellyfin in Roost, or was deleted.
  async disable(username) {
    const jfUser = await this.find(username);
    if (jfUser && !jfUser.Policy.IsAdministrator) await this.setDisabled(jfUser, true);
  }

  // ---------- passing Jellyfin through under /jellyfin/ ----------

  target(req) {
    const c = this.config();
    const base = new URL(c.url);
    const path = req.url.slice(PREFIX.length) || '/';
    const headers = { ...req.headers, host: base.host };
    // Roost's own sign-in cookies stay with Roost.
    delete headers.cookie;
    return {
      mod: base.protocol === 'https:' ? https : http,
      options: {
        hostname: base.hostname,
        port: base.port || (base.protocol === 'https:' ? 443 : 80),
        path: base.pathname.replace(/\/+$/, '') + path,
        method: req.method,
        headers,
      },
    };
  }

  proxy(req, res) {
    const { mod, options } = this.target(req);
    const out = mod.request(options, (up) => {
      const headers = { ...up.headers };
      // Jellyfin's redirects point at its own root; keep them under /jellyfin.
      if (typeof headers.location === 'string' && headers.location.startsWith('/')) headers.location = PREFIX + headers.location;
      res.writeHead(up.statusCode, headers);
      up.pipe(res);
    });
    out.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Jellyfin is not answering right now.');
      } else {
        res.destroy();
      }
    });
    req.pipe(out);
  }

  // Live updates (what's playing, remote control) use a WebSocket.
  proxyUpgrade(req, socket, head) {
    const { mod, options } = this.target(req);
    const out = mod.request(options);
    out.on('upgrade', (up, upSocket, upHead) => {
      const lines = [`HTTP/1.1 ${up.statusCode} ${up.statusMessage}`];
      for (let i = 0; i < up.rawHeaders.length; i += 2) lines.push(`${up.rawHeaders[i]}: ${up.rawHeaders[i + 1]}`);
      socket.write(lines.join('\r\n') + '\r\n\r\n');
      if (upHead.length) socket.write(upHead);
      if (head.length) upSocket.write(head);
      upSocket.pipe(socket).pipe(upSocket);
      upSocket.on('error', () => socket.destroy());
      socket.on('error', () => upSocket.destroy());
    });
    out.on('response', () => socket.destroy());
    out.on('error', () => socket.destroy());
    out.end();
  }
}

// The page /jellyfin/ serves: it saves this person's Jellyfin sign-in where
// Jellyfin's web app looks for it, then opens Jellyfin. With no sign-in to
// hand over, Jellyfin simply shows its own sign-in page.
const OPENER_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Opening Jellyfin</title><style>html,body{margin:0;height:100%;background:#000;color:#fff;font:15px system-ui,sans-serif}
body{display:flex;align-items:center;justify-content:center}</style></head>
<body><p>Opening Jellyfin…</p>
<script>
(async () => {
  const KEY = 'jellyfin_credentials';
  try {
    const res = await fetch('/api/jellyfin/session', { credentials: 'same-origin', cache: 'no-store' });
    const s = res.ok ? await res.json() : {};
    if (s.token) {
      let saved = {};
      try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch {}
      const servers = (saved.Servers || []).filter((x) => x.Id !== s.serverId);
      servers.unshift({ Id: s.serverId, Name: s.serverName || 'Jellyfin', ManualAddress: location.origin + '${PREFIX}',
        LastConnectionMode: 2, DateLastAccessed: Date.now(), AccessToken: s.token, UserId: s.userId });
      localStorage.setItem(KEY, JSON.stringify({ ...saved, Servers: servers }));
    }
  } catch {}
  // The Continue watching row links straight to an item's page.
  const to = /^#\\/details\\?id=[A-Za-z0-9-]+(&serverId=[A-Za-z0-9-]+)?$/.test(location.hash) ? location.hash : '';
  location.replace('${PREFIX}/web/' + to);
})();
</script></body></html>`;

module.exports = { Jellyfin, PREFIX, OPENER_HTML, authHeader };
