'use strict';

// Roost's updater: its own small container (see docker-compose.yml) that brings
// Roost up to date from GitHub when an admin presses Update in Admin → Updates.
//
// It has no web port. The Roost web app leaves a request ("check" or "apply")
// as a small file in the data folder, and this service answers through a status
// file next to it, the same way the backup service does. Roost itself never
// touches Docker.
//
// What it can do is fixed and short:
//   check   git fetch from GitHub, then count and list what is new
//   apply   fast-forward the code, build the new images, restart Roost and its
//           backup service, wait for Roost to report healthy
// If anything fails, the running version keeps running or is put back: before a
// build nothing running is touched, and after the restart a version that does not
// come up healthy is rolled back to the previous image and code.
//
// Only code from the project's own GitHub repository is ever fetched, and it is
// only fast-forwarded onto the folder it already lives in, so it cannot overwrite
// the compose file's own edits (those make an update stop and say so instead).
//
// No packages: Node, git and the docker command line.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { mergeOverride } = require('./override');

const REQUEST_FILE = 'update-request.json';
const STATUS_FILE = 'update-status.json';
const ACTIONS = new Set(['check', 'apply']);
const DRIVE_REQUEST_FILE = 'nest-drive-request.json';
const DRIVE_STATUS_FILE = 'nest-drive-status.json';
const OVERRIDE_FILE = 'docker-compose.override.yml';
const DRIVE_LOOK_MS = 8000;
const DRIVE_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/;
// The services an update rebuilds and restarts. The others (Docker window,
// drive health, this updater) keep running as they are.
const SERVICES = ['roost', 'roost-backup'];
const PROJECT = 'roost';
const BRANCH = 'main';

const TICK_MS = 5000;
const HEARTBEAT_MS = 5 * 60 * 1000;
const AUTO_CHECK_MS = 12 * 60 * 60 * 1000;
const START_CHECK_MS = 30 * 1000;
const HEALTH_WAIT_MS = 90 * 1000;
const FETCH_TIMEOUT_MS = 90 * 1000;
const BUILD_TIMEOUT_MS = 20 * 60 * 1000;

// Runs a program and gathers what it prints (the last ~16 KB). Never throws:
// → { code, out }; code is null if it could not start or ran out of time.
function run(cmd, args, { cwd, timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, out: out.trim() });
    };
    let child;
    try {
      child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      out = err.message;
      return finish(null);
    }
    const timer = setTimeout(() => {
      out += '\n(took too long and was stopped)';
      child.kill('SIGKILL');
      finish(null);
    }, timeoutMs);
    const take = (c) => { out = (out + c).slice(-16000); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (err) => { out += err.message; finish(null); });
    child.on('close', (code) => finish(code));
  });
}

const tail = (text, lines = 12) => String(text || '').split('\n').slice(-lines).join('\n').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// "roost-roost" or "roost-roost:latest" → "roost-roost"
function repoOf(ref) {
  const i = String(ref).lastIndexOf(':');
  return i > String(ref).lastIndexOf('/') ? ref.slice(0, i) : ref;
}

// A problem with a message for the admin, thrown inside apply().
class Stop extends Error {
  constructor(message, detail = '') {
    super(message);
    this.detail = detail;
  }
}

function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function takeRequest(dataDir) {
  const file = path.join(dataDir, REQUEST_FILE);
  let action = null;
  try {
    action = JSON.parse(fs.readFileSync(file, 'utf8')).action;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
  }
  fs.rmSync(file, { force: true });
  return ACTIONS.has(action) ? action : null;
}

function takeDriveRequest(dataDir) {
  const file = path.join(dataDir, DRIVE_REQUEST_FILE);
  let req = null;
  try {
    req = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
  }
  fs.rmSync(file, { force: true });
  if (!req || (req.action !== 'list' && req.action !== 'move')) return null;
  return { action: req.action, drive: typeof req.drive === 'string' ? req.drive : '' };
}

