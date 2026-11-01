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

const HOME = process.env.COCKEREL_HOME || path.join(os.homedir(), 'cockerel');
const STATE = path.join(HOME, 'state');
const SECRET = process.env.COCKEREL_SECRET || '';
const PORT = Number(process.env.PORT) || 7070;
const BIND = process.env.BIND || '0.0.0.0';
const MAX_RUNS = Number(process.env.MAX_RUNS_PER_DAY) || 60;
// Sonnet by default: it uses much less of the Claude allowance than Opus.
const MODEL = process.env.COCKEREL_MODEL || 'claude-sonnet-5-5';
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
  web: [],
  files: ['send'],
  memory: ['remember', 'memories', 'forget'],
  tasks: ['task', 'tasks', 'done'],
  reminders: ['remind', 'reminders', 'cancel'],
  jobs: ['schedule', 'schedules', 'unschedule'],
  notify: ['notify'],
  calendar: ['calendar'],
  email: ['inbox'],
};
const TOOLS = {
  media: ['events', 'library', 'find', 'fetch', 'ask', 'log', 'job'],
  assistant: ['events', 'ask', 'log', 'send', 'remember', 'memories', 'forget', 'task', 'tasks', 'done', 'remind', 'reminders', 'cancel', 'schedule', 'schedules', 'unschedule', 'notify', 'calendar', 'inbox'],
  // A job that runs by itself reads and reports, but cannot start new jobs or change his notes.
  scheduled: ['events', 'log', 'send', 'notify', 'memories', 'tasks', 'reminders', 'schedules', 'calendar', 'inbox'],
};
const MEDIA_WORDS = /\b(movies?|films?|tv shows?|series|episodes?|roostflix|jellyfin|download|downloads|torrent)\b/i;
const modeFor = (text) => (MEDIA_WORDS.test(text) ? 'media' : 'assistant');
function allowedFor(mode, off = []) {
  const blocked = new Set(off.flatMap((g) => GROUPS[g] || []));
  const tools = TOOLS[mode].filter((c) => !blocked.has(c)).map((c) => `Bash(cockerel-tool ${c}:*)`);
  return [...(mode !== 'media' && !off.includes('web') ? WEB : []), ...tools];
}

function runClaude(prompt, mode = 'media', off = []) {
  const job = chain.then(async () => {
    const day = new Date().toISOString().slice(0, 10);
    const usage = read('usage.json', { day, runs: 0 });
    if (usage.day !== day) { usage.day = day; usage.runs = 0; }
    if (usage.runs >= MAX_RUNS) return `I've used my ${MAX_RUNS} runs for today. Raise MAX_RUNS_PER_DAY if you want more.`;
    usage.runs += 1;
    write('usage.json', usage);
    busy = true;
    try {
      return await new Promise((resolve) => {
        const args = ['-p', prompt, '--model', MODEL, '--output-format', 'json', '--max-turns', '15', '--allowedTools', ...allowedFor(mode, off)];
        const child = spawn('claude', args, { cwd: HOME, env: { ...process.env, PATH: `${path.dirname(TOOL)}:${process.env.PATH}` } });
        let out = '';
        let err = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), RUN_TIMEOUT_MS);
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        child.on('close', () => {
          clearTimeout(timer);
          try { resolve(String(JSON.parse(out).result || '').trim() || 'Done.'); } catch { resolve(`I couldn't finish that${err ? ` (${err.trim().slice(-200)})` : ''}. Is Claude signed in on my VM?`); }
        });
        child.on('error', () => resolve('Claude is not installed on my VM yet.'));
      });
    } finally {
      busy = false;
    }
  });
  chain = job.catch(() => {});
  return job;
}

function promptFor(task, context = '') {
  const history = read('history.json', []).slice(-6).map((h) => `${h.role}: ${h.text}`).join('\n');
  return `${task}${context ? `\n\n${String(context).slice(0, 4000)}` : ''}${history ? `\n\nRecent conversation:\n${history}` : ''}`;
}
const groupsOff = (v) => (Array.isArray(v) ? v.filter((g) => typeof g === 'string' && g in GROUPS) : []);

const remember = (role, text) => write('history.json', [...read('history.json', []), { role, text: String(text).slice(0, 600) }].slice(-12));

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
    if (meta) await tool('fetch', meta.link, '--job', job, '--name', meta.name, '--year', meta.year || '', '--kind', meta.kind, '--requester', meta.requester || '');
    return;
  }
  const want = pending[askId];
  if (!want) return;
  delete pending[askId];
  write('pending.json', pending);
  if (!yes) { await tool('log', `Not fetching ${want.title}: Raven said no.`); return; }
  const reply = await runClaude(promptFor(`Raven said yes to this request: ${want.who} asked for "${want.title}". Follow your CLAUDE.md job steps: check the library, find an open source, and fetch it with --requester ${want.who}. If no open source exists, say so with cockerel-tool log and ask Raven what to do with cockerel-tool ask.`));
  await tool('log', reply.slice(0, 900));
}

function status() {
  const df = spawnSync('df', ['--output=pcent', '/'], { encoding: 'utf8' }).stdout || '';
  return {
    busy,
    vpn: spawnSync('ip', ['link', 'show', 'wg0'], { stdio: 'ignore' }).status === 0 ? 'up' : 'down',
    cpu: Math.min(100, Math.round((os.loadavg()[0] / os.cpus().length) * 100)),
    memMb: Math.round((os.totalmem() - os.freemem()) / 1048576),
    diskPct: Number((df.match(/(\d+)%/) || [])[1]) || 0,
    runsToday: (read('usage.json', {}).runs) || 0,
  };
}

const server = http.createServer(async (req, res) => {
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
      remember('Raven', text);
      const out = await runClaude(promptFor(`Raven says: ${text}`, data.context), modeFor(text), groupsOff(data.toolsOff));
      remember('Cockerel', out);
      return reply(200, { reply: out });
    }
    if (req.url === '/run') {
      // A job Roost woke him for (the morning brief, a repeating job). No chat history.
      const out = await runClaude(`${String(data.prompt || '').slice(0, 3000)}${data.context ? `\n\n${String(data.context).slice(0, 4000)}` : ''}`, 'scheduled', groupsOff(data.toolsOff));
      return reply(200, { reply: out });
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
  server.listen(PORT, BIND, () => console.log(`Cockerel listening on ${BIND}:${PORT}`));
}

module.exports = { server, modeFor, allowedFor };
