'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'update-roost.sh');
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();

// A GitHub stand-in, a server copy, and a pretend `docker` first in the PATH.
function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-script-'));
  const work = path.join(root, 'work');
  const origin = path.join(root, 'origin.git');
  const dir = path.join(root, 'srv', 'roost-src');
  const bin = path.join(root, 'bin');
  const state = path.join(root, 'state');
  for (const d of [work, bin, state, path.join(root, 'srv')]) fs.mkdirSync(d, { recursive: true });
  git(work, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(work, 'docker-compose.yml'), 'name: roost\nservices: {}\n');
  fs.writeFileSync(path.join(work, 'app.js'), 'one\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'First version');
  git(root, 'clone', '-q', '--bare', work, origin);
  git(root, 'clone', '-q', origin, dir);
  const publish = (file, text, message) => {
    fs.writeFileSync(path.join(work, file), text);
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', message);
    git(work, 'push', '-q', origin, 'main');
  };
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/bash
echo "$*" >> "${state}/calls"
case "$1" in
  info) exit 0 ;;
  tag|rmi) exit 0 ;;
  logs) echo "Error: Cannot find module"; exit 0 ;;
  inspect)
    case "$*" in
      *com.docker.compose.project*) echo "\${FAKE_PROJECT:-roost}" ;;
      *Config.Image*) echo "roost-$4" ;;
      *Health*) if [ -e "${state}/bad" ] && [ ! -e "${state}/back" ]; then echo unhealthy; else echo healthy; fi ;;
    esac ;;
  compose)
    case "$*" in
      *" build"*) [ -e "${state}/nobuild" ] && exit 1 ;;
      *--no-build*) touch "${state}/back" ;;
    esac ;;
