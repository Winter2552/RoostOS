'use strict';

// Read-only container info from the Docker Engine API, for the status page.
// DOCKER_HOST can be a TCP address (the docker-proxy service in
// docker-compose.yml, which only allows reading containers and images), a unix socket,
// or the Docker Desktop pipe on Windows.

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

function getJson(t, path, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get({ ...t, path, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
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
  });
}

// → { containers: [...] } or { error } when Docker can't be reached.
async function listContainers(dockerHost, timeoutMs = 2500) {
  const t = target(dockerHost);
  if (!t) return { error: 'not configured' };
  try {
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
        // For update checks: the tag it was started from and the image it runs.
        imageRef: (info.Config && info.Config.Image) || c.Image,
        imageId: info.Image || c.ImageID || '',
        project: (c.Labels && c.Labels['com.docker.compose.project']) || '',
        state: st.Status || c.State, // running, exited, restarting, paused, created, dead
        health: (st.Health && st.Health.Status) || null, // healthy, unhealthy, starting
        startedAt: st.Running && st.StartedAt ? st.StartedAt : null,
        finishedAt: !st.Running && st.FinishedAt && !st.FinishedAt.startsWith('0001') ? st.FinishedAt : null,
        exitCode: st.Running ? null : st.ExitCode ?? null,
        restarts: info.RestartCount ?? 0,
      };
    }));
    return { containers };
  } catch (err) {
    return { error: err.message };
  }
}

// The image a tag points at now, and the registry digests it was pulled as.
// → { id, repoDigests } or null (no such image, or images can't be read).
async function inspectImage(dockerHost, ref, timeoutMs = 2500) {
  const t = target(dockerHost);
  // Tags are plain names; anything else could reach another API path.
  if (!t || !/^[\w][\w./:-]*$/.test(String(ref)) || ref.includes('..')) return null;
  try {
    const img = await getJson(t, `/images/${ref}/json`, timeoutMs);
    return { id: img.Id, repoDigests: img.RepoDigests || [] };
  } catch {
    return null;
  }
}

// Whether the docker-proxy lets Roost read images (IMAGES=1), for the setup checklist.
async function canReadImages(dockerHost, timeoutMs = 2500) {
  const t = target(dockerHost);
  if (!t) return false;
  try {
    await getJson(t, '/images/json', timeoutMs);
    return true;
  } catch {
    return false;
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

module.exports = { listContainers, containersFor, inspectImage, canReadImages, target };
