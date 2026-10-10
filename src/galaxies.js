'use strict';

// Other galaxies. Coffee Galaxy has its own server and its own card (src/coffee.js);
// every other galaxy runs as a Docker container on this box. Roost keeps one
// entry per galaxy, answers for it at nova.<domain>/<id>/, checks the person is
// signed in and has the app, and forwards the request with the same signed
// header Coffee Galaxy gets (see docs/galaxies.md for what a galaxy must do).

const { Coffee, validSecret, newSecret } = require('./coffee');

const ID_RE = /^[a-z][a-z0-9-]{1,23}$/;
// Names under nova.<domain> that are taken, or would read like Roost's own pages.
const RESERVED = new Set(['coffee', 'api', 'admin', 'roost', 'assets', 'static', 'jellyfin', 'nest', 'glint']);
// A galaxy is a web app: it only has to answer these without a Roost sign-in.
const OPEN = new Set(['/__health', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png']);
const MAX = 12;
// From inside Roost's container the box itself is this name (docker-compose.yml maps it).
const HOST = 'host.docker.internal';
const HOST_RE = /^[a-z0-9]([a-z0-9.-]{0,60}[a-z0-9])?$/i;
const IMAGE_RE = /^[a-z0-9][a-z0-9._/-]{0,100}(:[a-zA-Z0-9._-]{1,60})?$/i;

const appId = (id) => `galaxy-${id}`;

// "books" → "books"; "My Books!" → "my-books"; anything unusable → ''.
function slug(name) {
  const s = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  return ID_RE.test(s) ? s : '';
}

// "host.docker.internal:8200", "192.168.4.35:8200" or just "8200" → { host, port } or null.
function parseAddress(input) {
  const text = String(input || '').trim();
  if (/^\d{1,5}$/.test(text)) return validPort(Number(text)) ? { host: HOST, port: Number(text) } : null;
  const m = text.match(/^([^:/\s]+):(\d{1,5})$/);
  if (!m || !HOST_RE.test(m[1]) || !validPort(Number(m[2]))) return null;
  return { host: m[1].toLowerCase(), port: Number(m[2]) };
}

function validPort(n) {
  return Number.isInteger(n) && n >= 1 && n <= 65535 && n !== 8080;
}

function cleanImage(input) {
  const image = String(input || '').trim();
  return image === '' || IMAGE_RE.test(image) ? image : null;
}

// The app card that lets people be given the galaxy (and shows it on the homepage).
function card(g) {
  return { id: appId(g.id), name: g.name, tagline: 'Galaxy', description: g.description || 'A galaxy that runs on this server.', url: '', icon: 'orbit' };
}

function target(g) {
  const a = parseAddress(g.address);
  return a ? `http://${a.host}:${a.port}` : '';
}

// One gateway per galaxy, made on demand: it holds no state of its own.
function gatewayFor(g, getDomain, extra = {}) {
  return new Coffee({
    getConfig: () => g,
    getDomain,
    target: target(g),
    prefix: `/${g.id}`,
    open: OPEN,
    name: g.name,
    healthError: `Nothing answered at ${g.address}. Check the container is running and its port matches`,
    ...extra,
  });
}

// What an admin sees: never the secret.
function view(g, domain) {
  const { secret, check, ...rest } = g;
  return { ...rest, secretSaved: Boolean(secret), check: check || null, openUrl: domain && g.enabled ? `https://nova.${domain}/${g.id}/` : '' };
}

// A starting point for ZimaOS → App Store → Custom Install → Import. The
// secret is filled in only the moment it is made.
function compose(g, secret = '') {
  const a = parseAddress(g.address) || { port: 8000 };
  return [
    `# ${g.name}: a galaxy for Roost. On ZimaOS: App Store → Custom Install → Import, and paste this file.`,
    `name: galaxy-${g.id}`,
    'services:',
    `  galaxy-${g.id}:`,
    `    image: ${g.image || 'IMAGE-NAME'}`,
    `    container_name: galaxy-${g.id}`,
    '    restart: unless-stopped',
    '    ports:',
    `      - "${a.port}:${a.port}"`,
    '    environment:',
    `      GALAXY_PORT: "${a.port}"`,
    `      GALAXY_BASE_PATH: /${g.id}`,
    `      ROOST_SSO_SECRET: "${secret || 'PASTE-THE-SHARED-SECRET'}"`,
    '    volumes:',
    `      - /DATA/AppData/galaxy-${g.id}:/data`,
    '',
  ].join('\n');
}

module.exports = { ID_RE, RESERVED, OPEN, MAX, HOST, appId, slug, parseAddress, cleanImage, card, target, gatewayFor, view, compose, validSecret, newSecret };
