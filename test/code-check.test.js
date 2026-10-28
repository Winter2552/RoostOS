'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { check, run } = require('../src/code-check');
const { securityChecks } = require('../src/security');

const rules = (files) => check(files).map((f) => f.rule);

test('a wrong username takes as long to refuse as a wrong password', () => {
  const { verifyAgainstNobody } = require('../src/auth');
  assert.equal(verifyAgainstNobody('anything'), false);
});

test("Roost's own code passes its own check", () => {
  const out = run(path.join(__dirname, '..'));
  assert.deepEqual(out.findings.filter((f) => f.level === 'bad'), [], 'fix these, or mark a safe line "code-check: ok"');
  assert.deepEqual(out.findings.filter((f) => f.level === 'review'), [], 'a new door was opened: look at it, then allow it in src/code-check.js');
});

test('each rule fires on a bad example and stays quiet when marked ok', () => {
  const bad = {
    'public/a.js': 'el.innerHTML = `<b>${name}</b>`;\ns.src = "https://cdn.evil.example/x.js";\neval(x);',
    'public/index.html': '<script src="https://cdn.polyfill.io/v3/polyfill.js"></script>',
    'src/x.js': "const t = Math.random();\nconst p = path.join(dir, req.url);\nexec(`ls ${dir}`);\nconst h = req.headers.host;\nconst k = 'ghp_" + 'a'.repeat(36) + "';\n//# sourceMappingURL=x.map",
    'src/spawny.js': "const cp = require('child_process');",
    'src/newnet.js': 'await fetch(url);',
  };
  const got = new Set(rules(bad));
  for (const r of ['inner-html', 'script-in-js', 'dynamic-code', 'external-script', 'weak-random', 'path-from-request', 'shell-string', 'host-header', 'secret', 'source-map', 'child-process', 'new-outbound']) assert.ok(got.has(r), r);
  assert.deepEqual(rules({ 'public/a.js': 'el.innerHTML = `<b>${name}</b>`; // code-check: ok', 'src/x.js': 'const t = Math.random(); // code-check: ok' }), []);
  assert.deepEqual(rules({ 'src/x.js': 'db.exec(`VACUUM INTO ${x}`);', 'public/a.js': 'span.innerHTML = `<svg>${ICONS[n]}</svg>`;' }), []);
});

test('required protections cannot be quietly removed', () => {
  const weak = rules({ 'src/server.js': "'POST /api/login': async () => {}", Dockerfile: 'COPY . .\n' });
  for (const r of ['csp', 'clickjacking', 'headers', 'cookie', 'rate-limit', 'image-copy']) assert.ok(weak.includes(r), r);
  const open = check({ 'docker-compose.yml': 'services:\n  a:\n    privileged: true\n    ports:\n      - "2375:2375"\n    cap_add:\n      - SYS_ADMIN\n' }).map((f) => f.rule);
  for (const r of ['capability', 'published-port']) assert.ok(open.includes(r), r);
});

test('the security checklist reports the code check', () => {
  const db = { users: [], settings: {} };
  const row = (codeCheck) => securityChecks({ db, codeCheck }).checks.find((c) => c.id === 'code');
  assert.equal(row(null).status, 'info');
  const at = new Date().toISOString();
  assert.equal(row({ at, bad: 0, review: 0, findings: [] }).status, 'ok');
  assert.equal(row({ at, bad: 0, review: 1, findings: [{ file: 'a', line: 1, message: 'm' }] }).status, 'warn');
  assert.equal(row({ at, bad: 1, review: 0, findings: [{ file: 'a', line: 1, message: 'm' }] }).status, 'bad');
});
