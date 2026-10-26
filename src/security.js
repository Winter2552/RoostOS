'use strict';

// Security: a per-account sign-in guard, alerts for sign-in events that matter,
// and the checklist behind Admin → Security. Nothing here runs on a timer; the
// guard and the alerts react to sign-ins as they happen, and the checklist is
// worked out from state Roost already keeps when an admin opens the page.

const DAY_MS = 24 * 60 * 60 * 1000;

// Addresses on the home network, which the account guard never locks out.
function isPrivateIp(ip) {
  const a = String(ip || '').replace(/^::ffff:/i, '').toLowerCase();
  if (a === '::1' || a.startsWith('fe80:') || /^f[cd][0-9a-f]{2}:/.test(a)) return true;
  const m = a.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (!m) return false;
  const [x, y] = [Number(m[1]), Number(m[2])];
  return x === 10 || x === 127 || (x === 192 && y === 168) || (x === 172 && y >= 16 && y <= 31);
}

// Slows password guessing that is spread over many addresses, which the per-address
// limiter can't see. Too many failures on one account pause sign-in to it from
// outside the home network; on the home network's plain address it never locks,
// so the owner can't be shut out.
class AccountGuard {
  constructor({ max = 8, windowMs = 10 * 60 * 1000, now = Date.now } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
    this.hits = new Map();
  }

  recent(name) {
    const t = this.now();
    const list = (this.hits.get(name) || []).filter((at) => t - at < this.windowMs);
    if (list.length) this.hits.set(name, list);
    else this.hits.delete(name);
    return list;
  }

  // `encrypted`: the request came in over HTTPS, which is the only way in from
  // outside (the router forwards 443 only). A home address on plain HTTP is the
  // one safe exemption; over HTTPS a home-looking address may just be a router.
  allow(name, ip, encrypted = false) {
    return (!encrypted && isPrivateIp(ip)) || this.recent(name).length < this.max;
  }

  fail(name) {
    // Typed names that match no account are counted too, so a lockout doesn't
    // reveal which accounts exist; the map is capped against junk names.
    if (!this.hits.has(name) && this.hits.size >= 2000) this.hits.delete(this.hits.keys().next().value);
    this.hits.set(name, [...this.recent(name), this.now()]);
  }

  clear(name) {
    this.hits.delete(name);
  }
}

// Turns sign-in events into alerts on the same bell and phone push as problems
// with apps and drives. They stay on the bell until an admin ignores them or a
// day passes (src/alerts.js tidies them), and are marked `security` so the
// app and drive watcher doesn't treat them as its own.
class SecurityWatch {
  constructor({ store, push, newId, now = Date.now, failedAlertAt = 5, failedWindowMs = 10 * 60 * 1000 }) {
    this.store = store;
    this.push = push;
    this.newId = newId;
    this.now = now;
    this.failedAlertAt = failedAlertAt;
    this.failedWindowMs = failedWindowMs;
    this.failed = new Map();
  }

  enabled() {
    return (this.store.db.settings || {}).alertSecurity !== false;
  }

  alerts() {
    if (!Array.isArray(this.store.db.alerts)) this.store.db.alerts = [];
    return this.store.db.alerts;
  }

  // One alert per key while it is open: a repeat updates the detail, no second push.
  raise(key, title, detail) {
    if (!this.enabled()) return;
    const alerts = this.alerts();
    const open = alerts.find((a) => a.key === key && !a.resolvedAt);
    if (open) {
      if (open.detail !== detail) {
        open.detail = detail;
        this.store.save();
      }
      return;
    }
    const alert = { id: this.newId(), key, title, detail, security: true, url: '/#/admin', startedAt: new Date(this.now()).toISOString(), resolvedAt: null };
    alerts.push(alert);
    this.store.save();
    this.push.alert('raised', alert);
  }

  failedSignIn(username) {
    const t = this.now();
    const list = [...(this.failed.get(username) || []).filter((at) => t - at < this.failedWindowMs), t];
    this.failed.set(username, list);
    if (this.failed.size > 500) this.failed.delete(this.failed.keys().next().value);
    if (list.length >= this.failedAlertAt) {
      this.raise(`sec:failed:${username}`, `${list.length} failed sign-ins for ${username}`, 'Someone may be guessing the password. Two-step sign-in is still stopping them.');
    }
  }

