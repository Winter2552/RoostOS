#!/usr/bin/env node
'use strict';

// Cockerel's service, inside his VM. Roost talks to it over the home network
// with a signed request (the same signature as the Coffee gateway). It sleeps
// until something arrives: a chat message, a movie request, an answer from
// Raven. No timers, no polling. Claude only runs when there is a real job, and
// only with one tool: cockerel-tool (see tool.js).

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const lib = require('./lib');
const router = require('./router');
const { live, describe, clip, stream, isLocal } = require('./live');

const HOME = process.env.COCKEREL_HOME || path.join(os.homedir(), 'cockerel');
const STATE = path.join(HOME, 'state');
const SECRET = process.env.COCKEREL_SECRET || '';
const PORT = Number(process.env.PORT) || 7070;
const BIND = process.env.BIND || '0.0.0.0';
const MAX_RUNS = Number(process.env.MAX_RUNS_PER_DAY) || 60;
// The router (router.js) picks Haiku, Sonnet or Opus for each message, so the
// cheapest model that does the job well is used and the Claude allowance lasts.
const RUN_TIMEOUT_MS = 4 * 60 * 1000;
const TOOL = path.join(__dirname, 'tool.js');

const read = (f, fallback) => { try { return JSON.parse(fs.readFileSync(path.join(STATE, f), 'utf8')); } catch { return fallback; } };
const write = (f, data) => { fs.mkdirSync(STATE, { recursive: true }); fs.writeFileSync(path.join(STATE, f), JSON.stringify(data)); };

// ---------- one Claude run at a time, with a daily cap ----------
let chain = Promise.resolve();
let busy = false;

// What each kind of run may do. Film jobs can download; research and
// assistant runs can read the web but cannot download anything, so a hostile
// web page has nothing dangerous to steer him towards. Claude gets no Read or
// shell access in either mode (his settings file holds the shared secret).
const WEB = ['WebSearch', 'WebFetch'];
// Raven can switch a group of tools off in Admin (toolsOff).
const GROUPS = {
  web: ['browse'],
  files: ['send'],
  memory: ['remember', 'memories', 'forget'],
  tasks: ['task', 'tasks', 'done'],
  reminders: ['remind', 'reminders', 'cancel'],
  jobs: ['schedule', 'schedules', 'unschedule'],
  notify: ['notify'],
  calendar: ['calendar'],
  email: ['inbox', 'email'],
  roost: ['roost'],
  birdhouse: ['birdhouse'],
  nest: ['nest'],
  watching: ['watching'],
};
const TOOLS = {
  media: ['events', 'library', 'find', 'fetch', 'genres', 'shelve', 'ask', 'log', 'job', 'jobs', 'retry'],
  assistant: ['events', 'genres', 'shelve', 'handoff', 'jobs', 'calc', 'nest', 'watching', 'routine', 'ask', 'log', 'send', 'remember', 'memories', 'forget', 'task', 'tasks', 'done', 'remind', 'reminders', 'cancel', 'schedule', 'schedules', 'unschedule', 'notify', 'calendar', 'inbox', 'roost', 'email', 'birdhouse', 'browse'],
  // A job that runs by itself reads and reports, but cannot start new jobs or change his notes.
  scheduled: ['events', 'jobs', 'calc', 'nest', 'watching', 'log', 'send', 'notify', 'memories', 'tasks', 'reminders', 'schedules', 'calendar', 'inbox', 'roost', 'birdhouse', 'browse'],
};
const MEDIA_WORDS = /\b(movies?|films?|tv shows?|series|episodes?|roostflix|jellyfin|download|downloads|torrent)\b/i;
// A plain "get me this film" goes straight to the download tools. Anything that
// also asks a question, compares or sets a reminder runs with the web and the
// notebook instead, and hands the film part over with `cockerel-tool handoff`
// (so web pages and downloads are never in the same run).
const NOT_PLAIN = /\b(compare|review|reviews|recommend|should|best|remind|reminder|schedule|what|which|why|how|worth|rating|about|and then|then)\b|\?/i;
const modeFor = (text) => (MEDIA_WORDS.test(text) && !NOT_PLAIN.test(text) ? 'media' : 'assistant');
function allowedFor(mode, off = []) {
  const blocked = new Set(off.flatMap((g) => GROUPS[g] || []));
  const tools = TOOLS[mode].filter((c) => !blocked.has(c)).map((c) => `Bash(cockerel-tool ${c}:*)`);
  return [...(mode !== 'media' && !off.includes('web') ? WEB : []), ...tools];
}

