'use strict';

// Birdhouse's optional "Design with Claude" button. It sends one request to
// the Anthropic API with the key an admin saved, and reads the design back.
// Off unless a key is saved. Nothing here runs in the background.

// The address is fixed; baseUrl exists only so tests can point at a stand-in.
const API = 'https://api.anthropic.com';
const TIMEOUT_MS = 300000;

// What each tier uses. Prices are $ per million tokens (in / out); `out` is a
// typical reply size in tokens including thinking, used only for the estimate
// shown before asking. The real cost is worked out from the usage the API reports.
const TIERS = {
  quick: { label: 'Quick', model: 'claude-haiku-5-5', effort: 'low', price: [0.1, 0.5], out: 3000, hint: 'A fast first draft.' },
  balanced: { label: 'Balanced', model: 'claude-sonnet-5-5', effort: 'medium', price: [2, 10], out: 8000, hint: 'Good for most projects.' },
  creative: { label: 'Creative', model: 'claude-opus-5-5', effort: 'high', price: [4, 20], out: 20000, hint: 'Thinks harder about the construction.' },
  deep: { label: 'Deep', model: 'claude-opus-5-5', effort: 'xhigh', price: [4, 20], out: 40000, hint: 'Slowest and the most thorough.' },
};
const TIER_IDS = Object.keys(TIERS);
const INPUT_ESTIMATE = 2500;

const cost = (tier, input, output) => {
  const t = TIERS[tier];
  return (input * t.price[0] + output * t.price[1]) / 1e6;
};
const estimate = (tier) => cost(tier, INPUT_ESTIMATE, TIERS[tier].out);

class AiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'AiError';
    this.status = status || 502;
  }
}

// Asks for a design. messages: [{role, content}] (content is text).
//   -> { text, input, output, cost }
async function ask({ key, tier, system, messages, baseUrl = API }) {
  const t = TIERS[tier];
  if (!t) throw new AiError('Unknown tier', 400);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: t.model, max_tokens: 64000, stream: true, system, messages, output_config: { effort: t.effort } }),
    });
  } catch (err) {
    clearTimeout(timer);
    throw new AiError(err.name === 'AbortError' ? 'Claude took too long' : 'Could not reach Claude');
  }
  try {
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      let msg = '';
      try { msg = JSON.parse(body).error.message; } catch { /* not JSON */ }
      if (res.status === 401) throw new AiError('Claude did not accept the key. Check it in Admin.', 502);
      if (res.status === 429 || res.status === 529) throw new AiError('Claude is busy or the key is out of credit. Try again shortly.', 503);
      throw new AiError(`Claude refused that (${res.status})${msg ? `: ${String(msg).slice(0, 200)}` : ''}`);
    }
    let text = '';
    let input = 0;
    let output = 0;
    let stop = '';
    let buf = '';
    const dec = new TextDecoder();
    const take = (line) => {
      if (!line.startsWith('data:')) return;
      let ev;
      try { ev = JSON.parse(line.slice(5)); } catch { return; }
      if (ev.type === 'message_start') input = (ev.message.usage && ev.message.usage.input_tokens) || 0;
      else if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') text += ev.delta.text;
      else if (ev.type === 'message_delta') {
        if (ev.usage && ev.usage.output_tokens) output = ev.usage.output_tokens;
        if (ev.delta && ev.delta.stop_reason) stop = ev.delta.stop_reason;
      } else if (ev.type === 'error') throw new AiError('Claude stopped part way. Try again.');
    };
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) { take(buf.slice(0, nl).trim()); buf = buf.slice(nl + 1); }
    }
    if (buf.trim()) take(buf.trim());
    if (stop === 'refusal') throw new AiError('Claude would not design that one.');
    if (!text.trim()) throw new AiError(stop === 'max_tokens' ? 'The design ran too long. Try a lower tier or a simpler ask.' : 'Claude sent nothing back. Try again.');
    return { text, input, output, cost: cost(tier, input, output) };
  } catch (err) {
    if (err instanceof AiError) throw err;
    throw new AiError(err.name === 'AbortError' ? 'Claude took too long' : 'The connection to Claude dropped');
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { TIERS, TIER_IDS, estimate, cost, ask, AiError };