  // Admin signing in from a browser or phone Roost hasn't seen them use. The
  // first device is remembered quietly. → true when the list changed (save it).
  adminDevice(user, label, ip) {
    if (user.role !== 'admin' || !label) return false;
    const seen = Array.isArray(user.seenDevices) ? user.seenDevices : (user.seenDevices = []);
    if (seen.includes(label)) return false;
    seen.push(label);
    if (seen.length > 20) seen.shift();
    if (seen.length > 1) this.raise(`sec:device:${user.id}:${label}`, `${user.username} signed in on a new device`, [label, ip].filter(Boolean).join(' · '));
    return true;
  }

  // Changes that matter if they weren't you: an admin's password or two-step,
  // or a new admin.
  onActivity(type, { actor, target, detail } = {}) {
    const users = this.store.db.users;
    const subject = users.find((u) => u.username === (target || actor));
    const isAdmin = subject && subject.role === 'admin';
    const id = this.newId();
    if (type === 'sign-in-failed' && target && !/^guest/.test(detail || '')) {
      this.failedSignIn(target);
    } else if (type === 'password-changed' && isAdmin) {
      this.raise(`sec:change:${id}`, `${subject.username}'s password was changed`, 'If this was not you, sign in and change it again.');
    } else if (type === 'password-reset' && isAdmin) {
      this.raise(`sec:change:${id}`, `${subject.username}'s password was reset with a link`, 'If this was not you, sign in and change it.');
    } else if (type === 'two-step-off' && isAdmin) {
      this.raise(`sec:change:${id}`, `Two-step sign-in was turned off for ${subject.username}`, 'If this was not you, turn it back on.');
    } else if (type === 'user-added' && /^admin\b/.test(detail || '')) {
      this.raise(`sec:change:${id}`, `A new admin was added: ${target}`, `Added by ${actor || 'someone'}.`);
    } else if (type === 'user-changed' && /→ admin/.test(detail || '')) {
      this.raise(`sec:change:${id}`, `${target} was made an admin`, `Changed by ${actor || 'someone'}.`);
    }
  }

  // Security alerts fade after a day, whether or not anyone ignored them.
  tidy(t = this.now()) {
    let changed = false;
    for (const a of this.alerts()) {
      if (a.security && !a.resolvedAt && t - Date.parse(a.startedAt) > DAY_MS) {
        a.resolvedAt = new Date(t).toISOString();
        changed = true;
      }
    }
    return changed;
  }
}

const order = { ok: 0, info: 0, warn: 1, bad: 2 };