// One call to Claude. Resolves { result, subtype }; result is '' when it did not finish.
function claudeCall(prompt, model, { allowed, maxTurns = 15, timeoutMs = RUN_TIMEOUT_MS, quiet = false } = {}) {
  return new Promise((resolve) => {
    // stream-json prints each step as it happens, so the VM window can follow along.
    const args = ['-p', prompt, '--model', model, '--output-format', 'stream-json', '--verbose', '--max-turns', String(maxTurns), '--allowedTools', ...(allowed || [])];
    const child = spawn('claude', args, { cwd: HOME, env: { ...process.env, PATH: `${path.dirname(TOOL)}:${process.env.PATH}` } });
    let buf = '';
    let result = '';
    let subtype = '';
    let err = '';
    const take = (line) => {
      if (!line.trim()) return;
      if (!quiet) { const shown = describe(line); if (shown) shown.split('\n').forEach(live); }
      try { const ev = JSON.parse(line); if (ev.type === 'result') { subtype = String(ev.subtype || ''); if (!ev.is_error) result = String(ev.result || '').trim(); } } catch { /* not JSON */ }
    };
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => { buf += d; const lines = buf.split('\n'); buf = lines.pop(); lines.forEach(take); });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', () => { clearTimeout(timer); take(buf); resolve({ result, subtype, err: err.trim().slice(-200) }); });
    child.on('error', () => resolve({ result: '', subtype: 'missing', err: 'Claude is not installed on my VM yet.' }));
  });
}

const tally = (usage, tier) => { usage.byTier = usage.byTier || {}; usage.byTier[tier] = (usage.byTier[tier] || 0) + 1; };

// Asks Haiku (one tiny turn, no tools) which model a vague message needs.
async function classify(text) {
  const out = await claudeCall(router.classifierPrompt(text), router.MODELS.haiku, { allowed: [], maxTurns: 1, timeoutMs: 30000, quiet: true });
  return router.parseVerdict(out.result);
}

// Runs one job. The router picks the model; if a cheaper model could not
// finish (ran out of steps, or failed), he tries once more one tier up, never
// above the cap Raven set. Resolves { text, tier, why } .
function runClaude(prompt, mode = 'media', off = [], opts = {}) {
  const job = chain.then(async () => {
    const day = new Date().toISOString().slice(0, 10);
    const usage = read('usage.json', { day, runs: 0 });
    if (usage.day !== day) { usage.day = day; usage.runs = 0; usage.byTier = {}; }
    if (usage.runs >= MAX_RUNS) return { text: `I've used my ${MAX_RUNS} runs for today. Raise MAX_RUNS_PER_DAY if you want more.`, tier: '', why: '' };
    usage.runs += 1;
    busy = true;
    try {
      const r = opts.router || {};
      const text = opts.text || prompt;
      let verdict = '';
      if (!opts.think && !router.TIERS.includes(r.model) && router.rules(text) === 'unsure') {
        verdict = await classify(text);
        tally(usage, 'haiku');
      }
      let { tier, why } = router.choose({ text, think: Boolean(opts.think), fixed: r.model || 'auto', max: r.maxTier || 'opus', verdict });
      // Film jobs touch real files, so they never run on the cheapest model.
      if (mode === 'media' && tier === 'haiku') { tier = 'sonnet'; why = 'film job'; }
      const allowed = allowedFor(mode, off);
      live(`Working on: ${clip(prompt.split('\n')[0], 120)} (${mode}, ${router.LABEL[tier]}: ${why})`);
      let out;
      for (;;) {
        tally(usage, tier);
        write('usage.json', usage);
        out = await claudeCall(prompt, router.MODELS[tier], { allowed, maxTurns: tier === 'opus' ? 25 : 15 });
        if (out.result || out.subtype === 'missing') break;
        const up = router.stepUp(tier, r.maxTier || 'opus');
        if (!up) break;
        live(`${router.LABEL[tier]} could not finish that, trying ${router.LABEL[up]}`);
        tier = up;
        why = 'a smaller model could not finish';
      }
      write('usage.json', usage);
      if (out.result) { live('Finished.'); return { text: out.result, tier, why }; }
      live('Could not finish that run.');
      return { text: out.subtype === 'missing' ? out.err : `I couldn't finish that${out.err ? ` (${out.err})` : ''}. Is Claude signed in on my VM?`, tier, why };
    } finally {
      busy = false;
    }
  });
  chain = job.catch(() => {});
  return job;
}

