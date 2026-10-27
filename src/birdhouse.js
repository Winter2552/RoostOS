'use strict';

// Birdhouse's "Fetch price": reads the price off one product page, only when
// someone presses the button and only if an admin has switched it on.
//
// It is best effort. It asks one page of a shop on the short list below, looks
// for the price the shop publishes for search engines (schema.org data, or the
// product price tags), and gives up quietly if the page doesn't have one; the
// person then types the price in. It never searches, never loops over a shop,
// never runs in the background, and never follows a link to any other site.

const SHOPS = ['wickes.co.uk', 'diy.com']; // and their www. forms
const MAX_BYTES = 1500000;
const MAX_HOPS = 3;
const TIMEOUT_MS = 8000;

class FetchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FetchError';
  }
}

// The page address, if it is plain https on a listed shop; otherwise null.
function allowedUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  if (u.protocol !== 'https:' || u.port || u.username || u.password) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  return SHOPS.includes(host) ? u : null;
}

const toPrice = (v) => {
  // Numbers, or text like "£1,299.00"; anything else (a minus sign, words) is not a price.
  const text = String(v).trim().replace(/^[£$€]\s*/, '').replace(/,/g, '');
  const n = typeof v === 'number' ? v : /^\d+(\.\d+)?$/.test(text) ? Number(text) : NaN;
  return Number.isFinite(n) && n > 0 && n < 10000 ? Math.round(n * 100) / 100 : null;
};

// Walks schema.org data for an offer's price.
function offerPrice(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return null;
  if (Array.isArray(node)) {
    for (const n of node) { const r = offerPrice(n, depth + 1); if (r) return r; }
    return null;
  }
  const own = toPrice(node.price !== undefined ? node.price : node.lowPrice);
  if (own) return { price: own, currency: node.priceCurrency || null };
  for (const key of ['offers', '@graph', 'mainEntity', 'itemListElement', 'item']) {
    const r = offerPrice(node[key], depth + 1);
    if (r) return r;
  }
  return null;
}

//   -> { price, currency } or null
function extractPrice(html) {
  const text = String(html || '');
  for (const m of text.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try { data = JSON.parse(m[1]); } catch { continue; }
    const hit = offerPrice(data);
    if (hit) return hit;
  }
  const tag = (re) => { const m = text.match(re); return m ? m[1] : null; };
  const meta = (name) => tag(new RegExp(`<meta[^>]+(?:property|itemprop|name)=["']${name}["'][^>]*content=["']([^"']+)["']`, 'i'))
    || tag(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|itemprop|name)=["']${name}["']`, 'i'));
  const price = toPrice(meta('product:price:amount') || meta('price') || meta('og:price:amount'));
  if (price) return { price, currency: meta('product:price:currency') || meta('priceCurrency') || meta('og:price:currency') };
  return null;
}

// Reads at most MAX_BYTES of the page.
async function readLimited(res) {
  const reader = res.body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    chunks.push(value);
    if (n > MAX_BYTES) { await reader.cancel(); break; }
  }
  return Buffer.concat(chunks).toString('utf8');
}

// fetchImpl is only swapped in by the tests.
async function fetchPrice(raw, fetchImpl = fetch) {
  let url = allowedUrl(raw);
  if (!url) throw new FetchError('Paste a product page address from Wickes or B&Q (https://www.wickes.co.uk/… or https://www.diy.com/…)');
  let res;
  for (let hop = 0; ; hop++) {
    try {
      res = await fetchImpl(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0 (compatible; Roost home server; one page when asked)' },
      });
    } catch {
      throw new FetchError('Couldn’t reach the shop. Type the price in instead.');
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      if (hop >= MAX_HOPS) throw new FetchError('The shop sent this link round in circles. Type the price in instead.');
      const next = allowedUrl(new URL(res.headers.get('location'), url).href);
      if (!next) throw new FetchError('The shop sent this link somewhere else. Type the price in instead.');
      url = next;
      continue;
    }
    break;
  }
  if (!res.ok) throw new FetchError(`The shop said ${res.status}, so I couldn’t read that page. Type the price in instead.`);
  const found = extractPrice(await readLimited(res));
  if (!found) throw new FetchError('That page doesn’t show a price I can read. Type it in instead.');
  if (found.currency && found.currency.toUpperCase() !== 'GBP') throw new FetchError(`That price is in ${found.currency}, not pounds. Type it in instead.`);
  return { price: found.price, shop: url.hostname.replace(/^www\./, '') };
}

