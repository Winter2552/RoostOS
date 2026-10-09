'use strict';

// The setup checklist behind Admin → Setup. Every step Roost needs, in the
// order to do them, with a check Roost runs itself so the list ticks off as
// things get done. When a feature needs something set up (a setting, a DNS
// record, a drive), add a step here in the same change: this file is the one
// tally of what setting up Roost involves.
//
// Each step:
//   id, group, title    shown in the list
//   why                 one line: what it gives you
//   how                 the steps, in order, including any outside Roost
//   action              where in Roost to do it: { label, view, focus, field }
//                       (focus is the id of the form to jump to, field the input)
//   optional            true for nice-to-haves (not counted in progress)
//   covers              the environment variables and saved settings this step
//                       is about; test/setup.test.js fails if one in src/ has no step
//   check(ctx)          true when done; ctx is built by the server

const fs = require('fs');

const TB = 1000 ** 4;

function driveSize(dir) {
  try {
    const s = fs.statfsSync(dir);
    return s.blocks * s.bsize;
  } catch {
    return 0;
  }
}

const STEPS = [
  // ---------- the server ----------
  {
    id: 'data-drive',
    group: 'Server',
    title: 'Keep Nest and Glint on the 3 TB drive',
    why: 'Files and photos go on the big data drive, not the 240 GB system SSD. Glint keeps its photos in Nest\'s folder, so this one setting covers both.',
    how: [
      'In ZimaOS, open Storage and note the mount folder of the 3 TB drive.',
      'In Roost\'s compose file, point the Nest volume at a folder on it, e.g. /media/Data/roost-nest:/nest.',
      'Redeploy Roost from the ZimaOS app settings.',
    ],
    covers: ['NEST_DIR'],
    check: (ctx) => driveSize(ctx.nestDir) >= TB,
  },
  {
    id: 'drives',
    group: 'Server',
    title: 'Show both drives on the status page',
    why: 'See how full the SSD and the data drive are, and get warned before either fills up.',
    how: [
      'In Roost\'s compose file, change the second read-only line to the 3 TB drive\'s mount folder, e.g. /media/Data:/hostfs/data:ro.',
      'Redeploy Roost.',
    ],
    action: { label: 'Open status', view: 'status' },
    covers: ['ROOST_DISKS'],
    check: (ctx) => ctx.drives.filter((d) => !d.missing).length >= 2,
  },
  {
    id: 'docker',
    group: 'Server',
    title: 'Let Roost see your containers',
    why: 'The status page shows whether each app\'s container is running, crashing or stopped.',
    how: [
      'Keep the docker-proxy service and DOCKER_HOST line from the compose file in the README.',
      'Redeploy Roost.',
    ],
    action: { label: 'Open status', view: 'status' },
    covers: ['DOCKER_HOST'],
    check: (ctx) => ctx.dockerOk,
  },
  {
    id: 'app-links',
    group: 'Server',
    title: 'Link every app',
    why: 'App cards open the app instead of showing "Not set up".',
    how: [
      'Under Admin → Apps, give each app its address, e.g. http://{host}:8096 for Jellyfin.',
      '{host} becomes whatever address Roost was opened on, so one link works at home and away.',
    ],
    action: { label: 'Edit apps', view: 'admin', focus: 'apps-form' },
    check: (ctx) => ctx.db.apps.every((a) => a.url),
  },

  // ---------- reaching Roost from anywhere ----------
  {
    id: 'public-address',
    group: 'Reach it from anywhere',
    title: 'Give Roost its web address',
    why: 'Invite and reset links use it, so they open from anywhere.',
    how: [
      'Buy the domain (roostos.network) and add it to a free Cloudflare account.',
      'Point the domain at your home connection (the remote access step will walk through this once it is built).',
      'Under Admin → Server, set Public address to https://roostos.network.',
    ],
    action: { label: 'Set address', view: 'admin', focus: 'settings-form', field: 'publicUrl' },
    covers: ['publicUrl'],
    check: (ctx) => Boolean(ctx.db.settings.publicUrl),
  },
  {
    id: 'behind-proxy',
    group: 'Reach it from anywhere',
    title: 'Behind a tunnel or proxy? Tell Roost',
    why: 'Sign-in cookies stay on HTTPS and the activity log shows visitors\' real addresses. Skip this if Roost answers on its own address.',
    how: [
      'Only if something else (a tunnel or reverse proxy) sits in front of Roost: in Roost\'s compose file, set SECURE_COOKIES to "true" and BEHIND_PROXY to "true".',
      'Redeploy Roost. Leave BEHIND_PROXY off otherwise: without a proxy, visitors could fake their address.',
    ],
    optional: true,
    covers: ['SECURE_COOKIES', 'BEHIND_PROXY'],
    check: (ctx) => ctx.secureCookies && ctx.trustProxy,
  },
  {
    id: 'https',
    group: 'Reach it from anywhere',
    title: 'Get a certificate for HTTPS',
    why: 'Roost opens securely at home and away, with no browser warnings. The installable app needs it.',
    how: [
      'Make sure roostos.network is on your Cloudflare account (the free plan is enough).',
      'In Cloudflare, go to My Profile → API Tokens → Create Token, pick "Edit zone DNS" and limit it to roostos.network.',
      'Under Admin → Secure connection, enter roostos.network, paste the token and press Save. Roost gets the certificate and renews it itself.',
      'Keep the 443:8443 port line in Roost\'s compose file (it is there by default).',
    ],
    action: { label: 'Set up HTTPS', view: 'admin', focus: 'tls-form', field: 'domain' },
    // Roost works on plain HTTP without it, so it doesn't hold up the count.
    optional: true,
    // Settings and env vars this step is about.
    covers: ['tls', 'HTTPS_PORT', 'ROOST_ACME_STAGING'],
    // A certificate in use counts, even while a renewal is retrying.
    check: (ctx) => ['active', 'warning'].includes(ctx.tls.state),
  },

  // ---------- email ----------
  {
    id: 'email',
    group: 'Email',
    title: 'Send email as server@roostos.network',
    why: '"Forgot password?" and emailed invites need it.',
    how: [
      'Sign up for a free relay (Resend or Brevo) and add roostos.network as a sending domain.',
      'Add the DNS records it gives you (SPF and DKIM) in Cloudflare → DNS.',
      'Under Admin → Email, enter the relay\'s SMTP details with Send from server@roostos.network.',
      'Press "Send me a test email" and check it arrived.',
    ],
    action: { label: 'Set up email', view: 'admin', focus: 'mail-form' },
    covers: ['mail'],
    check: (ctx) => Boolean(ctx.db.settings.mail && ctx.db.settings.mail.verifiedAt),
  },
  {
    id: 'admin-email',
    group: 'Email',
    title: 'Add your own email',
    why: 'So you can reset your password, and test emails have somewhere to go.',
    how: ['On Profile, fill in Email and save.'],
    action: { label: 'Open profile', view: 'profile', focus: 'profile-form' },
    check: (ctx) => Boolean(ctx.admin.email),
  },
  {
    id: 'email-replies',
    group: 'Email',
    title: 'Forward replies to server@ to your inbox',
    why: 'If someone answers an email from Roost, you see it.',
    how: [
      'In Cloudflare → Email → Email Routing, turn it on for roostos.network.',
      'Add a rule sending server@roostos.network to your own address.',
    ],
    optional: true,
    // Lives entirely in Cloudflare, so Roost can't see it; tick it off yourself.
    manual: true,
    check: (ctx) => ctx.ticked.includes('email-replies'),
  },

  // ---------- people ----------
  {
    id: 'two-step',
    group: 'People',
    title: 'Use two-step sign-in',
    why: 'A stolen password alone can\'t get into Roost once it is reachable from outside.',
    how: [
      'On Profile, under Two-step sign-in, press Set up and scan the code with an authenticator app.',
      'Keep the recovery codes somewhere safe.',
      'Under Admin → Server, keep "Admins must use two-step sign-in" ticked.',
    ],
    action: { label: 'Open profile', view: 'profile', focus: 'two-step-panel' },
    covers: ['adminsNeedTwoStep'],
    check: (ctx) => Boolean(ctx.admin.twoStep) && ctx.db.settings.adminsNeedTwoStep !== false,
  },
  {
    id: 'invite',
    group: 'People',
    title: 'Invite someone',
    why: 'Send a link; they pick their own username and password.',
    how: ['Under Admin → Invite someone, choose their apps and storage, then share or email the link.'],
    action: { label: 'Make an invite', view: 'admin', focus: 'invite-form' },
    check: (ctx) => ctx.db.users.length > 1 || (ctx.db.links || []).some((l) => l.kind === 'invite'),
  },
  {
    id: 'install-app',
    group: 'People',
    title: 'Put Roost on phones and PCs',
    why: 'Roost opens like an app, with the bird icon, from the home screen, Start menu or taskbar.',
    how: [
      'iPhone: open Roost in Safari, tap Share, then Add to Home Screen.',
      'Android: open Roost in Chrome, tap ⋮, then Install app. On a plain http home address it is Add to home screen and opens in Chrome.',
      'Windows: open Roost in Edge or Chrome and press the install icon at the right of the address bar. It shows once Roost has its https web address.',
    ],
    optional: true,
    // Happens on each device, so Roost can't see it; tick it off yourself.
    manual: true,
    check: (ctx) => ctx.ticked.includes('install-app'),
  },
  {
    id: 'guest-pass',
    group: 'People',
    title: 'Give a visitor a guest pass',
    why: 'Someone staying a while can use Jellyfin (or any app you pick) and is turned away on the day you choose.',
    how: [
      'Under Admin → Invite someone, set Role to Guest and pick when the pass ends.',
      'Share the link. They pick a username and password and see only their apps.',
      'If they use Jellyfin, give them a Jellyfin account too, and switch it off in Jellyfin when the pass ends.',
      'Under Admin → Users, "Add a week" extends a pass and "End now" signs them out straight away.',
    ],
    action: { label: 'Make a guest pass', view: 'admin', focus: 'invite-form' },
    optional: true,
    check: (ctx) => ctx.db.users.some((u) => u.role === 'guest') || (ctx.db.links || []).some((l) => l.role === 'guest'),
  },
];

// Settings with no step, and why. Anything else a change adds needs a step above.
const NO_STEP = {
  PORT: 'fixed by the compose file',
  DATA_DIR: 'fixed by the compose file',
  ROOST_CONTAINER: 'only if the Roost container is renamed',
  ROOST_APP_TOKEN: 'only for an outside storage app; Nest is built in',
  serverName: 'works as "Roost" until renamed under Admin → Server',
  defaultLimitGb: 'starts at 50 GB, changed under Admin → Server',
  setupTicked: 'this checklist\'s own record',
  notice: 'optional, posted under Admin → Notice',
};

const MANUAL = STEPS.filter((s) => s.manual).map((s) => s.id);

async function checklist(ctx) {
  const steps = STEPS.map(({ check, ...step }) => {
    let done = false;
    try {
      done = Boolean(check(ctx));
    } catch {
      // A check that can't run counts as not done.
    }
    return { ...step, done };
  });
  const required = steps.filter((s) => !s.optional);
  return { steps, done: required.filter((s) => s.done).length, total: required.length };
}

module.exports = { STEPS, NO_STEP, MANUAL, checklist };
