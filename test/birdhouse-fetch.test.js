'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { allowedUrl, extractPrice, fetchPrice, FetchError } = require('../src/birdhouse');

test('only plain https product pages on the shop list are allowed', () => {
  for (const ok of ['https://www.wickes.co.uk/Wickes-Pine/p/123', 'https://wickes.co.uk/x', 'https://www.diy.com/departments/x/1_BQ.prd']) assert.ok(allowedUrl(ok), ok);
  for (const bad of ['http://www.wickes.co.uk/x', 'https://evil.example/www.wickes.co.uk', 'https://wickes.co.uk.evil.example/', 'https://www.wickes.co.uk:8443/x',
    'https://user:pw@www.wickes.co.uk/x', 'https://127.0.0.1/', 'https://192.168.4.35:8080/', 'file:///etc/passwd', 'javascript:alert(1)', '', 'nonsense']) {
    assert.equal(allowedUrl(bad), null, bad);
  }
});

test('the price is read from schema.org data, however it is nested', () => {
  const ld = (o) => `<html><script type="application/ld+json">${JSON.stringify(o)}</script></html>`;
  assert.deepEqual(extractPrice(ld({ '@type': 'Product', offers: { '@type': 'Offer', price: '24.50', priceCurrency: 'GBP' } })), { price: 24.5, currency: 'GBP' });
  assert.deepEqual(extractPrice(ld({ '@graph': [{ '@type': 'WebSite' }, { '@type': 'Product', offers: [{ price: 7.99, priceCurrency: 'GBP' }] }] })), { price: 7.99, currency: 'GBP' });
  assert.deepEqual(extractPrice(ld({ offers: { '@type': 'AggregateOffer', lowPrice: '3.2', priceCurrency: 'GBP' } })), { price: 3.2, currency: 'GBP' });
});

test('or from the product price tags, and a page without one gives nothing', () => {
  assert.deepEqual(extractPrice('<meta property="product:price:amount" content="12.00"><meta property="product:price:currency" content="GBP">'), { price: 12, currency: 'GBP' });
  assert.deepEqual(extractPrice('<meta content="5.5" itemprop="price">'), { price: 5.5, currency: null });
  assert.equal(extractPrice('<html><body>Sorry, nothing here</body></html>'), null);
  assert.equal(extractPrice('<script type="application/ld+json">{ not json</script>'), null);
  assert.equal(extractPrice('<script type="application/ld+json">{"offers":{"price":"-3"}}</script>'), null);
  assert.equal(extractPrice('<script type="application/ld+json">{"offers":{"price":"999999"}}</script>'), null);
});

const page = (body, init = {}) => new Response(body, { status: 200, headers: { 'Content-Type': 'text/html' }, ...init });
const priced = (p, cur = 'GBP') => page(`<script type="application/ld+json">{"offers":{"price":"${p}","priceCurrency":"${cur}"}}</script>`);

test('fetching reads one page and returns its price', async () => {
  const seen = [];
  const out = await fetchPrice('https://www.wickes.co.uk/p/1', async (url, init) => { seen.push([String(url), init.redirect]); return priced('18.75'); });
  assert.deepEqual(out, { price: 18.75, shop: 'wickes.co.uk' });
  assert.deepEqual(seen, [['https://www.wickes.co.uk/p/1', 'manual']]);
});

test('a redirect is followed only to another listed shop address, and not forever', async () => {
  const go = (loc) => new Response(null, { status: 302, headers: { Location: loc } });
  const ok = await fetchPrice('https://wickes.co.uk/a', async (url) => (String(url).endsWith('/a') ? go('/b') : priced('4')));
  assert.equal(ok.price, 4);
  await assert.rejects(fetchPrice('https://wickes.co.uk/a', async () => go('https://evil.example/x')), /somewhere else/);
  await assert.rejects(fetchPrice('https://wickes.co.uk/a', async () => go('http://127.0.0.1/')), /somewhere else/);
  await assert.rejects(fetchPrice('https://wickes.co.uk/a', async () => go('/a')), /circles/);
});

test('every way it can fail ends in a plain message to type the price in', async () => {
  await assert.rejects(fetchPrice('https://evil.example/x', async () => priced('1')), FetchError);
  await assert.rejects(fetchPrice('https://www.diy.com/x', async () => { throw new Error('down'); }), /Couldn’t reach/);
  await assert.rejects(fetchPrice('https://www.diy.com/x', async () => page('', { status: 403 })), /403/);
  await assert.rejects(fetchPrice('https://www.diy.com/x', async () => page('<p>no price</p>')), /Type it in/);
  await assert.rejects(fetchPrice('https://www.diy.com/x', async () => priced('9', 'USD')), /USD, not pounds/);
});

test('a huge page is cut off, not read to the end', async () => {
  let pulled = 0;
  const body = new ReadableStream({ pull(c) { pulled += 1; c.enqueue(new Uint8Array(500000)); if (pulled > 50) c.close(); } });
  await assert.rejects(fetchPrice('https://www.diy.com/x', async () => new Response(body, { status: 200 })), /Type it in/);
  assert.ok(pulled < 10, `stopped early (${pulled} pulls)`);
});
