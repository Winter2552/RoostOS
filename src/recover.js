'use strict';

// Getting Roost back after a break-in. Run it on Roost's data folder after
// restoring a clean night from a backup (or on the current data if there is no
// backup), with Roost stopped. It assumes anything Roost knows may have been
// copied, and changes everything an attacker could still use:
//
//   - signs everyone out (browsers, phone apps) and forgets "trusted devices"
//   - gives one admin a new temporary password, and makes every other admin's
//     password unusable until that admin makes them a reset link
//   - clears every admin's two-step, so they set up a fresh authenticator
//   - deletes invite and reset links, phone-alert keys and public Nest links
//   - removes the secrets Roost stored: Cloudflare token, email password, the
//     Jellyfin key, the Coffee Galaxy and galaxy secrets, the WireGuard key
//     and the HTTPS certificate keys
//   - turns lockdown on, so outside access stays closed until you have looked
//   - re-seals Sentinel on the accounts as they now are
//
// It also keeps a copy of the accounts file as it was, and writes a report of
// what is left for you to do by hand (the things only you can change: the
// Cloudflare token itself, router, ZimaOS and so on).
//
//   docker compose stop roost
//   docker compose run --rm --no-deps roost node src/recover.js --admin raven
//   docker compose up -d roost

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword } = require('./auth');
const { sealFile } = require('./sentinel');

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

// Easy to read out, no look-alike letters.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
function tempPassword() {
  return Array.from(crypto.randomBytes(16), (b) => ALPHABET[b % ALPHABET.length]).join('').replace(/(.{4})(?=.)/g, '$1-');
}

const unusable = () => hashPassword(crypto.randomBytes(32).toString('hex'));

function recover({ dataDir, admin, keepLinks = false, now = new Date() }) {
  const file = path.join(dataDir, 'roost.json');
  if (!fs.existsSync(file)) throw new Error(`No roost.json in ${dataDir}. Restore a backup first, or check DATA_DIR.`);
  const db = JSON.parse(fs.readFileSync(file, 'utf8'));
  const users = db.users || [];
  const chosen = users.find((u) => u.username === String(admin || '').toLowerCase() && u.role === 'admin');
  if (!chosen) throw new Error(`"${admin || ''}" is not an admin here. Admins: ${users.filter((u) => u.role === 'admin').map((u) => u.username).join(', ') || 'none'}`);

  const did = [];
  const saved = `${file}.before-recover-${stamp(now)}`;
  fs.copyFileSync(file, saved);
  did.push(`Kept a copy of the old accounts file: ${path.basename(saved)}`);

  const remove = (rel, what) => {
    const target = path.join(dataDir, rel);
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
      did.push(what);
    }
  };
  remove('sessions.json', 'Signed everyone out, browsers and phone apps');

  const password = tempPassword();
  for (const u of users) {
    u.trusted = [];
    if (u.role !== 'admin') continue;
    delete u.twoStep;
    delete u.twoStepSkipped;
    u.password = u === chosen ? hashPassword(password) : unusable();
  }
  db.settings = db.settings || {};
  db.settings.adminsNeedTwoStep = true;
  const admins = users.filter((u) => u.role === 'admin');
  did.push(`Cleared two-step for ${admins.length === 1 ? 'the admin' : `${admins.length} admins`}; each sets up a new authenticator at next sign-in`);
  if (admins.length > 1) did.push(`Other admins can't sign in until ${chosen.username} makes them a reset link (Admin → Users)`);

  const links = (db.links || []).length;
  db.links = [];
  if (links) did.push(`Deleted ${links} invite and reset ${links === 1 ? 'link' : 'links'}`);
  if (db.push) {
    delete db.push;
    did.push('Deleted phone-alert keys (each phone turns alerts on again)');
  }

  const s = db.settings;
  if (s.tls && s.tls.token) { delete s.tls.token; did.push('Removed the saved Cloudflare token'); }
  if (s.mail && s.mail.password) { s.mail.password = ''; did.push('Removed the saved email password'); }
  if (s.jellyfin && s.jellyfin.apiKey) { s.jellyfin.apiKey = ''; did.push('Removed the saved Jellyfin API key'); }
  if (s.coffee && s.coffee.secret) { s.coffee = { ...s.coffee, secret: '', enabled: false }; did.push('Removed the Coffee Galaxy shared secret and switched its gateway off'); }
  for (const g of Array.isArray(s.galaxies) ? s.galaxies : []) {
    if (g.secret) { g.secret = ''; g.enabled = false; did.push(`Removed the shared secret for the ${g.name || g.id} galaxy and switched it off`); }
  }
  db.alerts = [];

  remove('wireguard/privatekey', 'Deleted the WireGuard key (Roost makes a new one)');
  remove('wireguard/wg0.conf', 'Deleted the WireGuard link settings');
  for (const f of ['key.pem', 'cert.pem', 'account.pem', 'account-staging.pem']) remove(path.join('tls', f), `Deleted HTTPS certificate file ${f}`);

  const nestDb = path.join(dataDir, 'nest.db');
  if (!keepLinks && fs.existsSync(nestDb)) {
    try {
      const nest = new DatabaseSync(nestDb);
      const n = nest.prepare('DELETE FROM shares').run().changes;
      nest.close();
      if (n) did.push(`Deleted ${n} public Nest ${n === 1 ? 'link' : 'links'}`);
    } catch (err) {
      did.push(`Could not clear public Nest links (${err.message}); switch them off under Admin → Server`);
    }
  }

  s.lockdown = { at: now.toISOString(), by: 'Recovery' };
  did.push('Turned lockdown on: outside access stays closed until you lift it in Admin → Security');

  fs.writeFileSync(`${file}.tmp`, JSON.stringify(db, null, 2));
  fs.renameSync(`${file}.tmp`, file);
  sealFile(dataDir, db);
  did.push('Re-sealed Sentinel on the accounts as they are now');

  const byHand = [
    'Make a NEW Cloudflare API token and delete the old one at dash.cloudflare.com → My Profile → API Tokens. Then save the new one under Admin → Secure connection.',
    'Change the ZimaOS password and the Optiplex\'s SSH keys/passwords if anyone had a way in there. Roost can\'t see or change those.',
    'Change the email relay (Resend) API key, then save it under Admin → Email.',
    'In Jellyfin, change the admin password and make a new API key, then save it under Admin → Jellyfin.',
    'Coffee Galaxy: make a new shared secret in Admin → Coffee Galaxy, and run the Oracle scripts again with Roost\'s new WireGuard public key.',
    'Check the router: only port 443 forwarded, UPnP off, router admin password changed.',
    'Run `docker ps` on the server. Any container you did not install is a sign of a deeper break-in; if there is one, reinstall ZimaOS and restore from the backup.',
    'Update Roost to the latest version (Admin → Updates) before lifting lockdown.',
    'Check Admin → Activity for what happened and when, and look at Users for accounts you do not know.',
    'Ask each person to change their password (Admin → Users → reset link), since the old password hashes may have been copied.',
    'Lift lockdown in Admin → Security once you are happy.',
  ];
  if (keepLinks) byHand.push('You kept the public Nest links; look through them in Nest and remove any you do not recognise.');
  return { did, byHand, username: chosen.username, password };
}