// The Admin → Security list. Every check is { id, status: ok|info|warn|bad,
// title, detail }; `info` is a fact with nothing to do about it.
//   db, now, entries (activity log), cert (certSummary() or null), updates
//   ({ update, restart, checked } or null), backup (backup.summarize()),
//   pushDevices (phones with alerts on, for admins), outside (reachable from outside),
//   lockdown ({ at, by } while outside access is paused),
//   ports (the last open-port check, src/portcheck.js, or null),
//   backupTest (the backup service's last restore test, or null)
function securityChecks({ db, now = Date.now(), entries = [], cert = null, updates = null, backup = { state: 'off' }, pushDevices = 0, outside = false, lockdown = null, ports = null, backupTest = null }) {
  const checks = [];
  const add = (id, status, title, detail = '') => checks.push({ id, status, title, detail });
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  if (lockdown) add('lockdown', 'warn', 'Outside access is paused (lockdown)', 'Everyone is signed out and Roost only answers at home. Lift it below when you are ready.');

  const admins = db.users.filter((u) => u.role === 'admin');
  const bare = admins.filter((u) => !u.twoStep);
  if (db.settings.adminsNeedTwoStep === false) {
    add('admin-two-step', 'warn', 'Admins can skip two-step sign-in', 'Turn the requirement back on in Admin → Users.');
  } else if (bare.length) {
    add('admin-two-step', 'bad', `${plural(bare.length, 'admin has', 'admins have')} no two-step sign-in`, bare.map((u) => u.username).join(', '));
  } else {
    add('admin-two-step', 'ok', 'Every admin uses two-step sign-in');
  }

  const others = db.users.filter((u) => u.role !== 'admin' && u.role !== 'guest' && !u.twoStep);
  if (outside && others.length) {
    add('member-two-step', 'warn', `${plural(others.length, 'person signs', 'people sign')} in with only a password`, 'Roost is reachable from outside. Ask them to turn on two-step in their Profile.');
  }

  if (cert) {
    const days = cert.daysLeft;
    if (cert.state === 'error' || (days !== null && days < 14)) add('https', 'bad', 'The HTTPS certificate needs attention', cert.error || `${days} days left`);
    else if (days !== null && days < 30) add('https', 'warn', 'The HTTPS certificate expires soon', `${days} days left; it renews by itself`);
    else add('https', 'ok', 'Outside connections are encrypted', days === null ? '' : `Certificate good for ${days} more days`);
  }

  if (updates && updates.checked) {
    const waiting = updates.update + updates.restart;
    if (waiting) add('updates', 'warn', `${plural(waiting, 'app has', 'apps have')} an update waiting`, 'Old versions are how most home servers get hacked. Update in ZimaOS or Admin → Updates.');
    else add('updates', 'ok', 'Apps are up to date', 'As of the last check');
  } else {
    add('updates', 'info', 'Updates not checked yet', 'Open the Status page to check.');
  }

  if (backup.state === 'ok' || backup.state === 'running') add('backup', 'ok', 'Nightly backup is working');
  else if (backup.state === 'off') add('backup', 'warn', 'Backups are not running', 'A backup on a separate drive is the best protection against ransomware. See Admin → Setup.');
  else add('backup', 'warn', 'Backups need attention', backup.message || { late: 'The last good backup is more than a day old.', none: 'No backup has finished yet.', stopped: 'The backup service has stopped.' }[backup.state] || '');

  if (backupTest) {
    if (backupTest.ok) add('backup-test', 'ok', 'A test restore of your backup worked', `${backupTest.checked} random files read back and checked, ${new Date(backupTest.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}.`);
    else add('backup-test', 'bad', 'Your backup failed its test restore', backupTest.bad.length ? `Damaged or missing: ${backupTest.bad.join(', ')}` : backupTest.error || 'Files could not be read back.');
  } else if (backup.state === 'ok') {
    add('backup-test', 'info', 'Backup test restore not run yet', 'The backup service tests a few random files about once a month.');
  }

  const failed = entries.filter((e) => e.type === 'sign-in-failed' && now - Date.parse(e.at) < DAY_MS);
  if (failed.length >= 50) add('failed', 'bad', `${failed.length} failed sign-ins in the last day`, 'Somebody is hammering the sign-in page.');
  else if (failed.length >= 5) add('failed', 'warn', `${failed.length} failed sign-ins in the last day`, 'Look at Admin → Activity → Failed.');
  else add('failed', 'ok', 'No sign-in trouble in the last day');

  if (!pushDevices) add('phone', 'warn', 'No phone gets Roost alerts', 'Turn on Admin → Alerts on your phone to hear about problems straight away.');
  else add('phone', 'ok', 'Alerts reach your phone');

  if (ports) {
    const extra = ports.open.filter((p) => p.port !== 443);
    const when = new Date(ports.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    if (extra.length) add('ports', 'bad', `${extra.length === 1 ? 'A door is' : `${extra.length} doors are`} open to the internet besides 443`, `${extra.map((p) => `${p.port} (${p.name})`).join(', ')}. Close ${extra.length === 1 ? 'it' : 'them'} in your router's port forwarding unless you meant it. Checked ${when}.`);
    else add('ports', 'ok', 'No unexpected doors open to the internet', `Tried ${ports.tried} common ports on ${ports.ip} from inside your network, ${when}.`);
  } else {
    add('ports', 'info', 'Open doors not checked yet', 'Press Check open ports to try the common ones.');
  }

  const worst = checks.reduce((n, c) => Math.max(n, order[c.status]), 0);
  const needs = checks.filter((c) => c.status === 'warn' || c.status === 'bad').length;
  return {
    status: worst === 2 ? 'bad' : worst === 1 ? 'warn' : 'ok',
    headline: needs ? `${plural(needs, 'thing needs', 'things need')} you` : 'Everything looks safe',
    checks,
  };
}

module.exports = { AccountGuard, SecurityWatch, securityChecks, isPrivateIp };
