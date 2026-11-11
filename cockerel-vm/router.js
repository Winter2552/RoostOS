'use strict';

// Cockerel's model router. For each message he picks the cheapest Claude model
// that will do the job well: Haiku for quick tool jobs, Sonnet for everyday
// help, Opus for deep research and planning. Rules decide the obvious cases
// for free; only an unclear message costs one tiny Haiku call to decide.
// Pure functions, no packages, so it can be tested.

const TIERS = ['haiku', 'sonnet', 'opus'];

const MODELS = {
  haiku: process.env.COCKEREL_MODEL_HAIKU || 'claude-haiku-5-5',
  sonnet: process.env.COCKEREL_MODEL_SONNET || process.env.COCKEREL_MODEL || 'claude-sonnet-5-5',
  opus: process.env.COCKEREL_MODEL_OPUS || 'claude-opus-5-5',
};

// Quick jobs that are one tool call: a reminder, a task, a note, a lookup.
const QUICK = /^\s*(please\s+)?(remind me|set (a )?(reminder|timer)|add (a )?task|add .{1,60} to (my )?(tasks?|to-?do)|remember (that|this)?|forget |mark .{1,40} (as )?done|cancel (the |my )?reminder|what('| i)s on (my )?(calendar|tasks?)|what time|show (my )?(tasks|reminders|notes)|(is|are) .{1,60} (on|in) roostflix)/i;

// Work that rewards a stronger model: research, comparing, planning, writing.
const DEEP = /\b(research|compare|comparison|analy[sz]e|investigate|itinerary|plan (a|my|the|our)|trip|report|pros and cons|recommend|in depth|step by step|strategy|budget|summari[sz]e (this|these|the) (document|pdf|article|paper)|write (a|an|the) (guide|plan|report|essay|proposal))\b/i;

// Small talk and simple questions are fine on Sonnet; nothing to match.
const clean = (s) => String(s || '').trim();

// 'quick' | 'deep' | 'unsure' for a message, without calling any model.
function rules(text) {
  const t = clean(text);
  if (QUICK.test(t) && t.length < 200) return 'quick';
  if (DEEP.test(t) || t.length > 600) return 'deep';
  if (t.length < 70 && !/[?]/.test(t)) return 'quick';
  if (t.length < 70) return 'sonnet';
  return 'unsure';
}

const rank = (tier) => Math.max(0, TIERS.indexOf(tier));

// Never above the cap Raven set in Admin.
function cap(tier, max) {
  return TIERS[Math.min(rank(tier), rank(TIERS.includes(max) ? max : 'opus'))];
}

// The tier to try. `think` is the Think harder switch; `fixed` is a model
// Raven pinned in Admin ('auto' lets Cockerel decide); `verdict` is what the
// Haiku classifier said for an unclear message.
function choose({ text, think = false, fixed = 'auto', max = 'opus', verdict = '' }) {
  if (TIERS.includes(fixed)) return { tier: cap(fixed, max), why: 'set in Admin' };
  if (think) return { tier: cap('opus', max), why: 'you asked me to think harder' };
  const r = rules(text);
  if (r === 'quick') return { tier: 'haiku', why: 'quick job' };
  if (r === 'deep') return { tier: cap('opus', max), why: 'deep research or planning' };
  if (r === 'sonnet') return { tier: 'sonnet', why: 'everyday help' };
  if (TIERS.includes(verdict)) return { tier: cap(verdict, max), why: 'my own call' };
  return { tier: 'sonnet', why: 'everyday help' };
}

// Prompt for the Haiku classifier: one short turn, no tools.
function classifierPrompt(text) {
  return `Pick the cheapest Claude model that can do this request well. Answer with exactly one word: haiku (one simple tool action or lookup), sonnet (normal questions, short writing, small tasks, mixed requests) or opus (hard reasoning, long research, comparing many options, careful planning). Request:\n"""\n${clean(text).slice(0, 600)}\n"""`;
}

// The classifier's one word, or '' when it said anything else.
function parseVerdict(out) {
  const w = (/\b(haiku|sonnet|opus)\b/i.exec(String(out || '')) || [])[1];
  return w ? w.toLowerCase() : '';
}

// One tier up when a run did not finish; null at the top.
function stepUp(tier, max = 'opus') {
  const next = TIERS[rank(tier) + 1];
  return next && rank(next) <= rank(TIERS.includes(max) ? max : 'opus') ? next : null;
}

const LABEL = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' };

module.exports = { TIERS, MODELS, LABEL, rules, choose, cap, classifierPrompt, parseVerdict, stepUp };
