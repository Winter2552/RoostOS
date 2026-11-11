'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const router = require('../cockerel-vm/router');
const { modeFor, allowedFor } = require('../cockerel-vm/service');

test('quick jobs go to Haiku, deep work to Opus, the rest to Sonnet', () => {
  assert.equal(router.choose({ text: 'Remind me on Thursday to renew the car tax' }).tier, 'haiku');
  assert.equal(router.choose({ text: 'Research the best heat pumps and compare running costs for a 3 bed house' }).tier, 'opus');
  assert.equal(router.choose({ text: 'Why is the sky blue?' }).tier, 'sonnet');
  assert.equal(router.choose({ text: 'Plan a trip to Lisbon' }).tier, 'opus');
});

test('Think harder, a pinned model and the cap are all respected', () => {
  assert.equal(router.choose({ text: 'hi', think: true }).tier, 'opus');
  assert.equal(router.choose({ text: 'hi', think: true, max: 'sonnet' }).tier, 'sonnet', 'never above the cap');
  assert.equal(router.choose({ text: 'Remind me to x', fixed: 'opus' }).tier, 'opus');
  assert.equal(router.choose({ text: 'Research everything', fixed: 'haiku' }).tier, 'haiku');
  assert.equal(router.choose({ text: 'Research x', fixed: 'opus', max: 'haiku' }).tier, 'haiku');
});

test('an unclear message uses his own call, and falls back to Sonnet', () => {
  const vague = 'I have been thinking about what to do with the garden and the shed and the old fence at the back';
  assert.equal(router.rules(vague), 'unsure');
  assert.equal(router.choose({ text: vague, verdict: 'haiku' }).tier, 'haiku');
  assert.equal(router.choose({ text: vague, verdict: 'opus', max: 'sonnet' }).tier, 'sonnet');
  assert.equal(router.choose({ text: vague, verdict: '' }).tier, 'sonnet');
  assert.equal(router.parseVerdict('Sonnet.'), 'sonnet');
  assert.equal(router.parseVerdict('I think maybe lots'), '');
  assert.ok(router.classifierPrompt('x"""y').includes('haiku'));
});

test('a model that cannot finish is retried one tier up, within the cap', () => {
  assert.equal(router.stepUp('haiku'), 'sonnet');
  assert.equal(router.stepUp('sonnet'), 'opus');
  assert.equal(router.stepUp('opus'), null);
  assert.equal(router.stepUp('sonnet', 'sonnet'), null);
});

test('only a plain film request goes to the download run; mixed ones hand off', () => {
  assert.equal(modeFor('Find Sintel and add it to Roostflix'), 'media');
  assert.equal(modeFor('Which Blender film is best, and then get it for Sam?'), 'assistant');
  assert.equal(modeFor('Remind me to download the thing'), 'assistant');
  const chat = allowedFor('assistant');
  assert.ok(chat.includes('Bash(cockerel-tool handoff:*)'));
  assert.ok(chat.includes('WebSearch') && !chat.some((t) => /cockerel-tool (fetch|find|retry):/.test(t)), 'web and downloads never share a run');
  const film = allowedFor('media');
  assert.ok(film.includes('Bash(cockerel-tool retry:*)') && !film.includes('WebSearch'));
  assert.ok(!allowedFor('scheduled').some((t) => /handoff|routine|retry/.test(t)), 'a job that runs alone cannot start films or change routines');
  assert.ok(!allowedFor('assistant', ['nest', 'watching']).some((t) => /nest|watching/.test(t)), 'Admin switches turn them off');
});

test('a longer chat keeps its thread', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cockerel-hist-'));
  const { spawnSync } = require('child_process');
  const run = spawnSync(process.execPath, ['-e', `
    process.env.COCKEREL_HOME = ${JSON.stringify(home)};
    const s = require(${JSON.stringify(path.join(__dirname, '../cockerel-vm/service'))});
    for (let i = 0; i < 12; i++) { s.remember('Raven', 'question ' + i); s.remember('Cockerel', 'answer ' + i); }
    console.log(s.promptFor('Raven says: next'));`], { encoding: 'utf8' });
  fs.rmSync(home, { recursive: true, force: true });
  assert.match(run.stdout, /Earlier today, in short: .*question 0/);
  assert.match(run.stdout, /Raven: question 11/);
  assert.match(run.stdout, /Cockerel: answer 11/);
});

test('the eval cases are well formed and cover every model', () => {
  const { CASES } = require('../cockerel-vm/eval');
  assert.ok(CASES.length >= 8);
  for (const c of CASES) assert.ok(c.name && c.say, c.name);
  assert.deepEqual([...new Set(CASES.map((c) => c.model).filter(Boolean))].sort(), ['haiku', 'opus', 'sonnet']);
  // The router agrees with what the cases expect.
  for (const c of CASES.filter((x) => x.model && typeof x.say === 'string')) assert.equal(router.choose({ text: c.say }).tier, c.model, c.name);
});
