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
    title: 'Keep Nest on the 3 TB drive',
    why: 'Files go on the big data drive, not the 240 GB system SSD.',
    how: [
      'In ZimaOS, open Storage and note the mount folder of the 3 TB drive.',
      'In Roost\'s compose file, point the Nest volume at a folder on it, e.g. /media/Data/roost-nest:/nest.',
      'Redeploy Roost from the ZimaOS app settings.',
    ],
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
      'In Cloudflare Zero Trust → Networks → Tunnels, create a tunnel and add its cloudflared container on ZimaOS.',
      'In the tunnel, add a public hostname pointing roostos.network at http://roost:8080 (or the server\'s address and port 8080).',
      'Under Admin → Server, set Public address to https://roostos.network.',
    ],
    action: { label: 'Set address', view: 'admin', focus: 'settings-form', field: 'publicUrl' },
    check: (ctx) => Boolean(ctx.db.settings.publicUrl),
  },
  {
    id: 'behind-tunnel',
    group: 'Reach it from anywhere',
    title: 'Tell Roost it is behind the tunnel',
    why: 'Sign-in cookies only travel over HTTPS, and the activity log shows visitors\' real addresses.',
    how: [
      'In Roost\'s compose file, set SECURE_COOKIES to "true" and BEHIND_PROXY to "true".',
      'Redeploy Roost. From then on, open it through https://roostos.network rather than plain http.',
    ],
    check: (ctx) => ctx.secureCookies && ctx.trustProxy,
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
    id: 'invite',
    group: 'People',
    title: 'Invite someone',
    why: 'Send a link; they pick their own username and password.',
    how: ['Under Admin → Invite someone, choose their apps and storage, then share or email the link.'],
    action: { label: 'Make an invite', view: 'admin', focus: 'invite-form' },
    check: (ctx) => ctx.db.users.length > 1 || (ctx.db.links || []).some((l) => l.kind === 'invite'),
  },
];

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

module.exports = { STEPS, MANUAL, checklist };