// Drives plugged into the server: the folders under /media that are their own
// mount (a different device number from /media itself), with free space.
async function listDrives(mediaDir, perDriveMs = DRIVE_LOOK_MS) {
  let rootDev;
  let names;
  try {
    rootDev = (await fs.promises.stat(mediaDir)).dev;
    names = await fs.promises.readdir(mediaDir);
  } catch {
    return [];
  }
  // Looked at one by one without blocking, each with a time limit: a drive that
  // is asleep or a stuck mount must not freeze the whole updater.
  const look = async (name) => {
    const dir = path.join(mediaDir, name);
    const st = await fs.promises.stat(dir);
    if (!st.isDirectory() || st.dev === rootDev) return null;
    const fsStat = await fs.promises.statfs(dir);
    return { name, totalBytes: fsStat.blocks * fsStat.bsize, freeBytes: fsStat.bavail * fsStat.bsize };
  };
  const found = await Promise.all(names.filter((n) => DRIVE_NAME.test(n)).map((name) => Promise.race([
    look(name).catch(() => null),
    new Promise((resolve) => { setTimeout(() => resolve(null), perDriveMs).unref(); }),
  ])));
  return found.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
}

function create({ dataDir, srcDir, exec = run, now = () => Date.now(), wait = sleep, healthWaitMs = HEALTH_WAIT_MS, composeProject = PROJECT, mediaDir = '/hostmedia', mediaHost = '/media', drives = listDrives }) {
  const statusFile = path.join(dataDir, STATUS_FILE);
  let status = { state: 'idle', phase: null, behind: 0, commits: [], dirty: [], last: null };
  try {
    // Keep what the last run said (a failure stays visible until the next try).
    const old = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    status = { ...status, ...old, state: 'idle', phase: null };
  } catch {
    // First run.
  }
  let busy = false;
  let lastWrite = 0;

  function save() {
    status.updatedAt = new Date(now()).toISOString();
    lastWrite = now();
    try {
      writeJson(statusFile, status);
    } catch (err) {
      console.error('Roost updater: could not write its status:', err.message);
    }
  }

  const git = (args, opts) => exec('git', ['-c', 'safe.directory=*', ...args], { cwd: srcDir, ...opts });
  const docker = (args, opts) => exec('docker', args, { cwd: srcDir, ...opts });
  const compose = (args, opts) => docker(['compose', '-p', composeProject, ...args], opts);

  // ----- check: what is new on GitHub -----

  // fetch: false looks again at what is already downloaded, without going to GitHub.
  async function check({ fetch = true } = {}) {
    if (status.state === 'idle') status.state = 'checking';
    status.checkError = null;
    save();
    try {
      if (fetch) {
        const fetched = await git(['fetch', '--quiet', 'origin', BRANCH], { timeoutMs: FETCH_TIMEOUT_MS });
        if (fetched.code !== 0) {
          status.checkError = `Couldn't reach GitHub: ${tail(fetched.out, 3) || 'no answer'}`;
          return;
        }
      }
      const head = await git(['log', '-1', '--format=%H%x09%h%x09%cI%x09%s']);
      if (head.code !== 0) throw new Error(`This folder isn't a git copy of Roost (${tail(head.out, 2)})`);
      const [full, short, date, ...subject] = head.out.split('\t');
      status.head = { sha: full, short, date, subject: subject.join('\t') };
      const count = async (range) => Number((await git(['rev-list', '--count', range])).out) || 0;
      status.behind = await count(`HEAD..origin/${BRANCH}`);
      status.ahead = await count(`origin/${BRANCH}..HEAD`);
      const log = await git(['log', '-n', '15', '--format=%h%x09%s', `HEAD..origin/${BRANCH}`]);
      status.commits = log.out ? log.out.split('\n').map((l) => { const [sha, ...s] = l.split('\t'); return { sha, subject: s.join('\t') }; }) : [];
      const changed = status.behind ? (await git(['diff', '--name-only', 'HEAD', `origin/${BRANCH}`])).out.split('\n').filter(Boolean) : [];
      status.composeChanged = changed.includes('docker-compose.yml');
      status.updaterChanged = changed.some((f) => f.startsWith('updater/'));
      // Edits made by hand to files this update also changes: those stop it.
      const dirty = (await git(['diff', '--name-only', 'HEAD'])).out.split('\n').filter(Boolean);
      status.dirty = dirty;
      status.conflicts = dirty.filter((f) => changed.includes(f));
      status.checkedAt = new Date(now()).toISOString();
    } catch (err) {
      status.checkError = err.message;
    } finally {
      if (status.state === 'checking') status.state = 'idle';
      save();
    }
  }

  // ----- apply: update, with a way back -----

  async function healthy(container) {
    const r = await docker(['inspect', '-f', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}', container]);
    return r.out;
  }

  async function waitHealthy(container) {
    const until = now() + healthWaitMs;
    let seen = '';
    do {
      seen = await healthy(container);
      if (seen === 'healthy' || seen === 'running') return { ok: true };
      if (seen === 'unhealthy' || seen === 'exited' || seen === 'dead') break;
      await wait(3000);
    } while (now() < until);
    return { ok: false, seen };
  }

  const phase = (name) => { status.phase = name; save(); };

  async function apply() {
    status.state = 'applying';
    phase('checking');
    const result = { at: new Date(now()).toISOString() };
    const tagged = []; // [{ repo, previousId }] for rolling back
    let from = null;
    let moved = false;
    try {
      // A backup that is half done would be cut off by the restart.
      try {
        const b = JSON.parse(fs.readFileSync(path.join(dataDir, 'backup-status.json'), 'utf8'));
        if (b.running && now() - Date.parse(b.updatedAt) < 15 * 60 * 1000) throw new Stop('A backup is running. Try again when it has finished.');
      } catch (err) {
        if (err instanceof Stop) throw err;
      }

      await check();
      if (status.checkError) throw new Stop(status.checkError);
      if (!status.behind) {
        result.ok = true;
        result.nothing = true;
        status.last = result;
        return;
      }
      if (status.ahead) throw new Stop("This folder has changes of its own that aren't on GitHub, so it can't be updated by itself.");
      if (status.conflicts.length) {
        throw new Stop(`You changed ${status.conflicts.join(', ')} here, and this update changes it too. Keep your own settings in docker-compose.override.yml instead (see the README), then try again.`);
      }
      // Roost has to have been started from this folder's compose file, or the
      // restart would clash with the copy that is already running.
      const owner = await docker(['inspect', '-f', '{{index .Config.Labels "com.docker.compose.project"}}', 'roost']);
      if (owner.code !== 0) throw new Stop("Couldn't find the running Roost container.", tail(owner.out));
      if (owner.out !== composeProject) {
        throw new Stop(`Roost was started some other way (compose project “${owner.out || 'none'}”), so this updater can't restart it safely. Redeploy once with "docker compose up -d --build" in the Roost folder, then updating from here works.`);
      }
      from = status.head.sha;

      phase('merge');
      const merged = await git(['merge', '--ff-only', `origin/${BRANCH}`]);
      if (merged.code !== 0) throw new Stop("Couldn't bring in the new code.", tail(merged.out));
      moved = true;

      // Keep the running images around under a second name, to go back to.
      for (const service of SERVICES) {
        const ref = (await docker(['inspect', '-f', '{{.Config.Image}}', service])).out;
        if (!ref) continue;
        const repo = repoOf(ref);
        const oldPrevious = (await docker(['image', 'inspect', '-f', '{{.Id}}', `${repo}:previous`])).out;
        if ((await docker(['tag', ref, `${repo}:previous`])).code === 0) tagged.push({ repo, oldPrevious });
      }

      phase('build');
      const built = await compose(['build', ...SERVICES], { timeoutMs: BUILD_TIMEOUT_MS });
      if (built.code !== 0) throw new Stop("The new version didn't build, so nothing was changed. Roost is still running the old one.", tail(built.out));

      phase('restart');
      const up = await compose(['up', '-d', '--no-deps', ...SERVICES], { timeoutMs: BUILD_TIMEOUT_MS });
      if (up.code !== 0) throw new Stop("Roost couldn't be restarted on the new version.", tail(up.out));

      phase('health');
      const ok = await waitHealthy('roost');
      if (!ok.ok) {
        const logs = await docker(['logs', '--tail', '15', 'roost']);
        throw new Stop(`The new version didn't start properly (${ok.seen || 'no answer'}).`, tail(logs.out));
      }

      // Done: forget the images from two versions ago.
      for (const t of tagged) {
        if (t.oldPrevious) await docker(['rmi', t.oldPrevious]);
      }
      result.ok = true;
      result.from = from;
      result.to = (await git(['rev-parse', 'HEAD'])).out;
      result.count = status.behind;
      result.needsRedeploy = Boolean(status.composeChanged || status.updaterChanged);
      status.last = result;
    } catch (err) {
      if (!(err instanceof Stop)) err = new Stop(`Something went wrong: ${err.message}`);
      result.ok = false;
      result.error = err.message;
      result.detail = err.detail;
      // Put the old version back if the new one had been started (or even
      // half-started), and the code folder back where it was.
      if (moved) {
        phase('rollback');
        result.rolledBack = await rollBack(from, tagged);
      }
      status.last = result;
    } finally {
      result.finishedAt = new Date(now()).toISOString();
      status.state = 'idle';
      status.phase = null;
      save();
      // What is new, relative to where the folder ended up.
      await check({ fetch: false });
    }
  }

  async function rollBack(from, tagged) {
    // --keep never discards edits made by hand.
    await git(['reset', '--keep', from]);
    for (const t of tagged) await docker(['tag', `${t.repo}:previous`, `${t.repo}:latest`]);
    const up = await compose(['up', '-d', '--no-deps', '--no-build', ...SERVICES], { timeoutMs: BUILD_TIMEOUT_MS });
    if (up.code !== 0) return false;
    return (await waitHealthy('roost')).ok;
  }


  // ----- Nest's drive: which drive Nest and Glint keep their files on -----

  const driveFile = path.join(dataDir, DRIVE_STATUS_FILE);
  let driveStatus = { last: null };
  try {
    driveStatus = { ...driveStatus, ...JSON.parse(fs.readFileSync(driveFile, 'utf8')) };
  } catch {
    // First run.
  }
  const saveDrive = () => {
    driveStatus.updatedAt = new Date(now()).toISOString();
    try {
      writeJson(driveFile, driveStatus);
    } catch (err) {
      console.error('Roost updater: could not write the drive status:', err.message);
    }
  };

  // Where /nest comes from on the host right now.
  async function nestSource() {
    const r = await docker(['inspect', '-f', '{{json .Mounts}}', 'roost']);
    try {
      const m = JSON.parse(r.out).find((x) => x.Destination === '/nest');
      return m ? m.Source : null;
    } catch {
      return null;
    }
  }

  async function refreshDrives() {
    try {
      driveStatus.drives = await drives(mediaDir);
      driveStatus.mediaSeen = fs.existsSync(mediaDir);
      driveStatus.current = await nestSource();
      driveStatus.error = null;
    } catch (err) {
      // Say so in the status, so Roost shows a problem instead of waiting for ever.
      driveStatus.error = err.message;
      console.error('Roost updater: could not look at the drives:', err.message);
    }
    saveDrive();
  }

  // Nest is empty (Roost checked before asking), so nothing is copied: the
  // mounts are pointed at a new folder on the chosen drive and Roost restarts.
  async function moveNest(name) {
    const result = { at: new Date(now()).toISOString(), drive: name };
    driveStatus.state = 'moving';
    saveDrive();
    const overrideFile = path.join(srcDir, OVERRIDE_FILE);
    let before = null;
    let wrote = false;
    try {
      try {
        const b = JSON.parse(fs.readFileSync(path.join(dataDir, 'backup-status.json'), 'utf8'));
        if (b.running && now() - Date.parse(b.updatedAt) < 15 * 60 * 1000) throw new Stop('A backup is running. Try again when it has finished.');
      } catch (err) {
        if (err instanceof Stop) throw err;
      }
      if (!DRIVE_NAME.test(name)) throw new Stop("That isn't a drive name.");
      driveStatus.drives = await drives(mediaDir);
      const drive = driveStatus.drives.find((d) => d.name === name);
      if (!drive) throw new Stop(`Couldn't find a drive called “${name}” plugged into the server.`);
      const owner = await docker(['inspect', '-f', '{{index .Config.Labels "com.docker.compose.project"}}', 'roost']);
      if (owner.code !== 0 || owner.out !== composeProject) throw new Stop("Roost wasn't started from this folder's compose file, so it can't be moved safely from here.", tail(owner.out));
      const hostDrive = path.posix.join(mediaHost, name);
      const hostNest = path.posix.join(hostDrive, 'roost-nest');
      driveStatus.current = await nestSource();
      if (driveStatus.current === hostNest) throw new Stop('Nest is already on that drive.');

      phase2('folder');
      fs.mkdirSync(path.join(mediaDir, name, 'roost-nest'), { recursive: true });
      try {
        before = fs.readFileSync(overrideFile, 'utf8');
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      phase2('settings');
      let merged;
      try {
        merged = mergeOverride(before, hostDrive, hostNest);
      } catch (err) {
        throw new Stop(err.message);
      }
      fs.writeFileSync(overrideFile, merged);
      wrote = true;
      const cfg = await compose(['config', '-q']);
      if (cfg.code !== 0) throw new Stop("The new settings didn't pass Docker's check, so nothing was changed.", tail(cfg.out));

      phase2('restart');
      const up = await compose(['up', '-d', '--no-deps', ...SERVICES], { timeoutMs: BUILD_TIMEOUT_MS });
      if (up.code !== 0) throw new Stop("Roost couldn't be restarted with Nest on that drive.", tail(up.out));
      phase2('health');
      const ok = await waitHealthy('roost');
      if (!ok.ok) throw new Stop(`Roost didn't start properly on the new drive (${ok.seen || 'no answer'}).`, tail((await docker(['logs', '--tail', '15', 'roost'])).out));
      if ((await nestSource()) !== hostNest) throw new Stop("Roost started, but Nest isn't on the new drive.");
      result.ok = true;
      result.to = hostNest;
    } catch (err) {
      const stop = err instanceof Stop ? err : new Stop(`Something went wrong: ${err.message}`);
      result.ok = false;
      result.error = stop.message;
      result.detail = stop.detail;
      if (wrote) {
        phase2('rollback');
        if (before === null) fs.rmSync(overrideFile, { force: true });
        else fs.writeFileSync(overrideFile, before);
        const up = await compose(['up', '-d', '--no-deps', '--no-build', ...SERVICES], { timeoutMs: BUILD_TIMEOUT_MS });
        result.rolledBack = up.code === 0 && (await waitHealthy('roost')).ok;
      }
    } finally {
      result.finishedAt = new Date(now()).toISOString();
      driveStatus.last = result;
      driveStatus.state = 'idle';
      driveStatus.phase = null;
      driveStatus.current = await nestSource();
      driveStatus.drives = await drives(mediaDir);
      saveDrive();
    }
  }
  function phase2(name) {
    driveStatus.phase = name;
    saveDrive();
  }

  // ----- the loop -----

  let nextAuto = now() + START_CHECK_MS;
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const driveRequest = takeDriveRequest(dataDir);
      if (driveRequest) {
        if (driveRequest.action === 'move') await moveNest(driveRequest.drive);
        else await refreshDrives();
        return;
      }
      const request = takeRequest(dataDir);
      if (request === 'apply') {
        await apply();
        nextAuto = now() + AUTO_CHECK_MS;
      } else if (request === 'check' || now() >= nextAuto) {
        await check();
        nextAuto = now() + AUTO_CHECK_MS;
      } else if (now() - lastWrite >= HEARTBEAT_MS) {
        // Tells Roost the updater is alive.
        save();
      }
    } finally {
      busy = false;
    }
  }

  save();
  refreshDrives().catch(() => {});
  return { tick, check, apply, status: () => status };
}

if (require.main === module) {
  const dataDir = process.env.DATA_DIR || '/data';
  const srcDir = process.env.SRC_DIR || '/src';
  const updater = create({ dataDir, srcDir });
  setInterval(() => updater.tick().catch((err) => console.error('Roost updater:', err)), TICK_MS);
  console.log(`Roost updater: watching ${srcDir} for new versions of Roost`);
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => process.exit(0));
}

module.exports = { create, run, repoOf, takeRequest, takeDriveRequest, listDrives, DRIVE_REQUEST_FILE, DRIVE_STATUS_FILE, REQUEST_FILE, STATUS_FILE, SERVICES };
