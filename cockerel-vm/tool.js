#!/usr/bin/env node
'use strict';

// cockerel-tool: the only thing Cockerel's Claude session may run. Every job
// he does goes through here, so the rules live in code he cannot talk around:
// open sources only unless Raven says he is entitled, a size limit Roost
// checks, downloads only while the VPN is up, and everything written to
// Roost's activity feed. Run with no arguments for the list of commands.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const lib = require('./lib');

const HOME = process.env.COCKEREL_HOME || path.join(os.homedir(), 'cockerel');
const STATE = path.join(HOME, 'state');
const MEDIA = process.env.MEDIA_ROOT || '/srv/media';
const INCOMING = process.env.INCOMING_DIR || path.join(MEDIA, 'incoming');
const ROOST = (process.env.ROOST_URL || '').replace(/\/+$/, '');
const SECRET = process.env.COCKEREL_SECRET || '';
const HOOK_DONE = path.join(__dirname, 'hook.sh');
const HOOK_ERROR = path.join(__dirname, 'hook-error.sh');

const jobFile = (id) => path.join(STATE, 'jobs', `${id}.json`);
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const writeJson = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); };

function fail(text, code = 1) {
  console.error(text);
  process.exit(code);
}

async function hook(payload) {
  if (!ROOST || !SECRET) fail('Roost is not linked on this machine (ROOST_URL, COCKEREL_SECRET).');
  const body = JSON.stringify(payload);
  let res;
  try {
    res = await fetch(`${ROOST}/api/cockerel/hook`, { method: 'POST', headers: lib.headers(SECRET, body), body, signal: AbortSignal.timeout(20000) });
  } catch { fail("Can't reach Roost right now."); }
  const out = await res.json().catch(() => ({}));
  if (!res.ok) fail(out.error || `Roost answered ${res.status}`);
  return out;
}

// Reads --name value pairs after the positional words.
function parse(args) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) opt[args[i].slice(2)] = args[++i];
    else pos.push(args[i]);
  }
  return { pos, opt };
}

function approved(key) {
  return Boolean((readJson(path.join(STATE, 'approvals.json'), {}))[key]);
}

const vpnUp = () => spawnSync('ip', ['link', 'show', 'wg0'], { stdio: 'ignore' }).status === 0;

// ---------- finding and checking ----------
async function find(title) {
  const q = `title:(${title.replace(/[()":]/g, ' ')}) AND mediatype:movies AND (collection:feature_films OR licenseurl:*)`;
  const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}&fl[]=identifier&fl[]=title&fl[]=year&fl[]=licenseurl&rows=6&output=json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const docs = ((await res.json()).response || {}).docs || [];
  if (!docs.length) return console.log('Nothing open or public domain found on the Internet Archive for that title.');
  for (const d of docs.slice(0, 4)) {
    let best = '';
    try {
      const meta = await (await fetch(`https://archive.org/metadata/${encodeURIComponent(d.identifier)}`, { signal: AbortSignal.timeout(20000) })).json();
      const file = (meta.files || []).filter((f) => /\.(mp4|mkv|ogv|webm)$/i.test(f.name) && Number(f.size) > 50e6).sort((a, b) => Number(b.size) - Number(a.size))[0];
      if (file) best = `\n   https://archive.org/download/${encodeURIComponent(d.identifier)}/${encodeURIComponent(file.name)}  (${lib.human(Number(file.size))})`;
    } catch { /* leave the link out */ }
    console.log(`- ${d.title} (${d.year || '?'}) licence: ${d.licenseurl || 'public domain collection'}${best}`);
  }
}

