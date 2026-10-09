'use strict';

// Container info from the Docker Engine API, for the status page, and
// restarts for admins. DOCKER_HOST can be a TCP address (Roost's own Docker
// helper in docker-compose.yml, src/docker-helper.js, which only allows
// reading containers and restarting the ones it lists), a unix socket, or the
// Docker Desktop pipe on Windows. Restarts only work through the helper.

const http = require('http');

function target(dockerHost) {
  const h = String(dockerHost || '');
  if (h.startsWith('unix://')) return { socketPath: h.slice('unix://'.length) };
  // Docker Desktop on Windows: npipe:////./pipe/docker_engine
  if (h.startsWith('npipe://')) return { socketPath: h.slice('npipe://'.length).replace(/\//g, '\\') };
  if (h.startsWith('/')) return { socketPath: h };
  if (h.startsWith('tcp://') || h.startsWith('http://')) {
    const u = new URL(h.replace(/^tcp:/, 'http:'));
    return { host: u.hostname, port: Number(u.port) || 2375 };
  }
  return null;
}

function getJson(t, path, timeoutMs, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ ...t, path, method, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode === 204) return resolve(null);
        if (res.statusCode !== 200) return reject(new Error(`Docker answered ${res.statusCode}`));
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Docker timed out')));
    req.on('error', reject);
    req.end();
  });
}

// Host ports a container is reachable on, e.g. [{ public: 8097, private: 8096 }].
// The same port shows once per address (IPv4 and IPv6), so duplicates go.
function publishedPorts(list) {
  const seen = new Set();
  return (list || [])
    .filter((p) => p.PublicPort && p.Type !== 'udp' && !seen.has(p.PublicPort) && seen.add(p.PublicPort))
    .map((p) => ({ public: p.PublicPort, private: p.PrivatePort }))
    .sort((a, b) => a.public - b.public);
}

// One reading is shared for a couple of seconds, so several open status pages
// (and the setup checklist) don't each ask Docker the same thing.
const SHARE_MS = 2000;
const shared = new Map();

// → { containers: [...], restartable: [names] } or { error } when Docker can't be reached.
function listContainers(dockerHost, timeoutMs = 2500) {
  const hit = shared.get(dockerHost);
  if (hit && Date.now() - hit.at < SHARE_MS) return hit.reading;
  const reading = readContainers(dockerHost, timeoutMs);
  shared.set(dockerHost, { at: Date.now(), reading });
  return reading;
}

async function readContainers(dockerHost, timeoutMs) {
  const t = target(dockerHost);
  if (!t) return { error: 'not configured' };
  try {
    // Only Roost's helper answers this; straight Docker has no restart list.
    const restartable = getJson(t, '/roost/restartable', timeoutMs).then((r) => r.names || [], () => []);
    const list = await getJson(t, '/containers/json?all=1', timeoutMs);
    const containers = await Promise.all(list.map(async (c) => {
      // Inspect gives the start time, restart count and health check result.
      let info = {};
      try {
        info = await getJson(t, `/containers/${c.Id}/json`, timeoutMs);
      } catch {
        // Fall back to what the list call gave us.
      }
      const st = info.State || {};
      return {
        id: c.Id.slice(0, 12),
        name: String((c.Names && c.Names[0]) || c.Id).replace(/^\//, ''),
        image: c.Image,
        project: (c.Labels && c.Labels['com.docker.compose.project']) || '',
        state: st.Status || c.State, // running, exited, restarting, paused, created, dead
        health: (st.Health && st.Health.Status) || null, // healthy, unhealthy, starting
        startedAt: st.Running && st.StartedAt ? st.StartedAt : null,
        finishedAt: !st.Running && st.FinishedAt && !st.FinishedAt.startsWith('0001') ? st.FinishedAt : null,
        exitCode: st.Running ? null : st.ExitCode ?? null,
        restarts: info.RestartCount ?? 0,
        ports: publishedPorts(c.Ports),
      };
    }));
    return { containers, restartable: await restartable };
  } catch (err) {
    return { error: err.message };
  }
}

// Which containers belong to an app: the names typed in Admin, otherwise any
// container or compose project named after the app.
function containersFor(app, containers) {
  const wanted = String(app.container || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const keys = wanted.length ? wanted : [app.id, app.name].map((s) => String(s).toLowerCase());
  return containers.filter((c) => {
    const name = c.name.toLowerCase();
    const project = c.project.toLowerCase();
    return wanted.length
      ? keys.includes(name) || keys.includes(project)
      : keys.some((k) => k && (name === k || project === k || name.startsWith(`${k}-`) || name.startsWith(`${k}_`)));
  });
}

// Docker answers once the container is back up (or gave up), so this can take
// as long as the app needs to stop and start.
async function restartContainer(dockerHost, name, timeoutMs = 60 * 1000) {
  const t = target(dockerHost);
  if (!t) throw new Error('Docker is not connected');
  try {
    await getJson(t, `/containers/${encodeURIComponent(name)}/restart`, timeoutMs, 'POST');
  } finally {
    shared.delete(dockerHost);
  }
}

module.exports = { listContainers, containersFor, restartContainer, target };