function promptFor(task, context = '') {
  const history = read('history.json', []).slice(-HISTORY_SHOWN).map((h) => `${h.role}: ${h.text}`).join('\n');
  const gist = read('gist.json', {}).text;
  return `${task}${context ? `\n\n${String(context).slice(0, 4000)}` : ''}${gist ? `\n\nEarlier today, in short: ${gist}` : ''}${history ? `\n\nRecent conversation:\n${history}` : ''}`;
}
// What Roost sends about the router: { model: 'auto'|'haiku'|'sonnet'|'opus', maxTier }.
const routerCfg = (v) => ({ model: v && router.TIERS.includes(v.model) ? v.model : 'auto', maxTier: v && router.TIERS.includes(v.maxTier) ? v.maxTier : 'opus' });
const groupsOff = (v) => (Array.isArray(v) ? v.filter((g) => typeof g === 'string' && g in GROUPS) : []);

// He keeps the last 16 lines (replies up to 1500 characters, so he remembers what he
// found); older lines drop off but leave a one-line gist, so a long chat keeps its thread.
const HISTORY_SHOWN = 10;
const HISTORY_KEEP = 16;
function remember(role, text) {
  const all = [...read('history.json', []), { role, text: String(text).slice(0, 1500), at: Date.now() }];
  if (all.length > HISTORY_KEEP) {
    const dropped = all.splice(0, all.length - HISTORY_KEEP);
    const old = read('gist.json', {}).text || '';
    const add = dropped.filter((h) => h.role === 'Raven').map((h) => clip(h.text, 80)).join('; ');
    write('gist.json', { text: `${old}${old && add ? '; ' : ''}${add}`.slice(-600) });
  }
  write('history.json', all);
}

// Calls the tool myself for jobs that need no thinking (saves tokens).
function tool(...args) {
  return new Promise((resolve) => {
    const child = spawn('node', [TOOL, ...args], { env: process.env, stdio: 'ignore' });
    child.on('close', resolve);
    child.on('error', resolve);
  });
}

// ---------- what arrives ----------
async function onEvent(e) {
  live(`Heard from Roost: ${clip(e.title)}${e.body ? ` - ${clip(e.body, 90)}` : ''}`);
  const events = (fs.existsSync(path.join(STATE, 'events.jsonl')) ? fs.readFileSync(path.join(STATE, 'events.jsonl'), 'utf8').trim().split('\n') : []).filter(Boolean);
  events.push(JSON.stringify({ at: new Date().toISOString(), title: e.title, body: e.body }));
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(path.join(STATE, 'events.jsonl'), `${events.slice(-100).join('\n')}\n`);
  // A film request is the one alert he acts on, and he only asks Raven first.
  const m = e.title === 'Movie request' && /^(.+?) asks for (.+)$/.exec(e.body);
  if (!m) return;
  const askId = `movie-${lib.cleanName(e.tag).replace(/\s/g, '-').slice(0, 30) || Date.now()}`;
  const pending = read('pending.json', {});
  pending[askId] = { who: m[1], title: m[2] };
  write('pending.json', pending);
  await tool('ask', askId, `${m[1]} asked for ${m[2]}. Want me to find it and add it to Roostflix?`, 'Yes, find it', 'No');
}