function sizeOf(link) {
  if (/^magnet:|\.torrent(\?|$)/i.test(link)) {
    const tmp = path.join(HOME, 'tmp', String(process.pid));
    fs.mkdirSync(tmp, { recursive: true });
    let file = link;
    if (/^magnet:/i.test(link)) {
      spawnSync('aria2c', ['--bt-metadata-only=true', '--bt-save-metadata=true', '--bt-stop-timeout=120', '--enable-dht=true', `-d${tmp}`, link], { timeout: 180000, stdio: 'ignore' });
      file = (fs.readdirSync(tmp).find((f) => f.endsWith('.torrent')) || '');
      file = file && path.join(tmp, file);
    } else {
      spawnSync('curl', ['-sSL', '--max-time', '60', '--proto', '=https', '--proto-redir', '=https', '-o', path.join(tmp, 'x.torrent'), link], { stdio: 'ignore' });
      file = path.join(tmp, 'x.torrent');
    }
    let total = 0;
    if (file && fs.existsSync(file)) {
      const out = spawnSync('aria2c', ['-S', file], { encoding: 'utf8' }).stdout || '';
      const m = /Total Length:[^(]*\(([\d,]+)\)/.exec(out);
      if (m) total = Number(m[1].replace(/,/g, ''));
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    return { size: total, torrent: file };
  }
  const out = spawnSync('curl', ['-sIL', '--max-time', '30', '--proto', '=https', '--proto-redir', '=https', '--max-redirs', '5', link], { encoding: 'utf8' }).stdout || '';
  const lens = [...out.matchAll(/^content-length:\s*(\d+)/gim)].map((m) => Number(m[1]));
  return { size: lens.length ? lens[lens.length - 1] : 0 };
}

// ---------- fetch ----------
async function fetchJob(link, opt) {
  const id = opt.job;
  if (!lib.jobIdOk(id)) fail('--job needs a short plain id, like sintel-1');
  const name = lib.cleanName(opt.name);
  if (!name) fail('--name "Film name" is required');
  const kind = opt.kind === 'show' ? 'show' : 'movie';
  const source = lib.sourceKind(link);
  if (source === 'bad') fail('That link is not allowed. Only https links to the open internet, or a magnet link Raven gave you.');
  const meta = { ...readJson(jobFile(id), {}), id, link, name, year: opt.year || '', kind, requester: opt.requester || '', status: 'new' };
  writeJson(jobFile(id), meta);
  await hook({ type: 'job', id, title: name, state: 'Finding', requester: meta.requester });

  if (source === 'other' && !approved(`entitled-${id}`)) {
    await hook({ type: 'ask', askId: `entitled-${id}`, text: `${name} would come from a source I don't normally use. Are you entitled to download this one yourself (you own it, or it is free to share)?`, options: ["Yes, I'm entitled to this", 'Cancel'] });
    return console.log('Asked Raven whether he is entitled to this download. Stop here and wait: he will answer and you will be woken to continue.');
  }
  if (!vpnUp()) {
    await hook({ type: 'job', id, state: 'Failed' });
    await hook({ type: 'log', text: `Did not start ${name}: the VPN is down.` });
    fail('The VPN is down, so downloads are stopped. Tell Raven.');
  }
  const { size, torrent } = sizeOf(link);
  const verdict = await hook({ type: 'check', bytes: size });
  if (verdict.decision === 'ask' && !approved(`size-${id}`)) {
    const how = size ? lib.human(size) : 'an unknown size';
    await hook({ type: 'ask', askId: `size-${id}`, text: `${name} is ${how}: ${verdict.reason}. Download it anyway?`, options: ['Download', 'Cancel'] });
    return console.log('Asked Raven because of the size. Stop here and wait: he will answer and you will be woken to continue.');
  }
  await hook({ type: 'spend', bytes: size });
  const dir = path.join(INCOMING, id);
  fs.mkdirSync(dir, { recursive: true });
  const args = ['--seed-time=0', '--max-overall-upload-limit=1K', '--file-allocation=none', '--auto-file-renaming=false', '--summary-interval=0', '--console-log-level=warn', `--on-download-complete=${HOOK_DONE}`, `--on-download-error=${HOOK_ERROR}`, `-d${dir}`, torrent || link];
  if (/^https:/i.test(link) && !torrent) args.unshift('--max-redirect=5', '--check-certificate=true');
  const child = spawn('aria2c', args, { detached: true, stdio: 'ignore', env: { ...process.env, COCKEREL_JOB: id } });
  child.unref();
  writeJson(jobFile(id), { ...meta, status: 'downloading', size });
  await hook({ type: 'job', id, state: 'Downloading', progress: 0 });
  await hook({ type: 'log', text: `Started downloading ${name} (${size ? lib.human(size) : 'size unknown'}).` });
  console.log(`Download started for job ${id}. He is told when it finishes; nothing more to do now.`);
}

// ---------- when aria2 finishes (called by hook.sh) ----------
function biggestVideo(dir) {
  let best = null;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (lib.VIDEO.test(e.name)) {
        const size = fs.statSync(p).size;
        if (!best || size > best.size) best = { p, size };
      }
    }
  };
  walk(dir);
  return best;
}

