'use strict';

// Sentinel's code checker: reads Roost's own files for the mistakes attackers
// actually use (see roost-security/code-checker-plan.md). Plain pattern rules,
// no AI and no outside service. It runs in `npm test`, on every pull request
// (.github/workflows/code-check.yml) and when an admin presses "Check Roost's
// code" under Admin → Security. Never on a timer.
//
// A line that is safe on purpose can say so with `code-check: ok` in a comment.
// A finding is { rule, level, file, line, text, message }: level "bad" is a
// hole to fix, "review" is a place that needs a human look because it widens
// what Roost can reach.

const fs = require('node:fs');
const path = require('node:path');

// Files that already make outbound calls or start programs; a new file doing
// either gets flagged so somebody looks at what it can reach.
const OUTBOUND = new Set(['acme', 'cockerel', 'cloudflare', 'coffee', 'docker', 'docker-helper', 'jellyfin', 'mail', 'portcheck', 'push', 'remote', 'server', 'uptime', 'birdhouse', 'birdhouse-ai', 'immich', 'wireguard', 'updates', 'tls', 'self-update']);
const PROGRAMS = new Set(['convert', 'wireguard']);
const CAPS = new Set(['NET_ADMIN', 'SYS_RAWIO']);
const PORTS = new Set(['8080:8080', '443:8443']);

const ok = (line) => /code-check:\s*ok/.test(line);
const base = (file) => path.basename(file).replace(/\.[^.]+$/, '');

// Each rule: (file, lines) → [{ line, message, level? }]
const lineRule = (re, message, { level = 'bad', where = () => true, skip = () => false } = {}) => (file, lines) => {
  if (!where(file)) return [];
  const out = [];
  lines.forEach((text, i) => { if (re.test(text) && !ok(text) && !skip(text, file)) out.push({ line: i + 1, message, level }); });
  return out;
};

const isSrc = (f) => /^src\/.*\.js$/.test(f);
const isPublic = (f) => /^public\/.*\.(js|html)$/.test(f) && !f.startsWith('public/vendor/');

