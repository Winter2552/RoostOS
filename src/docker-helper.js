'use strict';

// Roost's own narrow window onto Docker. It runs as a second container (same
// image, see docker-compose.yml), holds the Docker socket, and passes on only:
//   GET  /containers/json             the container list
//   GET  /containers/<id or name>/json one container's details
//   POST /containers/<name>/restart   only for names in ROOST_RESTARTABLE
//   GET  /roost/restartable           that list, so Roost knows which to offer
// Everything else gets a 403, so even a broken-into Roost can't start, stop,
// create, exec into or read files from containers.

const http = require('http');

const SOCKET = '/var/run/docker.sock';
// Docker waits this long for an app to stop before forcing it.
const STOP_WAIT_S = 10;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

function parseNames(spec) {
  return [...new Set(String(spec || '').split(',').map((s) => s.trim()).filter((s) => NAME.test(s)))];
}

// What a request is allowed to become at Docker, or null to refuse it.
function allowed(method, rawUrl, restartable) {
  let url;
  try {
    url = new URL(rawUrl, 'http://helper');
  } catch {
    return null;
  }
  // Docker API clients may prefix a version, e.g. /v1.43/containers/json.
  const path = url.pathname.replace(/^\/v\d+\.\d+(?=\/)/, '');
  if (method === 'GET' && path === '/_ping') return { path: '/_ping' };
  if (method === 'GET' && path === '/containers/json') {
    return { path: `/containers/json${url.searchParams.get('all') === '1' ? '?all=1' : ''}` };
  }
  const m = path.match(/^\/containers\/([^/]+)\/(json|restart)$/);
  if (!m || !NAME.test(m[1])) return null;
  if (method === 'GET' && m[2] === 'json') return { path: `/containers/${m[1]}/json` };
  if (method === 'POST' && m[2] === 'restart' && restartable.includes(m[1])) {
    return { path: `/containers/${m[1]}/restart?t=${STOP_WAIT_S}`, method: 'POST' };
  }
  return null;
}

function createHelper({ socketPath = SOCKET, restartable = [] } = {}) {
  return http.createServer((req, res) => {
    req.resume(); // Bodies are never passed on.
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/roost/restartable') return json(200, { names: restartable });
    const to = allowed(req.method, req.url, restartable);
    if (!to) return json(403, { message: 'Roost\'s Docker helper does not allow that' });
    const up = http.request({ socketPath, path: to.path, method: to.method || 'GET' }, (dr) => {
      res.writeHead(dr.statusCode, { 'Content-Type': dr.headers['content-type'] || 'application/json' });
      dr.pipe(res);
    });
    up.on('error', (err) => json(502, { message: `Docker: ${err.message}` }));
    up.end();
  });
}

if (require.main === module) {
  const port = 2375;
  const restartable = parseNames(process.env.ROOST_RESTARTABLE);
  createHelper({ restartable }).listen(port, () => {
    console.log(`Roost Docker helper on port ${port}; restartable: ${restartable.join(', ') || 'none'}`);
  });
  process.on('SIGTERM', () => process.exit(0));
}

module.exports = { createHelper, allowed, parseNames };