function move(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try { fs.renameSync(from, to); } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
  }
}

async function done(id) {
  if (!lib.jobIdOk(id)) fail('bad job');
  const meta = readJson(jobFile(id), null);
  if (!meta || meta.status !== 'downloading') return;
  const dir = path.join(INCOMING, id);
  try {
    const files = [];
    if (meta.kind === 'show') {
      const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (lib.VIDEO.test(e.name)) files.push(p); } };
      walk(dir);
    } else {
      const v = biggestVideo(dir);
      if (v) files.push(v.p);
    }
    if (!files.length) throw new Error('no video file in the download');
    for (const f of files) {
      const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' });
      if (probe.status !== 0 || !(Number(probe.stdout) > 60)) throw new Error(`${path.basename(f)} does not look like a video`);
    }
    const target = (f) => (meta.kind === 'show' ? lib.episodePath(MEDIA, meta.name, path.basename(f)) : lib.moviePath(MEDIA, meta.name, meta.year, path.extname(f).toLowerCase()));
    if (files.some((f) => !target(f))) throw new Error('could not tell the episode numbers from the file names');
    for (const f of files) {
      const to = target(f);
      if (fs.existsSync(to)) throw new Error(`${path.relative(MEDIA, to)} already exists`);
      move(f, to);
    }
    fs.rmSync(dir, { recursive: true, force: true });
    writeJson(jobFile(id), { ...meta, status: 'added' });
    await hook({ type: 'refresh' });
    await hook({ type: 'job', id, state: 'Added', progress: 100 });
    await hook({ type: 'log', text: `${meta.name} is on Roostflix.` });
    if (meta.requester) await hook({ type: 'ready', requester: meta.requester, title: meta.name, jobId: id });
  } catch (err) {
    await failed(id, err.message);
  }
}

async function failed(id, why = 'the download failed') {
  const meta = readJson(jobFile(id), null);
  if (!meta || meta.status === 'added' || meta.status === 'failed') return;
  writeJson(jobFile(id), { ...meta, status: 'failed' });
  await hook({ type: 'job', id, state: 'Failed' });
  await hook({ type: 'log', text: `${meta.name}: ${why}. The files stay in incoming/${id} for a look.` });
}

// ---------- sending Raven a file ----------
// Text goes to Roost, which saves it in Raven's Nest under Cockerel/ and shows
// a download card in the chat. Roost caps the size.
const FILE_MAX = 20 * 1024 * 1024;
async function send(opt) {
  const name = lib.cleanName(opt.name);
  const text = typeof opt.text === 'string' ? opt.text : '';
  if (!name || !/\.(md|txt|csv|json|html)$/i.test(name)) fail('send --name "notes.md" --text "..." (a .md, .txt, .csv, .json or .html name)');
  if (!text) fail('--text is empty');
  const data = Buffer.from(text, 'utf8');
  if (data.length > FILE_MAX) fail('That is too big to send (20 MB limit).');
  const out = await hook({ type: 'file', name, data: data.toString('base64') });
  console.log(`Saved ${out.name} to Raven's Nest (Cockerel folder) and showed it in the chat. Tell him it is there.`);
}

