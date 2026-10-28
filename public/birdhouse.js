'use strict';

// Birdhouse: plan a build. A home screen shows every project with a small
// picture; opening one gives the drawings, cut list, sheet layout and cost.
// Everything is worked out in the browser (see birdhouse-model.js). Each
// person's projects, workshop wood and prices are kept on their own Roost
// login, so they follow them to any device. Nothing else is sent anywhere and
// nothing runs in the background.

(() => {
  const model = window.birdhouseModel;
  const NS = 'http://www.w3.org/2000/svg';
  const OLD_PLAN = 'roost-birdhouse'; // before plans lived on the account
  const OLD_PRICES = 'roost-birdhouse-prices';
  const COUNTS = new Set(['shelves', 'doors']);
  // d is the plan on show; by remembers the sizes last used for each project
  // while this plan is open. id is the saved project (null before it exists).
  const S = {
    d: model.defaults('bookshelf'), by: {}, id: null, name: '', built: false, card: null, cardButton: null, fields: {}, view: 'front', yaw: 0.6, pitch: 0.35,
    data: { plans: [], stock: [], prices: {}, prefs: { units: 'mm', sheet: [2440, 1220], timber: 2400 } }, loaded: false, screen: 'home', ask: 0,
  };

  const $ = (sel) => document.querySelector(sel);
  const svg = (tag, attrs = {}, text) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const h = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'text') n.textContent = v;
      else if (k === 'value') n.value = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c != null) n.append(c);
    return n;
  };
  const info = () => model.info(S.d);
  const go = (path) => { location.hash = `#/birdhouse${path ? `/${path}` : ''}`; };

  // ---------- units ----------
  // Sizes are millimetres inside; inches are only how they are shown and typed.
  const prefs = () => S.data.prefs;
  const inch = () => prefs().units === 'in';
  const unit = () => (inch() ? 'in' : 'mm');
  function inches(mm) {
    const sixteenths = Math.round((mm / 25.4) * 16);
    const whole = Math.floor(sixteenths / 16);
    let n = sixteenths % 16;
    let d = 16;
    while (n && n % 2 === 0) { n /= 2; d /= 2; }
    return `${n ? `${whole ? `${whole} ` : ''}${n}/${d}` : whole}"`;
  }
  const fmt = (mm) => (inch() ? inches(mm) : String(mm));
  const fmtU = (mm) => (inch() ? inches(mm) : `${mm} mm`);
  const toMm = (v) => Math.round(Number(v) * (inch() ? 25.4 : 1));
  const fromMm = (mm) => (inch() ? String(Math.round((mm / 25.4) * 100) / 100) : String(mm));
  const spoken = (mm) => (inch() ? `${Math.round((mm / 25.4) * 10) / 10} inches` : `${mm} millimetres`);

  // ---------- what is kept on the account ----------
  const today = () => new Date().toISOString().slice(0, 10);
  const money = (n) => `£${n.toFixed(2)}`;
  // Runs fn a moment after the last call; flush() runs it now if one is waiting.
  const later = (fn, ms) => {
    let t = 0;
    const run = () => { clearTimeout(t); t = setTimeout(() => { t = 0; fn(); }, ms); };
    run.flush = () => { if (!t) return undefined; clearTimeout(t); t = 0; return fn(); };
    return run;
  };
  const savePrices = later(() => api('PUT', '/api/birdhouse/prices', { prices: S.data.prices }).catch(() => {}), 600);
  const saveStock = later(() => api('PUT', '/api/birdhouse/stock', { stock: S.data.stock }).then((r) => { S.data.stock = r.stock; }).catch(() => {}), 600);
  const savePrefs = later(() => api('PUT', '/api/birdhouse/prefs', prefs()).catch(() => {}), 400);

  // What the layout is given: the wood on hand and the sizes shops sell.
  const lay = () => ({ stock: S.data.stock, sheet: prefs().sheet, timber: prefs().timber });
  const layout = () => model.layout(S.d, lay());
  const materials = () => model.materials(S.d, lay());

  async function load() {
    S.data = await api('GET', '/api/birdhouse/data');
    // Anything kept on this device by the first version moves to the account once.
    try {
      const mine = JSON.parse(localStorage.getItem(OLD_PLAN) || 'null');
      if (mine && !S.data.plans.length) {
        const d = model.clean(mine.d || mine);
        S.data.plans.push(await api('POST', '/api/birdhouse/plans', { name: model.info(d).name, plan: d }));
      }
      const old = JSON.parse(localStorage.getItem(OLD_PRICES) || 'null');
      if (old && !Object.keys(S.data.prices).length) {
        const moved = {};
        for (const [k, v] of Object.entries(old)) if (v && typeof v === 'object') moved[k] = { p: v.p, at: v.at, src: v.src, url: v.url };
        S.data.prices = (await api('PUT', '/api/birdhouse/prices', { prices: moved })).prices;
      }
      localStorage.removeItem(OLD_PLAN);
      localStorage.removeItem(OLD_PRICES);
    } catch { /* nothing old to move, or a private window */ }
    S.loaded = true;
  }

  // Saves the open project a moment after the last change, and straight away
  // when leaving it.
  const writePlan = async () => {
    const plan = S.data.plans.find((p) => p.id === S.id);
    if (!plan) return;
    try {
      const saved = await api('POST', '/api/birdhouse/plans', { id: plan.id, name: S.name, plan: S.d });
      Object.assign(plan, saved);
      const say = $('#bh-saved');
      if (say && S.screen === 'editor') say.textContent = 'Saved.';
    } catch (err) {
      const say = $('#bh-saved');
      if (say && S.screen === 'editor') say.textContent = `Not saved yet: ${err.message}`;
    }
  };
  const queueSave = later(writePlan, 800);
  const remember = () => {
    if (!S.id) return;
    const sig = JSON.stringify([S.d, S.name]);
    if (sig === S.sig) return;
    S.sig = sig;
    S.dirty = true;
    queueSave();
  };
  // Anything waiting to be saved goes now (before leaving a screen or reading again).
  const flushAll = () => Promise.all([queueSave.flush(), savePrices.flush(), saveStock.flush(), savePrefs.flush()]);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushAll(); });

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const letter = (i) => String.fromCharCode(65 + i);

  // ---------- shops and prices ----------
  // The price book: what the person has set for each material, with the day
  // it was set, and what each shop charges. Kept on their account; the same
  // prices serve every plan.
  const SHOPS = [
    { id: 'wickes', name: 'Wickes', host: 'wickes.co.uk', url: (q) => `https://www.wickes.co.uk/search?text=${encodeURIComponent(q)}` },
    { id: 'bq', name: 'B&Q', host: 'diy.com', url: (q) => `https://www.diy.com/search?term=${encodeURIComponent(q)}` },
  ];
  const book = () => S.data.prices;
  const entry = (key) => (book()[key] && Number.isFinite(book()[key].p) ? book()[key] : null);
  const priceOf = (m) => (entry(m.key) ? entry(m.key).p : m.estimate);
  const shopEntry = (m, shop) => entry(`${m.key}@${shop.id}`);
  const ageDays = (day) => Math.floor((Date.now() - Date.parse(day)) / 864e5);
  const setEntry = (key, e) => {
    const keep = book()[key] && book()[key].url ? { url: book()[key].url } : {};
    if (e) book()[key] = { ...keep, ...e }; else if (keep.url) book()[key] = keep; else delete book()[key];
    savePrices();
  };

  // ---------- the drawings ----------
  // Flat views, drawn in millimetres so the shapes are true to size. Lines keep
  // one thickness however big the drawing is shown. Boards hidden behind
  // others are dashed.
  function drawFlat(from, name) {
    const v = model.view(S.d, from);
    const { width, height } = v;
    const big = Math.max(width, height);
    const m = big * 0.16;
    const tick = big * 0.02;
    const fs = big * 0.04;
    const root = svg('svg', { viewBox: `${-m} ${-m * 0.7} ${width + m * 1.5} ${height + m * 1.6}`, role: 'img', 'aria-label': `${name} view, ${spoken(width)} by ${spoken(height)}` });
    const line = (x1, y1, x2, y2) => svg('line', { x1, y1, x2, y2, class: 'bh-dim' });
    for (const b of v.shapes) root.append(svg('rect', { x: b.x, y: b.y, width: b.w, height: b.h, class: b.hidden ? 'bh-hidden' : 'bh-board' }));
    const yd = height + m * 0.5;
    root.append(line(0, yd, width, yd), line(0, yd - tick, 0, yd + tick), line(width, yd - tick, width, yd + tick),
      svg('text', { x: width / 2, y: yd + fs * 1.5, 'text-anchor': 'middle', 'font-size': fs, class: 'bh-label' }, fmt(width)));
    const xd = -m * 0.5;
    root.append(line(xd, 0, xd, height), line(xd - tick, 0, xd + tick, 0), line(xd - tick, height, xd + tick, height),
      svg('text', { x: xd - fs * 0.5, y: height / 2, 'text-anchor': 'middle', 'font-size': fs, class: 'bh-label', transform: `rotate(-90 ${xd - fs * 0.5} ${height / 2})` }, fmt(height)));
    return root;
  }

  // A small still picture of a plan for the home screen.
  function thumb(d) {
    const s = model.size(d);
    const r = Math.sqrt(s.width ** 2 + s.depth ** 2 + s.height ** 2) / 2 * 1.08;
    const root = svg('svg', { viewBox: `${-r} ${-r} ${2 * r} ${2 * r}`, class: 'bh-thumb', 'aria-hidden': 'true', focusable: 'false' });
    for (const f of model.project(d, 0.6, 0.35)) root.append(svg('polygon', { points: f.pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' '), class: 'bh-face', 'fill-opacity': f.light }));
    return root;
  }

  // The turning picture. The frame is sized once to fit the model from any
  // angle, so it doesn't jump about as it turns; only the faces are redrawn.
  function draw3d() {
    const s = model.size(S.d);
    const r = Math.sqrt(s.width ** 2 + s.depth ** 2 + s.height ** 2) / 2 * 1.08;
    const root = svg('svg', { viewBox: `${-r} ${-r} ${2 * r} ${2 * r}`, class: 'bh-3d', role: 'img', 'aria-label': `3D view of the ${s.width} by ${s.height} by ${s.depth} millimetre ${info().name.toLowerCase()}, drag to turn` });
    const faces = svg('g');
    root.append(faces);
    const redraw = () => {
      faces.replaceChildren(...model.project(S.d, S.yaw, S.pitch).map((f) => svg('polygon', { points: f.pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' '), class: 'bh-face', 'fill-opacity': f.light })));
    };
    redraw();
    let at = null;
    let frame = 0;
    const tilt = (dy) => { S.pitch = Math.min(1.3, Math.max(-0.3, S.pitch + dy)); };
    root.addEventListener('pointerdown', (e) => { at = [e.clientX, e.clientY]; root.setPointerCapture(e.pointerId); });
    root.addEventListener('pointermove', (e) => {
      if (!at) return;
      S.yaw += (e.clientX - at[0]) * 0.01;
      tilt((e.clientY - at[1]) * 0.01);
      at = [e.clientX, e.clientY];
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; redraw(); });
    });
    const stop = () => { at = null; };
    root.addEventListener('pointerup', stop);
    root.addEventListener('pointercancel', stop);
    root.addEventListener('keydown', (e) => {
      const step = { ArrowLeft: [-0.15, 0], ArrowRight: [0.15, 0], ArrowUp: [0, -0.1], ArrowDown: [0, 0.1] }[e.key];
      if (!step) return;
      e.preventDefault();
      S.yaw += step[0];
      tilt(step[1]);
      redraw();
    });
    root.setAttribute('tabindex', '0');
    return root;
  }

  // What to buy and roughly what it costs. Prices start as guesses; typing a
  // price saves it with today's date, and a price over a month old is flagged.
  // The shop links are ordinary links to the shop's own search: nothing is
  // fetched from the shop, so the price is whatever you read there.
  function drawCost() {
    const items = materials();
    const total = h('b', { class: 'bh-total' });
    const sum = () => { total.textContent = money(items.reduce((a, m) => a + m.qty * priceOf(m), 0)); };
    // Fetch price only shows when an admin has switched it on; asked about once.
    if (S.fetchOn === undefined) {
      S.fetchOn = false;
      flags().then((r) => { S.fetchOn = r.fetch; if (r.fetch && S.view === 'cost') paint(); });
    }
    const rows = items.map((m) => {
      const note = h('span', { class: 'bh-age' });
      const has = () => Boolean(entry(m.key));
      const showAge = () => {
        const q = entry(m.key);
        const old = q && ageDays(q.at) > 30;
        note.textContent = !q ? 'guess' : `${q.src ? `${q.src.includes('.') ? 'fetched from' : 'cheapest at'} ${q.src}` : 'set'} ${q.at}${old ? ', old' : ''}`;
        note.classList.toggle('old', Boolean(old));
      };
      const line = h('td', { class: 'bh-num' });
      const showLine = () => { line.textContent = money(m.qty * priceOf(m)); };
      const input = h('input', { type: 'number', min: '0', max: '10000', step: '0.01', inputmode: 'decimal', value: priceOf(m).toFixed(2), 'aria-label': `Price of ${m.label}` });
      const record = (e) => {
        setEntry(m.key, e);
        input.value = priceOf(m).toFixed(2);
        showAge(); showLine(); sum();
      };
      input.addEventListener('change', () => {
        const v = Number(input.value);
        record(input.value === '' || !Number.isFinite(v) || v < 0 ? null : { p: Math.min(10000, Math.round(v * 100) / 100), at: today() });
      });
      showAge(); showLine();
      let fetcher = null;
      if (S.fetchOn) {
        const link = h('input', { type: 'url', class: 'bh-link', placeholder: 'Product page link (Wickes or B&Q)', maxlength: '500', value: (book()[m.key] && book()[m.key].url) || '', 'aria-label': `Product page for ${m.label}` });
        const say = h('span', { class: 'bh-age' });
        const go2 = h('button', { type: 'button', class: 'bh-btn bh-small', text: 'Fetch price' });
        link.addEventListener('change', () => {
          const e = { ...(book()[m.key] || {}) };
          if (link.value.trim()) e.url = link.value.trim(); else delete e.url;
          if (Object.keys(e).length) book()[m.key] = e; else delete book()[m.key];
          savePrices();
        });
        go2.addEventListener('click', async () => {
          const url = link.value.trim();
          if (!url) { say.textContent = 'Paste the product page link first.'; return; }
          go2.disabled = true;
          say.textContent = 'Reading the page…';
          try {
            const r = await api('POST', '/api/birdhouse/price', { url });
            const shop = SHOPS.find((s) => r.shop === s.host);
            if (shop) setEntry(`${m.key}@${shop.id}`, { p: r.price, at: today(), src: r.shop, url });
            record({ p: r.price, at: today(), src: r.shop, url });
            say.textContent = '';
          } catch (err) {
            say.textContent = err.message; // quietly: the price can always be typed in
          } finally {
            go2.disabled = false;
          }
        });
        fetcher = h('tr', { class: 'bh-fetchrow' }, h('td', { colspan: '5' }, h('div', { class: 'bh-fetch' }, link, go2, say)));
      }
      return [h('tr', { class: fetcher ? 'bh-hasfetch' : '' },
        h('td', {}, m.label, h('br'), note, m.have ? h('span', { class: 'bh-age', text: ` · ${m.have} from your workshop` }) : null),
        h('td', { class: 'bh-num', text: String(m.qty) }),
        h('td', {}, h('span', { class: 'bh-pound', text: '£' }), input),
        line,
        h('td', { class: 'bh-shops' }, ...SHOPS.map((s) => h('a', { href: s.url(m.search), target: '_blank', rel: 'noopener', text: s.name, 'aria-label': `Check ${m.label} at ${s.name}` })))), fetcher];
    });
    sum();
    return h('div', { class: 'bh-cost' },
      h('h3', { class: 'bh-h', text: 'What to buy' }),
      h('table', { class: 'bh-table' },
        h('thead', {}, h('tr', {}, ...['Material', 'Qty', 'Each', 'Total', 'Check'].map((t) => h('th', { text: t })))),
        h('tbody', {}, ...rows),
        h('tfoot', {}, h('tr', {}, h('td', { text: 'Estimate' }), h('td'), h('td'), h('td', { class: 'bh-num' }, total), h('td')))),
      h('p', { class: 'bh-note', text: `Starter prices are rough guesses. Tap a shop to see its price, then type it in: it is kept with the date.${S.fetchOn ? ' Fetch price reads one product page when you press it.' : ' Nothing is sent to the shops.'}` }),
      compare(items));
  }

  // Side by side: what each shop charges for each line, the cheaper one in
  // bold, and what the whole list comes to at each. A line with no price from
  // a shop uses its starter guess there, marked with a ~.
  function compare(items) {
    const buy = items.filter((m) => m.qty > 0);
    const box = h('div', { class: 'bh-compare' }, h('h3', { class: 'bh-h', text: 'Compare shops' }));
    const totals = SHOPS.map(() => h('td', { class: 'bh-num' }));
    const mix = h('b');
    const cells = [];
    const refresh = () => {
      let best = 0;
      SHOPS.forEach((s, i) => {
        let t = 0; let guessed = 0;
        for (const m of buy) { const e = shopEntry(m, s); t += m.qty * (e ? e.p : m.estimate); if (!e) guessed++; }
        totals[i].textContent = `${guessed ? '~' : ''}${money(t)}`;
      });
      for (const m of buy) {
        const ps = SHOPS.map((s) => shopEntry(m, s)).filter(Boolean).map((e) => e.p);
        best += m.qty * (ps.length ? Math.min(...ps) : priceOf(m));
      }
      mix.textContent = money(best);
      for (const { m, inputs } of cells) {
        const ps = SHOPS.map((s) => shopEntry(m, s)).map((e) => (e ? e.p : Infinity));
        const low = Math.min(...ps);
        inputs.forEach((inp, i) => inp.classList.toggle('low', ps[i] === low && ps.filter((p) => p === low).length === 1));
      }
    };
    const rows = buy.map((m) => {
      const inputs = SHOPS.map((s) => {
        const e = shopEntry(m, s);
        const inp = h('input', { type: 'number', min: '0', max: '10000', step: '0.01', inputmode: 'decimal', placeholder: m.estimate.toFixed(2), value: e ? e.p.toFixed(2) : '', 'aria-label': `${m.label} at ${s.name}` });
        inp.addEventListener('change', () => {
          const v = Number(inp.value);
          setEntry(`${m.key}@${s.id}`, inp.value === '' || !Number.isFinite(v) || v < 0 ? null : { p: Math.min(10000, Math.round(v * 100) / 100), at: today() });
          refresh();
        });
        return inp;
      });
      cells.push({ m, inputs });
      return h('tr', {}, h('td', { text: `${m.qty} × ${m.label}` }), ...inputs.map((inp, i) => h('td', {}, h('span', { class: 'bh-pound', text: '£' }), inp,
        h('a', { href: SHOPS[i].url(m.search), target: '_blank', rel: 'noopener', class: 'bh-go', text: '↗', 'aria-label': `Check ${m.label} at ${SHOPS[i].name}` }))));
    });
    const use = h('button', { type: 'button', class: 'bh-btn bh-small', text: 'Use the cheapest prices', onclick: () => {
      for (const m of buy) {
        const found = SHOPS.map((s) => shopEntry(m, s)).filter(Boolean);
        if (!found.length) continue;
        const low = found.reduce((a, b) => (b.p < a.p ? b : a));
        setEntry(m.key, { p: low.p, at: low.at, src: SHOPS.find((s) => shopEntry(m, s) === low).name });
      }
      paint();
    } });
    box.append(
      h('table', { class: 'bh-table' },
        h('thead', {}, h('tr', {}, h('th', { text: 'To buy' }), ...SHOPS.map((s) => h('th', { text: s.name })))),
        h('tbody', {}, ...rows),
        h('tfoot', {}, h('tr', {}, h('td', { text: 'All from one shop' }), ...totals))),
      h('p', { class: 'bh-note' }, 'Cheapest mix of shops: ', mix, ' · ', use),
      h('p', { class: 'bh-note', text: 'Type what each shop charges (the ↗ opens its search). ~ means some lines are still starter guesses.' }));
    refresh();
    return box;
  }

  // The boards laid out on sheets of stock: what to cut from where, using the
  // wood already in the workshop first.
  function drawSheets() {
    const l = layout();
    const box = h('div', { class: 'bh-sheets' });
    l.sheets.forEach((sheet, n) => {
      const root = svg('svg', { viewBox: `-20 -20 ${sheet.width + 40} ${sheet.height + 40}`, role: 'img', 'aria-label': `Sheet ${n + 1}, ${spoken(sheet.thickness)} board, ${plural(sheet.pieces.length, 'piece')}${sheet.owned ? ', from your workshop' : ''}` });
      root.append(svg('rect', { x: 0, y: 0, width: sheet.width, height: sheet.height, class: 'bh-stock' }));
      for (const p of sheet.pieces) {
        root.append(svg('rect', { x: p.x, y: p.y, width: p.w, height: p.h, class: 'bh-board' }));
        if (Math.min(p.w, p.h) > 90) root.append(svg('text', { x: p.x + p.w / 2, y: p.y + p.h / 2 + 30, 'text-anchor': 'middle', 'font-size': 90, class: 'bh-label' }, letter(p.part)));
      }
      box.append(h('h3', { class: 'bh-h', text: `Sheet ${n + 1} · ${fmt(sheet.thickness)} · ${fmt(sheet.width)} × ${fmt(sheet.height)}${sheet.owned ? ' · from your workshop' : ''}` }), root);
    });
    for (const g of l.timber) {
      const bars = g.bars.length;
      const wide = Math.max(...g.bars.map((b) => b.len));
      const own = g.bars.filter((b) => b.owned).length;
      const root = svg('svg', { viewBox: `-20 -10 ${wide + 40} ${bars * 150 + 10}`, class: 'bh-bars', role: 'img', 'aria-label': `${fmt(g.width)} by ${fmt(g.thickness)} timber, ${plural(bars, 'length')}` });
      g.bars.forEach((bar, i) => {
        const y = i * 150;
        root.append(svg('rect', { x: 0, y, width: bar.len, height: 120, class: 'bh-stock' }));
        for (const p of bar.pieces) {
          root.append(svg('rect', { x: p.x, y, width: p.len, height: 120, class: 'bh-board' }));
          if (p.len > 160) root.append(svg('text', { x: p.x + p.len / 2, y: y + 82, 'text-anchor': 'middle', 'font-size': 70, class: 'bh-label' }, letter(p.part)));
        }
      });
      box.append(h('h3', { class: 'bh-h', text: `${plural(bars, 'length')} of ${fmt(g.width)} × ${fmt(g.thickness)} timber${own ? ` · ${own} from your workshop` : ''}` }), root);
    }
    const waste = l.area ? Math.round((1 - l.used / l.area) * 100) : 0;
    const bits = [];
    if (l.sheets.length) bits.push(`${plural(l.sheets.length, 'sheet')}, ${waste}% left over`);
    if (l.timber.length) { const n = l.timber.reduce((a, g) => a + g.bars.length, 0); bits.push(`${plural(n, 'length')} of timber`); }
    box.append(h('p', { class: 'bh-note', text: `${bits.join(' · ')} · 3 mm saw cut between boards · letters match the cut list` }));
    if (l.tooBig.length) box.append(h('p', { class: 'bh-warn', text: `Too big for a ${fmt(l.width)} × ${fmt(l.height)} sheet: ${[...new Set(l.tooBig.map((t) => letter(t.part)))].join(', ')}. Make it smaller or join boards.` }));
    return box;
  }

  const VIEWS = [['front', 'Front', () => drawFlat('front', 'Front')], ['side', 'Side', () => drawFlat('side', 'Side')], ['top', 'Top', () => drawFlat('top', 'Top')], ['3d', '3D', draw3d], ['sheets', 'Sheets', drawSheets], ['cost', 'Cost', drawCost]];

  function tabs() {
    return VIEWS.map(([id, name]) => h('button', {
      type: 'button', role: 'tab', class: `bh-tab${S.view === id ? ' on' : ''}`, 'aria-selected': String(S.view === id), text: name,
      onclick: () => { S.view = id; paint(); },
    }));
  }

  // The cut list: what to saw, and how much board it adds up to.
  function cutList() {
    const rows = model.parts(S.d);
    const area = rows.reduce((a, r) => a + r.qty * r.length * r.width, 0) / 1e6;
    return h('div', {},
      h('h3', { class: 'bh-h', text: 'Cut list' }),
      h('table', { class: 'bh-table' },
        h('thead', {}, h('tr', {}, ...['', 'Part', 'Qty', 'Length', 'Width', 'Thick'].map((t) => h('th', { text: t })))),
        h('tbody', {}, ...rows.map((r, i) => h('tr', {}, h('td', { class: 'bh-key', text: letter(i) }), h('td', {}, r.name, h('br'), h('span', { class: 'bh-age', text: r.join })), h('td', { text: String(r.qty) }), h('td', { text: fmt(r.length) }), h('td', { text: fmt(r.width) }), h('td', { text: fmt(r.thickness) }))))),
      h('p', { class: 'bh-note', text: `${rows.reduce((a, r) => a + r.qty, 0)} boards · ${area.toFixed(2)} m² of board · sizes in ${inch() ? 'inches' : 'mm'}` }));
  }

  function titleBlock() {
    const s = model.size(S.d);
    const cell = (label, value) => h('div', {}, h('small', { text: label }), value);
    return h('div', { class: 'bh-title' }, cell('PROJECT', `${S.name || info().name} · pine`), cell('SIZE', `${fmt(s.width)} × ${fmt(s.depth)} × ${fmt(s.height)}`), cell('UNITS', unit()), cell('SHEET', '1 / 1'));
  }

  function paint() {
    const name = $('#bh-name');
    if (document.activeElement !== name) name.value = S.name;
    $('#bh-kind').textContent = info().name;
    $('#bh-chips').replaceChildren(...info().chips(S.d, fmt).map((t) => h('span', { class: 'bh-chip', text: t })));
    $('#bh-checks').replaceChildren(...(S.d.notes ? [h('p', { class: 'bh-note', text: `Design notes: ${S.d.notes}` })] : []), ...model.checks(S.d).map((c) => h('p', { class: c.level === 'warn' ? 'bh-warn' : 'bh-note', text: `${c.level === 'warn' ? 'Careful: ' : 'Tip: '}${c.text}` })));
    $('#bh-tabs').replaceChildren(...tabs());
    $('#bh-view').replaceChildren(VIEWS.find((v) => v[0] === S.view)[2]());
    $('#bh-cuts').replaceChildren(cutList());
    $('#bh-title').replaceChildren(titleBlock());
    remember();
  }

  // The Adjust card: opens beside the button, only as big as it needs, and
  // closes on Done, Escape or a tap outside it.
  function cardBody() {
    S.fields = {};
    const projects = h('div', { class: 'bh-projects', role: 'group', 'aria-label': 'Project' }, ...model.IDS.map((id) => h('button', {
      type: 'button', class: `bh-pick${S.d.template === id ? ' on' : ''}`, 'aria-pressed': String(S.d.template === id), text: model.TEMPLATES[id].name,
      onclick: () => { S.by[S.d.template] = S.d; S.d = S.by[id] || model.defaults(id); fill(); paint(); },
    })));
    const show = (key, v) => (COUNTS.has(key) ? String(v) : fmt(v));
    if (S.d.template === 'custom') return [projects, h('p', { class: 'bh-note', text: 'This is a custom design, so it has no sliders. To change it, use Ask Claude on the projects page and describe the change.' })];
    // How it is built: a timber frame with plywood skins, or sheets butted together.
    const style = info().framed ? h('div', { class: 'bh-projects', role: 'group', 'aria-label': 'How it is built' },
      ...[['framed', 'Framed'], ['panel', 'Panels']].map(([id, name]) => h('button', {
        type: 'button', class: `bh-pick${S.d.style === id ? ' on' : ''}`, 'aria-pressed': String(S.d.style === id), text: name,
        onclick: () => { S.d = model.clean({ ...S.d, style: id }); fill(); paint(); },
      }))) : null;
    const rows = Object.entries(info().limits).filter(([key]) => key !== 'frame' || S.d.style === 'framed').map(([key, lim]) => {
      const out = h('span', { class: 'bh-val', text: show(key, S.d[key]) });
      const input = h('input', { type: 'range', min: lim.min, max: lim.max, step: lim.step, value: S.d[key], 'aria-label': lim.label });
      input.addEventListener('input', () => {
        S.d = model.clean({ ...S.d, [key]: input.value });
        for (const [k, f] of Object.entries(S.fields)) { f.input.value = S.d[k]; f.out.textContent = show(k, S.d[k]); }
        paint();
      });
      S.fields[key] = { input, out };
      return h('label', { class: 'bh-slider' }, h('span', { class: 'bh-row' }, h('span', { text: lim.label }), out), input);
    });
    return [projects, style, ...rows];
  }

  const fill = () => { const body = S.card && S.card.querySelector('.bh-body'); if (body) body.replaceChildren(...cardBody()); };

  // One small floating card at a time (Adjust, or Ask Claude), only as big as
  // it needs; it closes on Done, Escape or a tap outside it.
  function popup(label, button, ...content) {
    const card = h('div', { class: 'bh-card', role: 'dialog', 'aria-label': label },
      h('div', { class: 'bh-card-head' }, h('b', { class: 'mono', text: label }), h('button', { type: 'button', class: 'bh-x', 'aria-label': 'Close', text: '✕', onclick: closeCard })),
      ...content);
    S.card = card;
    S.cardButton = button;
    $('#view-birdhouse').append(card);
    button.setAttribute('aria-expanded', 'true');
    setTimeout(() => document.addEventListener('pointerdown', outside), 0);
    document.addEventListener('keydown', escape);
    return card;
  }

  function openCard() {
    if (S.card) { const same = S.cardButton === $('#bh-adjust'); closeCard(); if (same) return; }
    const card = popup('Adjust', $('#bh-adjust'),
      h('div', { class: 'bh-body' }),
      h('div', { class: 'bh-actions' },
        h('button', { type: 'button', class: 'bh-btn solid', text: 'Done', onclick: closeCard }),
        h('button', { type: 'button', class: 'bh-btn', text: 'Reset', onclick: () => { S.d = model.defaults(S.d.template); fill(); paint(); } })));
    fill();
    card.querySelector('.bh-pick.on').focus({ preventScroll: true });
  }
  const outside = (e) => { if (S.card && !S.card.contains(e.target) && !S.cardButton.contains(e.target)) closeCard(); };
  const escape = (e) => { if (e.key === 'Escape') { const b = S.cardButton; closeCard(); b.focus(); } };

  function closeCard() {
    if (!S.card) return;
    S.card.remove();
    S.card = null;
    S.fields = {};
    S.cardButton.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside);
    document.removeEventListener('keydown', escape);
  }

  // ---------- Nest: a copy of the plan as a file ----------
  // Projects are already kept on the account. Save to Nest adds a copy as a
  // few hundred bytes of JSON in Nest's Birdhouse folder, so it is backed up
  // and shared like any other file. Nothing is written until it is pressed.

  const FOLDER = 'Birdhouse';
  const EXT = '.birdhouse';
  const hasNest = () => typeof state !== 'undefined' && state.apps.some((a) => a.id === 'nest');

  async function save() {
    const say = $('#bh-saved');
    const btn = $('#bh-save');
    btn.disabled = true;
    say.textContent = 'Saving…';
    try {
      const folder = await api('POST', '/api/nest/folders', { parent: '', path: FOLDER });
      const sz = model.size(S.d);
      const name = `${S.name || info().name} ${sz.width}x${sz.depth}x${sz.height}${EXT}`.replace(/[\\/:*?"<>|]/g, '-');
      const bytes = new TextEncoder().encode(JSON.stringify({ app: 'birdhouse', version: 1, name: S.name, plan: S.d }));
      const up = await api('POST', '/api/nest/uploads', { parent: folder.id, name, size: bytes.length, type: 'application/json' });
      if (!up.done) {
        const res = await fetch(`/api/nest/uploads/${up.id}?offset=0`, { method: 'PUT', body: bytes, credentials: 'same-origin' });
        const out = await res.json().catch(() => ({}));
        if (!res.ok || !out.done) throw new Error(out.error || 'Could not save');
      }
      say.textContent = `A copy is in Nest, in the ${FOLDER} folder.`;
    } catch (err) {
      say.textContent = `Not copied: ${err.message}`;
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- printing ----------
  // The whole plan on paper: drawings, cut list, layouts and cost. It is built
  // only for the moment of printing (the print style hides the rest of the page),
  // so "Print" in the browser, or Share > PDF on a phone, gives the plan sheet.

  function printSheet() {
    const s = model.size(S.d);
    const cell = (label, value) => h('div', {}, h('small', { text: label }), value);
    const items = materials();
    const total = items.reduce((a, m) => a + m.qty * priceOf(m), 0);
    const costTable = h('table', { class: 'bh-table' },
      h('thead', {}, h('tr', {}, ...['Material', 'Qty', 'Each', 'Total'].map((t) => h('th', { text: t })))),
      h('tbody', {}, ...items.map((m) => h('tr', {}, h('td', { text: `${m.label}${m.have ? ` (${m.have} from workshop)` : ''}` }), h('td', { text: String(m.qty) }), h('td', { text: money(priceOf(m)) }), h('td', { text: money(m.qty * priceOf(m)) })))),
      h('tfoot', {}, h('tr', {}, h('td', { text: 'Estimate' }), h('td'), h('td'), h('td', { text: money(total) }))));
    const when = new Date().toLocaleDateString();
    return h('div', { id: 'bh-sheet-print' },
      h('div', { class: 'bh-title' }, cell('PROJECT', `${S.name || info().name} · pine`), cell('SIZE', `${fmt(s.width)} × ${fmt(s.depth)} × ${fmt(s.height)} ${unit()}`), cell('PLANNED', when), cell('MADE WITH', 'Birdhouse · Roost')),
      h('div', { class: 'bh-chips' }, ...info().chips(S.d, fmt).map((t) => h('span', { class: 'bh-chip', text: t }))),
      h('div', { class: 'bh-pgrid' }, drawFlat('front', 'Front'), drawFlat('side', 'Side'), drawFlat('top', 'Top')),
      h('div', { class: 'bh-pgrid two' }, draw3d(), h('div', {}, cutList())),
      h('div', { class: 'bh-pbreak' }, drawSheets()),
      h('div', { class: 'bh-pbreak' }, h('h3', { class: 'bh-h', text: 'What to buy' }), costTable,
        h('p', { class: 'bh-note', text: 'Prices are the ones set in Birdhouse (starter prices are rough guesses). Check them at the shop before buying.' })));
  }

  function printPlan() {
    document.getElementById('bh-sheet-print')?.remove();
    document.body.append(printSheet());
    const done = () => { document.getElementById('bh-sheet-print')?.remove(); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    window.print();
  }

  // ---------- describing a project ----------
  // Reads what was typed and says what it did, so a number it could not place
  // is never quietly dropped.
  function readSentence(text, current) {
    const p = model.parse(text, current);
    if (!p.template && !Object.keys(p.set).length && !p.unused.length) return null;
    // Starting a project with no project word in it: don't guess one.
    if (!current && !p.template) return { unknown: true };
    const id = p.template || current || 'bookshelf';
    const d = model.clean({ ...(current && id === S.d.template ? S.d : model.defaults(id)), template: id, ...p.set });
    const t = model.TEMPLATES[id];
    const said = Object.keys(p.set).map((k) => `${t.limits[k].label.toLowerCase()} ${COUNTS.has(k) ? d[k] : fmt(d[k])}`);
    return { d, p, t, said };
  }

  function draft(text) {
    const say = $('#bh-say');
    const r = readSentence(text, S.d.template);
    if (!r) { say.textContent = 'Try: bookshelf 1800 tall, 800 wide, 5 shelves'; return; }
    if (r.p.template && r.p.template !== S.d.template) S.by[S.d.template] = S.d;
    S.d = r.d;
    say.textContent = `${r.p.template ? `Drafted a ${r.t.name.toLowerCase()}` : `Changed the ${r.t.name.toLowerCase()}`}${r.said.length ? `: ${r.said.join(', ')}` : ''}.${r.p.unused.length ? ` Couldn't place ${r.p.unused.join(', ')}: say what it is, like "55 thick".` : ''}`;
    fill();
    paint();
  }

  // ---------- Ask Claude (no outside service) ----------
  // For wording the helper can't read, Birdhouse writes a short request the
  // person pastes into their own Claude chat, then pastes the reply back.
  // Birdhouse calls nothing and holds no key: the chat is the person's own.
  function askPrompt(idea) {
    return `${model.designInstructions()}\n\nMy idea: ${idea.trim() || '(describe what you want to build)'}`;
  }

  // Reads Claude's reply; null if there is no usable design in it.
  const readReply = (reply) => { const r = model.readDesign(reply); return r.ok ? r : null; };

  // Asked once: whether Fetch price and Design with Claude are switched on.
  function flags() {
    if (!S.flags) S.flags = api('GET', '/api/birdhouse').catch(() => ({ fetch: false, ai: null }));
    return S.flags;
  }

  function openAsk(button) {
    if (S.card) { const same = S.cardButton === button; closeCard(); if (same) return; }
    const idea = h('textarea', { rows: '2', maxlength: '1500', placeholder: 'e.g. a low shelf for my records, about a metre wide', 'aria-label': 'Your idea' });
    const prompt = h('textarea', { rows: '4', readonly: true, 'aria-label': 'Request to paste into Claude' });
    const reply = h('textarea', { rows: '3', maxlength: '60000', placeholder: 'Paste Claude’s reply here', 'aria-label': 'Claude’s reply' });
    const say = h('p', { class: 'bh-note', 'aria-live': 'polite' });
    const sync = () => { prompt.value = askPrompt(idea.value); };
    idea.addEventListener('input', sync);
    sync();
    const finish = async (got) => { closeCard(); await newPlan(got.d, got.name); };
    // Design with Claude: only when an admin has saved a key.
    const ai = h('div', { class: 'bh-ai' });
    popup('Ask Claude', button,
      h('label', { class: 'bh-field' }, h('span', { text: 'Your idea' }), idea),
      ai,
      h('details', { class: 'bh-paste' },
        h('summary', { text: 'Or use your own Claude chat (no key needed)' }),
        h('p', { class: 'bh-note', text: 'Nothing is sent from Roost. Copy the request, paste it into Claude, then paste its reply back here.' }),
        h('label', { class: 'bh-field' }, h('span', { text: 'Copy this into Claude' }), prompt),
        h('button', { type: 'button', class: 'bh-btn bh-small', text: 'Copy request', onclick: async () => {
          try { await navigator.clipboard.writeText(prompt.value); say.textContent = 'Copied. Paste it into your Claude chat.'; } catch { prompt.select(); say.textContent = 'Select and copy it.'; }
        } }),
        h('label', { class: 'bh-field' }, h('span', { text: 'Claude’s reply' }), reply),
        h('div', { class: 'bh-actions' }, h('button', { type: 'button', class: 'bh-btn solid', text: 'Make the plan', onclick: async () => {
          const got = readReply(reply.value);
          if (!got) { say.textContent = 'I couldn’t find a design in that. Paste Claude’s whole reply, including the { } part.'; return; }
          await finish(got);
        } }))),
      say);
    idea.focus({ preventScroll: true });
    flags().then(({ ai: info }) => {
      if (!info || !ai.isConnected) return;
      let tier = info.tiers[1] ? info.tiers[1].id : info.tiers[0].id;
      const note = h('p', { class: 'bh-note' });
      const tell = () => {
        const t = info.tiers.find((x) => x.id === tier);
        note.textContent = `${t.hint} About $${t.estimate.toFixed(2)} a design. ${info.left} left today; $${info.spent.toFixed(2)} of $${info.monthCap} used this month.`;
      };
      const picks = h('div', { class: 'bh-projects', role: 'group', 'aria-label': 'How hard Claude thinks' }, ...info.tiers.map((t) => h('button', {
        type: 'button', class: `bh-pick${t.id === tier ? ' on' : ''}`, 'aria-pressed': String(t.id === tier), text: t.label,
        onclick: (e) => { tier = t.id; for (const b of picks.children) { const on = b === e.currentTarget; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); } tell(); },
      })));
      const go = h('button', { type: 'button', class: 'bh-btn solid', text: 'Design it', onclick: async () => {
        if (!idea.value.trim()) { say.textContent = 'Say what you want to build first.'; return; }
        go.disabled = true;
        say.textContent = 'Claude is designing it. Deeper tiers can take a few minutes…';
        try {
          const r = await api('POST', '/api/birdhouse/design', { prompt: idea.value, tier });
          flags_reset();
          await finish({ d: r.d, name: r.name });
        } catch (err) {
          go.disabled = false;
          say.textContent = err.message;
        }
      } });
      ai.replaceChildren(h('b', { class: 'bh-aihead', text: 'Design with Claude' }), picks, note, h('div', { class: 'bh-actions' }, go));
      tell();
    });
  }
  const flags_reset = () => { S.flags = null; };

  // ---------- projects ----------
  async function newPlan(d, name) {
    flashHome('Making it…');
    try {
      const plan = await api('POST', '/api/birdhouse/plans', { name: name || model.info(d).name, plan: d });
      S.data.plans.unshift(plan);
      go(plan.id);
    } catch (err) {
      flashHome(`Couldn't make it: ${err.message}`);
    }
  }

  const flashHome = (text) => { const el = $('#bh-homesay'); if (el) el.textContent = text; };

  async function copyPlan(plan) {
    try {
      const made = await api('POST', '/api/birdhouse/plans', { name: `${plan.name} copy`.slice(0, 60), plan: plan.plan });
      S.data.plans.unshift(made);
      drawHome();
    } catch (err) {
      flashHome(`Couldn't copy it: ${err.message}`);
    }
  }

  async function dropPlan(plan) {
    try {
      await api('DELETE', `/api/birdhouse/plans/${plan.id}`);
      S.data.plans = S.data.plans.filter((p) => p.id !== plan.id);
      drawHome();
    } catch (err) {
      flashHome(`Couldn't delete it: ${err.message}`);
    }
  }

  function planCard(plan) {
    const s = model.size(plan.plan);
    const asking = h('div', { class: 'bh-confirm hidden' },
      h('span', { text: 'Delete this plan?' }),
      h('button', { type: 'button', class: 'bh-btn bh-small solid', text: 'Delete', onclick: () => dropPlan(plan) }),
      h('button', { type: 'button', class: 'bh-btn bh-small', text: 'Keep', onclick: () => { asking.classList.add('hidden'); } }));
    return h('li', { class: 'bh-plancard' },
      h('a', { class: 'bh-open', href: `#/birdhouse/${plan.id}`, 'aria-label': `Open ${plan.name}` },
        thumb(plan.plan),
        h('b', { text: plan.name }),
        h('small', { text: `${model.TEMPLATES[plan.plan.template].name} · ${fmt(s.width)} × ${fmt(s.height)} · ${new Date(plan.updated).toLocaleDateString()}` })),
      h('div', { class: 'bh-cardbtns' },
        h('button', { type: 'button', class: 'bh-link-btn', text: 'Copy', 'aria-label': `Copy ${plan.name}`, onclick: () => copyPlan(plan) }),
        h('button', { type: 'button', class: 'bh-link-btn', text: 'Delete', 'aria-label': `Delete ${plan.name}`, onclick: () => asking.classList.remove('hidden') })),
      asking);
  }

  function drawHome() {
    const box = $('#bh-home');
    const ask = h('form', { class: 'bh-ask', autocomplete: 'off' },
      h('label', { class: 'sr', for: 'bh-homeask', text: 'Describe what to build' }),
      h('input', { type: 'text', id: 'bh-homeask', maxlength: '200', placeholder: 'Describe a new project: a table 1200 long, 700 wide, 740 tall', enterkeyhint: 'go' }),
      h('button', { type: 'submit', class: 'bh-btn solid', text: 'Draft' }));
    ask.addEventListener('submit', (e) => {
      e.preventDefault();
      const r = readSentence(ask.querySelector('input').value, null);
      if (!r) { flashHome('Try: bookshelf 1800 tall, 800 wide, 5 shelves'); return; }
      if (r.unknown) { flashHome(`I don’t know that project yet. I can plan a ${model.IDS.map((id) => model.TEMPLATES[id].name.toLowerCase()).join(', ')}. Tap one, or use Ask Claude to turn your idea into the closest.`); return; }
      newPlan(r.d, null);
    });
    const starters = h('ul', { class: 'bh-starters' }, ...model.IDS.map((id) => h('li', {}, h('button', { type: 'button', class: 'bh-starter', 'aria-label': `New ${model.TEMPLATES[id].name.toLowerCase()}`, onclick: () => newPlan(model.defaults(id), null) },
      thumb(model.defaults(id)), h('span', { text: model.TEMPLATES[id].name })))));
    const askBtn = h('button', { type: 'button', class: 'bh-btn', text: 'Ask Claude', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', onclick: (e) => openAsk(e.currentTarget) });
    box.replaceChildren(
      h('div', { class: 'bh-bar' }, h('h2', { class: 'bh-name', text: 'Projects' }), h('span', { class: 'bh-barbtns' }, askBtn, h('a', { class: 'bh-btn', href: '#/birdhouse/workshop', text: 'Workshop' }))),
      ask,
      h('p', { class: 'bh-say', id: 'bh-homesay', 'aria-live': 'polite' }),
      h('h3', { class: 'bh-h', text: 'Start something new' }), starters,
      h('h3', { class: 'bh-h', text: S.data.plans.length ? 'Your projects' : 'Your projects will show up here' }),
      S.data.plans.length ? h('ul', { class: 'bh-grid' }, ...S.data.plans.slice().sort((a, b) => b.updated.localeCompare(a.updated)).map(planCard))
        : h('p', { class: 'bh-note', text: 'Start one above. Every change is saved to your Roost login, so it is waiting on any device you sign in on.' }));
  }

  // ---------- the workshop: wood on hand, units and stock sizes ----------
  function drawShop() {
    const box = $('#bh-shop');
    const stock = S.data.stock;
    const kind = h('select', { 'aria-label': 'Kind of wood' }, h('option', { value: 'sheet', text: 'Sheet' }), h('option', { value: 'timber', text: 'Timber' }));
    const num = (label, ph) => h('input', { type: 'number', min: '0', step: 'any', inputmode: 'decimal', placeholder: ph, 'aria-label': label });
    const thick = num('Thickness', 'Thickness');
    const wide = num('Width', 'Width');
    const long = num('Length', 'Length');
    const qty = h('input', { type: 'number', min: '1', max: '50', step: '1', value: '1', inputmode: 'numeric', 'aria-label': 'How many' });
    const note = h('input', { type: 'text', maxlength: '60', placeholder: 'Note (optional)', 'aria-label': 'Note' });
    const say = h('p', { class: 'bh-say', 'aria-live': 'polite' });
    const add = h('form', { class: 'bh-addrow' }, kind, thick, wide, long, h('span', { class: 'bh-times', text: '×' }), qty, note, h('button', { type: 'submit', class: 'bh-btn solid', text: 'Add' }));
    add.addEventListener('submit', (e) => {
      e.preventDefault();
      const row = { kind: kind.value, thick: toMm(thick.value), w: toMm(wide.value), l: toMm(long.value), qty: Math.round(Number(qty.value)), note: note.value.trim() };
      if (![row.thick, row.w, row.l].every((v) => v >= 1 && v <= 10000) || !(row.qty >= 1 && row.qty <= 50)) { say.textContent = `Fill in thickness, width, length (${unit()}) and how many.`; return; }
      if (stock.length >= 200) { say.textContent = 'That is plenty of wood; remove some first.'; return; }
      S.data.stock = [...stock, { id: '', ...row }];
      saveStock();
      drawShop();
    });
    const rows = stock.map((it, i) => h('li', { class: 'bh-stockrow' },
      h('span', { class: 'bh-what', text: it.kind === 'sheet' ? `${fmtU(it.thick)} sheet, ${fmt(it.w)} × ${fmtU(it.l)}` : `${fmt(Math.min(it.w, it.thick))} × ${fmtU(Math.max(it.w, it.thick))} timber, ${fmtU(it.l)} long` }),
      it.note ? h('small', { text: it.note }) : null,
      h('span', { class: 'bh-qty' },
        h('button', { type: 'button', class: 'bh-step', text: '−', 'aria-label': 'One fewer', onclick: () => { it.qty = Math.max(1, it.qty - 1); saveStock(); drawShop(); } }),
        h('b', { text: String(it.qty) }),
        h('button', { type: 'button', class: 'bh-step', text: '+', 'aria-label': 'One more', onclick: () => { it.qty = Math.min(50, it.qty + 1); saveStock(); drawShop(); } })),
      h('button', { type: 'button', class: 'bh-link-btn', text: 'Remove', 'aria-label': `Remove ${it.kind} ${i + 1}`, onclick: () => { S.data.stock = stock.filter((x) => x !== it); saveStock(); drawShop(); } })));

    // Units and the stock sizes shops sell, used to lay out what you still need to buy.
    const p = prefs();
    const units = h('div', { class: 'bh-seg', role: 'group', 'aria-label': 'Units' }, ...[['mm', 'Millimetres'], ['in', 'Inches']].map(([id, name]) => h('button', {
      type: 'button', class: `bh-pick${p.units === id ? ' on' : ''}`, 'aria-pressed': String(p.units === id), text: name,
      onclick: () => { p.units = id; savePrefs(); drawShop(); },
    })));
    const size = (label, value, apply) => {
      const input = h('input', { type: 'number', min: '1', step: 'any', inputmode: 'decimal', value: fromMm(value), 'aria-label': label });
      input.addEventListener('change', () => { const mm = toMm(input.value); if (mm >= 300 && mm <= 6000) { apply(mm); savePrefs(); } drawShop(); });
      return h('label', { class: 'bh-field inline' }, h('span', { text: label }), input);
    };
    box.replaceChildren(
      h('div', { class: 'bh-bar' }, h('h2', { class: 'bh-name', text: 'Workshop' }), h('a', { class: 'bh-btn', href: '#/birdhouse', text: '‹ Projects' })),
      h('p', { class: 'bh-note', text: 'Wood you already have. Plans use it before anything is added to the shopping list.' }),
      h('h3', { class: 'bh-h', text: 'Wood on hand' }),
      stock.length ? h('ul', { class: 'bh-stocklist' }, ...rows) : h('p', { class: 'bh-note', text: 'Nothing listed yet.' }),
      h('p', { class: 'bh-note', text: `Add by ${unit()}. A sheet: thickness, width and length. Timber: thickness, width and length.` }),
      add, say,
      h('h3', { class: 'bh-h', text: 'Units and shop sizes' }),
      units,
      h('div', { class: 'bh-sizes' },
        size(`Sheet length (${unit()})`, p.sheet[0], (mm) => { p.sheet = [Math.max(mm, p.sheet[1]), Math.min(mm, p.sheet[1])]; }),
        size(`Sheet width (${unit()})`, p.sheet[1], (mm) => { p.sheet = [Math.max(p.sheet[0], mm), Math.min(p.sheet[0], mm)]; }),
        size(`Timber length (${unit()})`, p.timber, (mm) => { p.timber = mm; })),
      h('p', { class: 'bh-note', text: 'Sheet and timber sizes are what the shops sell; the Sheets tab and shopping list are worked out on them.' }));
  }

  // ---------- one project ----------
  function showEditor(plan) {
    S.id = plan.id;
    S.name = plan.name;
    S.d = model.clean(plan.plan);
    S.by = {};
    S.sig = JSON.stringify([S.d, S.name]);
    S.dirty = false;
    closeCard();
    $('#bh-say').textContent = '';
    $('#bh-saved').textContent = '';
    $('#bh-nest').classList.toggle('hidden', !hasNest());
    paint();
  }

  const screens = { home: '#bh-home', shop: '#bh-shop', editor: '#bh-editor' };
  function show(name) {
    S.screen = name === 'editor' ? 'editor' : name;
    for (const [k, sel] of Object.entries(screens)) $(sel).classList.toggle('hidden', k !== name);
  }

  window.birdhouseOpen = async (rest = []) => {
    document.title = 'Birdhouse';
    const ticket = ++S.ask;
    if (!S.built) {
      S.built = true;
      $('#bh-adjust').addEventListener('click', openCard);
      $('#bh-save').addEventListener('click', save);
      $('#bh-print').addEventListener('click', printPlan);
      $('#bh-ask').addEventListener('submit', (e) => { e.preventDefault(); draft($('#bh-text').value); });
      $('#bh-name').addEventListener('change', (e) => {
        S.name = e.target.value.replace(/\s+/g, ' ').trim().slice(0, 60) || info().name;
        e.target.value = S.name;
        paint();
      });
    }
    await flushAll();
    closeCard();
    const route = rest[0] || '';
    try {
      if (!S.loaded || route === '' || route === 'workshop') await load();
    } catch (err) {
      show('home');
      $('#bh-home').replaceChildren(h('p', { class: 'bh-note', text: `Couldn't open your projects: ${err.message}` }));
      return;
    }
    if (ticket !== S.ask) return; // another page was opened while this loaded
    if (route === 'workshop') { show('shop'); drawShop(); return; }
    if (route) {
      const plan = S.data.plans.find((p) => p.id === route);
      if (plan) { show('editor'); showEditor(plan); return; }
      location.replace('#/birdhouse');
      return;
    }
    S.id = null;
    show('home');
    drawHome();
  };
})();