esac
exit 0
`, { mode: 0o755 });
  const run = (args = [], env = {}) => spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ROOST_REPO: origin, ROOST_SLEEP: '0', ROOST_HEALTH_WAIT: '3', ...env },
  });
  const calls = () => (fs.existsSync(path.join(state, 'calls')) ? fs.readFileSync(path.join(state, 'calls'), 'utf8').split('\n').filter(Boolean) : []);
  return { root, dir, origin, state, publish, run, calls, git: (...a) => git(dir, ...a), done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('--check lists what is new and changes nothing', () => {
  const w = world();
  try {
    w.publish('app.js', 'two\n', 'Second version');
    const before = w.git('rev-parse', 'HEAD');
    const r = w.run([w.dir, '--check']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /1 change\(s\) waiting/);
    assert.match(r.stdout, /Second version/);
    assert.equal(w.git('rev-parse', 'HEAD'), before);
    assert.equal(w.calls().some((c) => c.startsWith('compose')), false);
  } finally { w.done(); }
});

test('an update brings in the code, rebuilds, restarts and waits for health', () => {
  const w = world();
  try {
    w.publish('app.js', 'two\n', 'Second version');
    const r = w.run([w.dir, '-y']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Done\. Roost is running/);
    assert.equal(fs.readFileSync(path.join(w.dir, 'app.js'), 'utf8'), 'two\n');
    const compose = w.calls().filter((c) => c.startsWith('compose'));
    assert.deepEqual(compose, ['compose -p roost build', 'compose -p roost up -d']);
    assert.ok(w.calls().includes('tag roost-roost roost-roost:previous'));
  } finally { w.done(); }
});

test('without -y it asks, and with no answer it changes nothing', () => {
  const w = world();
  try {
    w.publish('app.js', 'two\n', 'Second version');
    const r = w.run([w.dir]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Update now\?/);
    assert.equal(fs.readFileSync(path.join(w.dir, 'app.js'), 'utf8'), 'one\n');
    assert.equal(w.calls().some((c) => c.startsWith('compose')), false);
  } finally { w.done(); }
});

test('edits you made by hand are kept, and saved as a patch', () => {
  const w = world();
  try {
    fs.writeFileSync(path.join(w.dir, 'docker-compose.yml'), 'name: roost\nservices: {}\n# my drive folders\n');
    w.publish('app.js', 'two\n', 'Second version');
    const r = w.run([w.dir, '-y']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(fs.readFileSync(path.join(w.dir, 'docker-compose.yml'), 'utf8'), /my drive folders/);
    assert.equal(fs.readFileSync(path.join(w.dir, 'app.js'), 'utf8'), 'two\n');
    const patches = fs.readdirSync(path.dirname(w.dir)).filter((f) => f.startsWith('roost-local-changes-'));
    assert.equal(patches.length, 1);
    assert.match(fs.readFileSync(path.join(path.dirname(w.dir), patches[0]), 'utf8'), /my drive folders/);
  } finally { w.done(); }
});

test('an edit that clashes with the update stops it and leaves everything as it was', () => {
  const w = world();
  try {
    const mine = 'name: roost\nservices: {}\n# my drive folders\n';
    fs.writeFileSync(path.join(w.dir, 'docker-compose.yml'), mine);
    w.publish('docker-compose.yml', 'name: roost\nservices: {}\n# theirs\n', 'Change the compose file');
    const before = w.git('rev-parse', 'HEAD');
    const r = w.run([w.dir, '-y']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /docker-compose\.override\.yml/);
    assert.equal(w.git('rev-parse', 'HEAD'), before);
    assert.equal(fs.readFileSync(path.join(w.dir, 'docker-compose.yml'), 'utf8'), mine);
    assert.equal(w.calls().some((c) => c.startsWith('compose')), false);
  } finally { w.done(); }
});

test('a version that will not build changes nothing', () => {
  const w = world();
  try {
    fs.writeFileSync(path.join(w.state, 'nobuild'), '');
    w.publish('app.js', 'two\n', 'Broken version');
    const before = w.git('rev-parse', 'HEAD');
    const r = w.run([w.dir, '-y']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /didn't build/);
    assert.equal(w.git('rev-parse', 'HEAD'), before);
    assert.equal(fs.readFileSync(path.join(w.dir, 'app.js'), 'utf8'), 'one\n');
    assert.equal(w.calls().some((c) => c.startsWith('compose -p roost up')), false);
  } finally { w.done(); }
});

test('a version that starts unhealthy is rolled back, with its log shown', () => {
  const w = world();
  try {
    fs.writeFileSync(path.join(w.state, 'bad'), '');
    w.publish('app.js', 'two\n', 'Crashing version');
    const before = w.git('rev-parse', 'HEAD');
    const r = w.run([w.dir, '-y']);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /Cannot find module/);
    assert.match(r.stderr, /old one was put back/);
    assert.equal(w.git('rev-parse', 'HEAD'), before);
    assert.ok(w.calls().includes('tag roost-roost:previous roost-roost:latest'));
    assert.ok(w.calls().includes('compose -p roost up -d --no-build'));
  } finally { w.done(); }
});

test('it refuses a folder that is not a git copy, and a Roost started some other way', () => {
  const w = world();
  try {
    const plain = path.join(w.root, 'plain');
    fs.mkdirSync(plain);
    fs.writeFileSync(path.join(plain, 'docker-compose.yml'), 'name: roost\n');
    const r = w.run([plain, '-y']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /isn't a git copy/);
    assert.equal(fs.existsSync(path.join(plain, '.git')), false);

    const other = w.run([w.dir, '-y'], { FAKE_PROJECT: 'zimaos-roost' });
    assert.equal(other.status, 1);
    assert.match(other.stderr, /imported through ZimaOS/);
    assert.equal(w.calls().some((c) => c.startsWith('compose')), false);
  } finally { w.done(); }
});

test('with no folder yet it downloads Roost first, and points the updater at it', () => {
  const w = world();
  try {
    const fresh = path.join(w.root, 'fresh', 'roost-src');
    const r = w.run([fresh, '-y']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(fs.existsSync(path.join(fresh, '.git')));
    // Not at the default folder, so Admin → Updates is told where this one is.
    const override = fs.readFileSync(path.join(fresh, 'docker-compose.override.yml'), 'utf8');
    assert.match(override, new RegExp(`${fresh.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:/src`));
  } finally { w.done(); }
});
