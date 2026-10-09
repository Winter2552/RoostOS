'use strict';

// Getting a whole backup (or part of one) back onto a server, from the command
// line. This is for when the server itself is gone or broken; for a few files,
// Admin → Backups is easier.
//
//   node src/restore-cli.js list [--from /backup]
//   node src/restore-cli.js restore "2026-10-08 0300" /restore [path inside the backup] [--from /backup]
//
// It writes the files into the output folder with their original dates,
// keeping the folder layout (Nest/..., Roost/..., App settings/...). It never
// overwrites: an output folder that already holds something is refused unless
// you pass --replace, and then the old folder is only renamed (to
// "<folder>.before-restore-<time>"), never deleted, after you type "restore"
// to confirm (or pass --yes).

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const restore = require('./restore');

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const size = (n) => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
};

function parseArgs(argv) {
  const flags = { replace: false, yes: false, from: process.env.BACKUP_DIR || '/backup' };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--replace') flags.replace = true;
    else if (argv[i] === '--yes') flags.yes = true;
    else if (argv[i] === '--from') flags.from = argv[++i];
    else rest.push(argv[i]);
  }
  return { flags, rest };
}

function isEmpty(dir) {
  try {
    return fs.readdirSync(dir).length === 0;
  } catch {
    return true;
  }
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
}

async function run(argv, { out = (t) => console.log(t), confirm = ask } = {}) {
  const { flags, rest } = parseArgs(argv);
  const [command, night, output, inside = ''] = rest;
  const backups = new restore.Backups(flags.from);

  if (command === 'list') {
    const nights = backups.nights();
    if (!nights.length) {
      out(`No backups found in ${flags.from}. Is the backup drive plugged in and mounted there? (Use --from to point at another folder.)`);
      return 1;
    }
    for (const n of nights) {
      const found = await backups.night(n.name);
      out(`${n.name}   ${found ? `${found.count} files, ${size(found.bytes)}` : 'unreadable'}`);
    }
    return 0;
  }

  if (command !== 'restore' || !night || !output) {
    out('Usage:\n  node src/restore-cli.js list [--from /backup]\n  node src/restore-cli.js restore "<backup>" <output folder> [path inside the backup] [--from /backup] [--replace] [--yes]');
    return 1;
  }

  const found = await backups.night(night);
  if (!found) {
    out(`There is no backup called "${night}" in ${flags.from}. Run "list" to see them.`);
    return 1;
  }
  const p = restore.cleanPath(inside);
  if (p === null || !found.kind(p)) {
    out(`"${inside}" isn't in that backup.`);
    return 1;
  }
  const target = path.resolve(output);
  const source = path.resolve(flags.from);
  if (target === path.parse(target).root || target === source || target.startsWith(source + path.sep)) {
    out('Pick an output folder that is not the backup drive itself.');
    return 1;
  }

  if (!isEmpty(target)) {
    if (!flags.replace) {
      out(`${target} already has files in it, and a restore never overwrites. Pick an empty folder, or add --replace to move the existing one aside first.`);
      return 1;
    }
    const aside = `${target}.before-restore-${stamp()}`;
    if (!flags.yes) {
      const answer = await confirm(`This moves ${target} to ${aside} (nothing is deleted) and restores into a fresh ${target}.\nType "restore" to go ahead: `);
      if (String(answer).trim().toLowerCase() !== 'restore') {
        out('Cancelled. Nothing was changed.');
        return 1;
      }
    }
    fs.renameSync(target, aside);
    out(`Moved the existing folder to ${aside}`);
  }

  // The picked item keeps its own name; the whole backup keeps its top folders.
  const base = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
  const entries = found.under(p);
  const total = entries.reduce((a, f) => a + f[1], 0);
  out(`Restoring ${entries.length} files (${size(total)}) from ${found.name}${p ? ` · ${p}` : ''} into ${target}`);
  fs.mkdirSync(target, { recursive: true });
  let done = 0;
  let last = Date.now();
  await restore.extract(found, entries, target, {
    base,
    onFile: () => {
      done++;
      if (Date.now() - last > 3000) {
        last = Date.now();
        out(`  ${done} of ${entries.length} files`);
      }
    },
  });
  out(`Done: ${done} files restored to ${target}`);
  return 0;
}

if (require.main === module) {
  run(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
    console.error(`Restore stopped: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { run };