// ---- What each person keeps: plans, workshop wood and their price book ------
// Stored on the person's own Roost account (user.birdhouse), so it follows them
// to any device and nobody else sees it. Everything is cleaned on the way in.

const model = require('../public/birdhouse-model.js');

const MAX_PLANS = 200;
const MAX_STOCK = 200;
const MAX_PRICES = 200;

const text = (v, n) => String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const mmValue = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 1 && n <= 10000 ? n : null; };

function cleanPlan(input, id, now) {
  const name = text(input && input.name, 60) || 'Untitled plan';
  return { id, name, plan: model.clean(input && input.plan), updated: now };
}

function cleanStock(list, newId) {
  const out = [];
  for (const it of Array.isArray(list) ? list.slice(0, MAX_STOCK) : []) {
    if (!it || (it.kind !== 'sheet' && it.kind !== 'timber')) continue;
    const w = mmValue(it.w); const l = mmValue(it.l); const thick = mmValue(it.thick);
    const qty = Math.round(Number(it.qty));
    if (!w || !l || !thick || !(qty >= 1 && qty <= 50)) continue;
    const id = /^[a-f0-9]{8,32}$/.test(String(it.id)) ? String(it.id) : newId();
    out.push({ id, kind: it.kind, w, l, thick, qty, note: text(it.note, 60) });
  }
  return out;
}

// A price is { p, at, src?, url? }: pounds, the day it was set, and where it was
// fetched from. Keys are a material ("sheet-18") or a material at one shop
// ("sheet-18@wickes").
function cleanPrices(map) {
  const out = {};
  for (const [k, v] of Object.entries(map && typeof map === 'object' ? map : {}).slice(0, MAX_PRICES)) {
    if (!/^[a-z0-9-]{1,40}(@[a-z]{1,10})?$/.test(k) || !v || typeof v !== 'object') continue;
    const entry = {};
    const n = Number(v.p);
    if (v.p !== undefined && v.p !== null && v.p !== '') {
      if (!(Number.isFinite(n) && n >= 0 && n <= 100000)) continue;
      entry.p = Math.round(n * 100) / 100;
      entry.at = /^\d{4}-\d{2}-\d{2}$/.test(String(v.at)) ? String(v.at) : new Date().toISOString().slice(0, 10);
      if (v.src) entry.src = text(v.src, 30);
    }
    if (typeof v.url === 'string' && allowedUrl(v.url)) entry.url = v.url.trim().slice(0, 500);
    if (Object.keys(entry).length) out[k] = entry;
  }
  return out;
}

// Units to show, and the size of stock the shops sell that plans are laid out on.
function cleanPrefs(input) {
  const i = input && typeof input === 'object' ? input : {};
  const dim = (v, fallback) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 300 && n <= 6000 ? n : fallback; };
  const a = dim(i.sheet && i.sheet[0], 2440);
  const b = dim(i.sheet && i.sheet[1], 1220);
  return { units: i.units === 'in' ? 'in' : 'mm', sheet: [Math.max(a, b), Math.min(a, b)], timber: dim(i.timber, 2400) };
}

// The person's record, made on first use.
function mine(user) {
  if (!user.birdhouse) user.birdhouse = { plans: [], stock: [], prices: {}, prefs: cleanPrefs() };
  if (!user.birdhouse.prefs) user.birdhouse.prefs = cleanPrefs();
  return user.birdhouse;
}

module.exports = { allowedUrl, extractPrice, fetchPrice, FetchError, SHOPS, cleanPlan, cleanStock, cleanPrices, cleanPrefs, mine, MAX_PLANS };