async function onAnswer({ askId, choice }) {
  live(`Raven answered ${clip(askId, 40)}: ${clip(choice, 30)}`);
  const yes = /^(yes|download)/i.test(choice);
  const pending = read('pending.json', {});
  const approvals = read('approvals.json', {});
  const m = /^(entitled|size)-(.+)$/.exec(askId);
  if (m) {
    const [, kind, job] = m;
    if (!lib.jobIdOk(job)) return;
    if (!yes) { await tool('job', job, 'Failed'); await tool('log', `Cancelled ${job} at Raven's word.`); return; }
    approvals[askId] = new Date().toISOString();
    write('approvals.json', approvals);
    const meta = read(path.join('jobs', `${job}.json`), null);
    if (meta) await tool('fetch', meta.link, '--job', job, '--name', meta.name, '--year', meta.year || '', '--genre', meta.genre || '', '--kind', meta.kind, '--requester', meta.requester || '');
    return;
  }
  const want = pending[askId];
  if (!want) return;
  delete pending[askId];
  write('pending.json', pending);
  if (!yes) { await tool('log', `Not fetching ${want.title}: Raven said no.`); return; }
  const reply = await runClaude(promptFor(`Raven said yes to this request: ${want.who} asked for "${want.title}". Follow your CLAUDE.md job steps: check the library, find an open source, and fetch it with --requester ${want.who}. If no open source exists, say so with cockerel-tool log and ask Raven what to do with cockerel-tool ask.`), 'media', [], { text: 'film job', router: read('router.json', {}) });
  await tool('log', reply.text.slice(0, 900));
}

// Roost's "Update all" leaves a flag for the root-owned updater (update.sh).
const UPDATE_DIR = process.env.COCKEREL_UPDATE_DIR || '/var/lib/cockerel';
const updateStatus = () => { try { return JSON.parse(fs.readFileSync(path.join(UPDATE_DIR, 'update-status.json'), 'utf8')); } catch { return null; } };

function status() {
  const df = spawnSync('df', ['--output=pcent', '/'], { encoding: 'utf8' }).stdout || '';
  return {
    busy,
    vpn: spawnSync('ip', ['link', 'show', 'wg0'], { stdio: 'ignore' }).status === 0 ? 'up' : 'down',
    cpu: Math.min(100, Math.round((os.loadavg()[0] / os.cpus().length) * 100)),
    memMb: Math.round((os.totalmem() - os.freemem()) / 1048576),
    diskPct: Number((df.match(/(\d+)%/) || [])[1]) || 0,
    runsToday: (read('usage.json', {}).runs) || 0,
    byTier: (read('usage.json', {}).day === new Date().toISOString().slice(0, 10) ? read('usage.json', {}).byTier : null) || {},
    maxRuns: MAX_RUNS,
    downloads: Object.values(read('progress.json', {})).filter((d) => Date.now() - d.at < 60000).map((d) => ({ name: d.name, pct: d.pct, detail: d.detail })),
    updateApi: 2, // 2 = understands {action:'check'}
    update: updateStatus(),
  };
}