function report({ did, byHand, username, password }, { withPassword = true } = {}) {
  return [
    'ROOST RECOVERY',
    '',
    `Sign in as: ${username}`,
    ...(withPassword ? [`Temporary password: ${password}`] : ['Temporary password: shown once on screen, not saved']),
    '(Roost will ask you to set up two-step sign-in straight away. Change this password in Profile.)',
    '',
    'What Roost did:',
    ...did.map((d) => `  - ${d}`),
    '',
    'What only you can do:',
    ...byHand.map((d, i) => `  ${i + 1}. ${d}`),
    '',
  ].join('\n');
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

async function main(argv) {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const args = argv.slice();
  const take = (flag) => { const i = args.indexOf(flag); if (i < 0) return null; args.splice(i, 1); return true; };
  const yes = take('--yes');
  const keepLinks = take('--keep-links');
  const i = args.indexOf('--admin');
  const admin = i >= 0 ? args[i + 1] : '';
  if (!admin) {
    console.log('Usage: node src/recover.js --admin <username> [--keep-links] [--yes]\n\nRun with Roost stopped, after restoring a clean backup. See the README, "If you think someone got in".');
    process.exit(1);
  }
  if (!yes) {
    console.log(`This resets every sign-in, password, key and secret in ${dataDir}, and turns lockdown on.`);
    if ((await ask('Type "recover" to go ahead: ')) !== 'recover') {
      console.log('Nothing changed.');
      process.exit(1);
    }
  }
  const result = recover({ dataDir, admin, keepLinks });
  // The password is only shown here; the saved copy has the to-do list without it.
  fs.writeFileSync(path.join(dataDir, 'recovery-report.txt'), report(result, { withPassword: false }), { mode: 0o600 });
  console.log(`\n${report(result)}The to-do list is also saved in ${path.join(dataDir, 'recovery-report.txt')}.`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => { console.error(err.message); process.exit(1); });
}

module.exports = { recover, report, tempPassword };
