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

module.exports = { allowedUrl, extractPrice, fetchPrice, FetchError, SHOPS };