// ---------- the commands ----------
const COMMANDS = {
  events: ([n]) => {
    const lines = (fs.existsSync(path.join(STATE, 'events.jsonl')) ? fs.readFileSync(path.join(STATE, 'events.jsonl'), 'utf8') : '').trim().split('\n').filter(Boolean);
    console.log(lines.slice(-(Number(n) || 10)).join('\n') || 'No notifications yet.');
  },
  log: async ([text]) => { await hook({ type: 'log', text: String(text || '').slice(0, 1000) }); },
  job: async ([id, state], opt) => { await hook({ type: 'job', id, state, title: opt.title, progress: Number(opt.progress), requester: opt.requester }); },
  ask: async ([askId, text, ...options]) => { await hook({ type: 'ask', askId, text, options: options.length ? options : undefined }); console.log('Asked. Stop and wait; he will answer and you will be woken.'); },
  library: async ([term]) => {
    const out = await hook({ type: 'library', term });
    console.log(out.found.length ? out.found.map((i) => `${i.name} (${i.year || '?'}) ${i.type}`).join('\n') : 'Not on Roostflix.');
  },
  find: async ([title]) => { if (!title) fail('find "Title"'); await find(title); },
  fetch: async ([link], opt) => { if (!link) fail('fetch <link> --job ID --name "Name" [--year 2010] [--kind movie|show] [--requester username]'); await fetchJob(link, opt); },
  send: async (_pos, opt) => { await send(opt); },
  // His notebook lives in Roost; these just talk to it.
  remember: async ([text]) => { if (!text) fail('remember "something to keep in mind"'); await hook({ type: 'remember', text }); console.log('Noted.'); },
  memories: async () => { console.log((await hook({ type: 'list', kind: 'memory' })).lines.join('\n') || 'Nothing remembered yet.'); },
  forget: async ([id]) => { await hook({ type: 'remove', kind: 'memory', id }); console.log('Forgotten.'); },
  task: async ([text], opt) => { if (!text) fail('task "what to do" [--due 2026-11-05]'); await hook({ type: 'task', text, due: opt.due }); console.log('Added to the task list.'); },
  tasks: async () => { console.log((await hook({ type: 'list', kind: 'task' })).lines.join('\n') || 'No open tasks.'); },
  done: async ([id]) => { if (!id) fail('done TASK_ID'); await hook({ type: 'taskdone', id }); console.log('Ticked off.'); },
  remind: async ([text], opt) => {
    if (!text || !opt.at) fail('remind "what" --at "2026-11-05 09:00"  (the time on Raven\'s clock)');
    const out = await hook({ type: 'remind', at: opt.at, text });
    console.log(`Reminder set for ${out.item.at} (${out.tz} clock as given).`);
  },
  reminders: async () => { console.log((await hook({ type: 'list', kind: 'reminder' })).lines.join('\n') || 'No reminders.'); },
  cancel: async ([id]) => { await hook({ type: 'remove', kind: 'reminder', id }); console.log('Cancelled.'); },
  schedule: async ([text], opt) => {
    if (!text || !opt.every || !opt.time) fail('schedule "what to do each time" --every day|week --time 08:00 [--day 0-6]');
    const out = await hook({ type: 'schedule', text, every: opt.every, time: opt.time, day: opt.day });
    console.log(out.note);
  },
  schedules: async () => { console.log((await hook({ type: 'list', kind: 'job' })).lines.join('\n') || 'No repeating jobs.'); },
  unschedule: async ([id]) => { await hook({ type: 'remove', kind: 'job', id }); console.log('Stopped.'); },
  notify: async ([text]) => { if (!text) fail('notify "short message"'); await hook({ type: 'notify', text }); console.log('Sent to Raven\'s phone.'); },
  done: async ([id]) => { await done(id); },
  failed: async ([id]) => { await failed(id); },
};

(async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  const run = COMMANDS[cmd];
  if (!run) fail(`Commands: ${Object.keys(COMMANDS).filter((c) => c !== 'done' && c !== 'failed').join(', ')}`);
  const { pos, opt } = parse(rest);
  await run(pos, opt);
})().catch((err) => fail(err.message));