const server = http.createServer(async (req, res) => {
  // The live page is for the VM's own screen only: no signature, but only from this machine.
  if (req.method === 'GET' && (req.url === '/live' || req.url === '/live/events')) {
    if (!isLocal(req)) { res.writeHead(403); return res.end(); }
    if (req.url === '/live/events') return stream(req, res, status);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(fs.readFileSync(path.join(__dirname, 'live.html')));
  }
  const reply = (code, data) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  let body = '';
  try {
    for await (const c of req) { body += c; if (body.length > 64 * 1024) return reply(413, { error: 'too big' }); }
  } catch { return reply(400, { error: 'bad request' }); }
  if (!lib.verify(SECRET, req.headers, body)) return reply(401, { error: 'not signed' });
  let data = {};
  try { data = body ? JSON.parse(body) : {}; } catch { return reply(400, { error: 'bad json' }); }
  try {
    if (req.method === 'GET' && req.url === '/status') return reply(200, status());
    if (req.method !== 'POST') return reply(404, { error: 'no such thing' });
    if (req.url === '/chat') {
      const text = String(data.text || '').slice(0, 2000);
      live('Raven said something in chat');
      remember('Raven', text);
      const off = groupsOff(data.toolsOff);
      const cfg = routerCfg(data.router);
      write('router.json', cfg);
      write('toolsoff.json', off);
      const out = await runClaude(promptFor(`Raven says: ${text}`, data.context), modeFor(text), off, { text, think: data.think === true, router: cfg });
      remember('Cockerel', out.text);
      return reply(200, { reply: out.text, model: out.tier, why: out.why });
    }
    if (req.url === '/run') {
      live('Roost woke me for a scheduled job');
      // A job Roost woke him for (the morning brief, a repeating job). No chat history.
      // A job that runs by itself uses Sonnet unless Raven pinned a model or asked for more.
      const cfg = routerCfg(data.router);
      const pinned = router.TIERS.includes(cfg.model) ? cfg.model : 'sonnet';
      const out = await runClaude(`${String(data.prompt || '').slice(0, 3000)}${data.context ? `\n\n${String(data.context).slice(0, 4000)}` : ''}`, 'scheduled', groupsOff(data.toolsOff), { text: 'scheduled', think: data.think === true, router: { ...cfg, model: pinned } });
      return reply(200, { reply: out.text, model: out.tier, why: out.why });
    }
    if (req.url === '/handoff') {
      // His own chat run asks for a film job. It runs as a separate, web-free run after this one.
      const text = String(data.text || '').slice(0, 600).trim();
      if (!text) return reply(400, { error: 'say what the film job is' });
      reply(200, { ok: true });
      live('Handing a film job to my download self');
      return void runClaude(promptFor(`Film job handed over from your chat run: ${text}\nFollow your film steps.`), 'media', read('toolsoff.json', []), { text: 'film job', router: read('router.json', {}) })
        .then((out) => tool('log', out.text.slice(0, 900))).catch(() => {});
    }
    if (req.url === '/review') {
      // Second opinion (Haiku, one turn, no tools) on an outward action before it reaches Raven's tap.
      const action = String(data.action || '').slice(0, 300);
      const asked = [...read('history.json', [])].reverse().find((h) => h.role === 'Raven');
      if (!action || !asked || Date.now() - (asked.at || 0) > 30 * 60 * 1000) return reply(200, { ok: true }); // nothing recent to compare with
      const q = `Raven asked his assistant: <<${asked.text.slice(0, 500)}>>\nThe assistant now wants to do this: <<${action}>>\nDoes the action match what Raven asked for, or an obvious part of it? Answer "OK" or "DIFFERENT: <short reason>".`;
      const out = await claudeCall(q, router.MODELS.haiku, { allowed: [], maxTurns: 1, timeoutMs: 30000, quiet: true });
      const ok = !/^\s*DIFFERENT/i.test(out.result);
      return reply(200, ok ? { ok: true } : { ok: false, why: out.result.replace(/^\s*DIFFERENT:?\s*/i, '').slice(0, 160) });
    }
    if (req.url === '/update') {
      const action = data.action === 'check' ? 'check' : 'apply';
      live(action === 'check' ? 'Checking for a newer version of myself' : 'Roost asked me to update myself');
      fs.mkdirSync(UPDATE_DIR, { recursive: true });
      fs.writeFileSync(path.join(UPDATE_DIR, 'update-request'), JSON.stringify({ action }));
      return reply(200, { ok: true });
    }
    if (req.url === '/event') { reply(200, { ok: true }); return void onEvent(data).catch(() => {}); }
    if (req.url === '/answer') { reply(200, { ok: true }); return void onAnswer(data).catch(() => {}); }
    return reply(404, { error: 'no such thing' });
  } catch (err) {
    return reply(500, { error: String(err.message).slice(0, 200) });
  }
});

if (require.main === module) {
  if (SECRET.length < 24) { console.error('COCKEREL_SECRET must be at least 24 characters.'); process.exit(1); }
  fs.mkdirSync(STATE, { recursive: true });
  server.listen(PORT, BIND, () => { console.log(`Cockerel listening on ${BIND}:${PORT}`); live(`Awake and listening on port ${PORT}`); });
}

module.exports = { server, modeFor, allowedFor, remember, promptFor };