const RULES = {
  'external-script': lineRule(/<script[^>]+src=["']?(https?:)?\/\//i, 'A script is loaded from another website. If that site is ever hijacked, it runs inside Roost.', { where: isPublic }),
  'script-in-js': lineRule(/\.src\s*=\s*['"`]https?:/, 'A script or frame is loaded from another website.', { where: isPublic }),
  'dynamic-code': lineRule(/\beval\(|new Function\(/, 'eval or new Function runs text as code.', { where: (f) => isSrc(f) || isPublic(f) }),
  'inner-html': lineRule(/\binnerHTML\s*=|insertAdjacentHTML\(/, 'innerHTML with text that could contain a name or file name lets a page run code. Build with elements, or mark the line "code-check: ok" if it is fixed text.', {
    where: isPublic, skip: (t) => /<svg|ICONS\[|(NI|GI|SI)\[/.test(t),
  }),
  'weak-random': lineRule(/Math\.random\(/, 'Math.random is guessable. Use crypto.randomBytes for anything secret.', { where: isSrc }),
  'source-map': lineRule(/sourceMappingURL/, 'A source map would hand out the original code.', { where: (f) => (isSrc(f) && f !== 'src/code-check.js') || isPublic(f) }),
  'secret': lineRule(/-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|sk-ant-[A-Za-z0-9_-]{20,}|xox[bp]-[A-Za-z0-9-]{20,}/, 'This looks like a key or token written into the code.', { where: (f) => isSrc(f) || isPublic(f) || f === 'docker-compose.yml' }),
  // A link built from the Host header can be poisoned by whoever sends the request.
  'host-header': lineRule(/headers(\.host|\[['"]host['"]\])/, 'Built from the Host header, which a visitor controls. Emailed links must use the saved public address.', {
    where: isSrc, skip: (t, f) => ['server', 'coffee'].includes(base(f)) && !/\bhttps?:\/\//.test(t),
  }),
  'path-from-request': lineRule(/path\.(join|resolve)\([^)]*\b(req\.(url|query)|body\.|params\.|searchParams)/, 'A file path is built straight from the request. Clean the name and check it stays inside its folder.', { where: isSrc }),
  'child-process': (file, lines) => {
    if (!isSrc(file) || PROGRAMS.has(base(file))) return [];
    const i = lines.findIndex((t) => /require\(['"](node:)?child_process['"]\)/.test(t) && !ok(t));
    return i < 0 ? [] : [{ line: i + 1, level: 'review', message: 'Starts programs on the server. Check every argument is fixed or checked, and never joined into a shell string.' }];
  },
  'shell-string': lineRule(/(^|[^.\w])(exec|execSync)\(\s*[`'"].*(\$\{|\+)/, 'A shell command is built from text. Use spawn/execFile with an argument list.', { where: isSrc }),
  'new-outbound': (file, lines) => {
    if (!isSrc(file) || OUTBOUND.has(base(file))) return [];
    const i = lines.findIndex((t) => /\bfetch\(|https?\.(request|get)\(|net\.connect\(/.test(t) && !ok(t));
    return i < 0 ? [] : [{ line: i + 1, level: 'review', message: 'Reaches out to another address. If any part of the address comes from a person, it could be pointed at the home network (SSRF). Allowlist the hosts.' }];
  },
};

// Whole-file expectations: things that must stay true.
function mustHold(files) {
  const out = [];
  const add = (rule, file, message, level = 'bad') => out.push({ rule, level, file, line: 1, text: '', message });
  const server = files['src/server.js'];
  if (server !== undefined) {
    if (!server.includes("script-src 'self'")) add('csp', 'src/server.js', "The page policy no longer limits scripts to Roost's own ('self').");
    if (!server.includes("frame-ancestors 'none'")) add('clickjacking', 'src/server.js', 'Pages can be framed by other sites (frame-ancestors none is missing).');
    if (!/X-Frame-Options/.test(server)) add('clickjacking', 'src/server.js', 'X-Frame-Options is missing.');
    if (!/nosniff/.test(server)) add('headers', 'src/server.js', 'X-Content-Type-Options: nosniff is missing.');
    if (!/HttpOnly/.test(server) || !/SameSite=Strict/.test(server)) add('cookie', 'src/server.js', 'The sign-in cookie lost HttpOnly or SameSite=Strict.');
    for (const route of ['POST /api/login', 'POST /api/forgot']) {
      const at = server.indexOf(`'${route}'`);
      if (at < 0 || !/limiter\.allow/.test(server.slice(at, at + 400))) add('rate-limit', 'src/server.js', `${route} lost its rate limit.`);
    }
  }
  const docker = files.Dockerfile;
  if (docker !== undefined && /^\s*(COPY|ADD)\s+\.\s/m.test(docker)) add('image-copy', 'Dockerfile', 'The whole folder is copied into the image (.git, notes and keys would come too). Copy only src, public and releases.');
  const compose = files['docker-compose.yml'];
  if (compose !== undefined) {
    for (const m of compose.matchAll(/^\s*-\s*["']?(\d+:\d+)["']?\s*$/gm)) {
      if (!PORTS.has(m[1]) && /ports:/.test(compose)) {
        const line = compose.slice(0, m.index).split('\n').length;
        out.push({ rule: 'published-port', level: 'review', file: 'docker-compose.yml', line, text: m[1], message: `Port ${m[1]} is opened to the network. Only 8080 and 443 should be.` });
      }
    }
    compose.split('\n').forEach((t, i) => {
      const cap = /^\s*-\s*([A-Z_]+)\s*$/.exec(t);
      const above = compose.split('\n').slice(Math.max(0, i - 3), i).join('\n');
      if (cap && /cap_add:/.test(above) && !CAPS.has(cap[1])) out.push({ rule: 'capability', level: 'review', file: 'docker-compose.yml', line: i + 1, text: cap[1], message: `A container gets the extra power ${cap[1]}.` });
      if (/privileged:\s*true|network_mode:\s*host/.test(t)) out.push({ rule: 'capability', level: 'bad', file: 'docker-compose.yml', line: i + 1, text: t.trim(), message: 'A container is privileged or on the host network.' });
    });
  }
  return out;
}

function check(files) {
  const findings = [];
  for (const [file, text] of Object.entries(files)) {
    const lines = text.split('\n');
    for (const [name, rule] of Object.entries(RULES)) {
      for (const f of rule(file, lines)) findings.push({ rule: name, file, text: (lines[f.line - 1] || '').trim().slice(0, 160), ...f });
    }
  }
  findings.push(...mustHold(files));
  return findings.sort((a, b) => (a.level === b.level ? 0 : a.level === 'bad' ? -1 : 1) || a.file.localeCompare(b.file) || a.line - b.line);
}

// Reads the files that matter from a Roost folder (the repo, or /app in the image).
function readFiles(root) {
  const files = {};
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const r = `${rel}${e.name}`;
      if (e.isDirectory()) { if (e.name !== 'vendor' && e.name !== 'img' && e.name !== 'icons') walk(`${dir}/${e.name}`, `${r}/`); }
      else if (/\.(js|html)$/.test(e.name)) files[r] = fs.readFileSync(path.join(root, dir, e.name), 'utf8');
    }
  };
  walk('src', 'src/');
  walk('public', 'public/');
  for (const f of ['Dockerfile', 'docker-compose.yml']) {
    try { files[f] = fs.readFileSync(path.join(root, f), 'utf8'); } catch { /* not in the image */ }
  }
  return files;
}

function run(root) {
  const findings = check(readFiles(root));
  return {
    at: new Date().toISOString(),
    bad: findings.filter((f) => f.level === 'bad').length,
    review: findings.filter((f) => f.level === 'review').length,
    findings: findings.slice(0, 50),
  };
}

module.exports = { check, readFiles, run, RULES };
