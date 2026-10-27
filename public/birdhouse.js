'use strict';

// Birdhouse: plan a build. Pick a project, set the sizes, see the drawing
// change as you go. Everything is worked out in the browser (see
// birdhouse-model.js); nothing is sent anywhere and nothing runs in the
// background. The last plans are kept on this device until saving to Nest
// arrives.

(() => {
  const model = window.birdhouseModel;
  const KEY = 'roost-birdhouse';
  const NS = 'http://www.w3.org/2000/svg';
  // d is the plan on show; by remembers the sizes last used for each project.
  const S = { d: model.defaults('bookshelf'), by: {}, built: false, card: null, cardButton: null, fields: {}, view: 'front', yaw: 0.6, pitch: 0.35 };

  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (saved) {
      S.d = model.clean(saved.d || saved); // plans saved by the first version were the sizes alone
      for (const [id, d] of Object.entries(saved.by || {})) if (model.TEMPLATES[id]) S.by[id] = model.clean({ ...d, template: id });
    }
  } catch { /* private window or old data: start from the default */ }

  // The price book: the prices the person has set, by material, with the day
  // each was set. Kept on this device; the same prices serve every plan.
  const PRICES = 'roost-birdhouse-prices';
  let prices = {};
  try { prices = JSON.parse(localStorage.getItem(PRICES) || '{}') || {}; } catch { /* start with the guesses */ }
  const savePrices = () => { try { localStorage.setItem(PRICES, JSON.stringify(prices)); } catch { /* keep going without saving */ } };
  const today = () => new Date().toISOString().slice(0, 10);
  const money = (n) => `£${n.toFixed(2)}`;
  const priceOf = (m) => (prices[m.key] && Number.isFinite(prices[m.key].p) ? prices[m.key].p : m.estimate);
  const ageDays = (day) => Math.floor((Date.now() - Date.parse(day)) / 864e5);
  const shops = [['Wickes', (q) => `https://www.wickes.co.uk/search?text=${encodeURIComponent(q)}`], ['B&Q', (q) => `https://www.diy.com/search?term=${encodeURIComponent(q)}`]];

  const remember = () => {
    S.by[S.d.template] = S.d;
    try { localStorage.setItem(KEY, JSON.stringify({ d: S.d, by: S.by })); } catch { /* keep going without saving */ }
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
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c != null) n.append(c);
    return n;
  };
  const info = () => model.info(S.d);

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
    const root = svg('svg', { viewBox: `${-m} ${-m * 0.7} ${width + m * 1.5} ${height + m * 1.6}`, role: 'img', 'aria-label': `${name} view, ${width} by ${height} millimetres` });
    const line = (x1, y1, x2, y2) => svg('line', { x1, y1, x2, y2, class: 'bh-dim' });
    for (const b of v.shapes) root.append(svg('rect', { x: b.x, y: b.y, width: b.w, height: b.h, class: b.hidden ? 'bh-hidden' : 'bh-board' }));
    const yd = height + m * 0.5;
    root.append(line(0, yd, width, yd), line(0, yd - tick, 0, yd + tick), line(width, yd - tick, width, yd + tick),
      svg('text', { x: width / 2, y: yd + fs * 1.5, 'text-anchor': 'middle', 'font-size': fs, class: 'bh-label' }, String(width)));
    const xd = -m * 0.5;
    root.append(line(xd, 0, xd, height), line(xd - tick, 0, xd + tick, 0), line(xd - tick, height, xd + tick, height),
      svg('text', { x: xd - fs * 0.5, y: height / 2, 'text-anchor': 'middle', 'font-size': fs, class: 'bh-label', transform: `rotate(-90 ${xd - fs * 0.5} ${height / 2})` }, String(height)));
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
    const items = model.materials(S.d);
    const total = h('b', { class: 'bh-total' });
    const lines = [];
    const sum = () => { total.textContent = money(items.reduce((a, m) => a + m.qty * priceOf(m), 0)); };
    // Fetch price only shows when an admin has switched it on; asked about once.
    if (S.fetchOn === undefined) {
      S.fetchOn = false;
      api('GET', '/api/birdhouse').then((r) => { S.fetchOn = r.fetch; if (r.fetch && S.view === 'cost') paint(); }).catch(() => {});
    }
    const rows = items.map((m) => {
      const note = h('span', { class: 'bh-age' });
      const has = () => prices[m.key] && Number.isFinite(prices[m.key].p);
      const showAge = () => {
        const q = prices[m.key];
        const old = has() && ageDays(q.at) > 30;
        note.textContent = !has() ? 'guess' : `${q.src ? `fetched from ${q.src}` : 'set'} ${q.at}${old ? ', old' : ''}`;
        note.classList.toggle('old', Boolean(old));
      };
      const line = h('td', { class: 'bh-num' });
      const showLine = () => { line.textContent = money(m.qty * priceOf(m)); };
      const input = h('input', { type: 'number', min: '0', max: '10000', step: '0.01', inputmode: 'decimal', value: priceOf(m).toFixed(2), 'aria-label': `Price of ${m.label}` });
      const record = (entry) => {
        const keep = prices[m.key] && prices[m.key].url ? { url: prices[m.key].url } : {};
        if (entry) prices[m.key] = { ...keep, ...entry }; else if (keep.url) prices[m.key] = keep; else delete prices[m.key];
        input.value = priceOf(m).toFixed(2);
        savePrices(); showAge(); showLine(); sum();
      };
      input.addEventListener('change', () => {
        const v = Number(input.value);
        record(input.value === '' || !Number.isFinite(v) || v < 0 ? null : { p: Math.min(10000, Math.round(v * 100) / 100), at: today() });
      });
      showAge(); showLine();
      let fetcher = null;
      if (S.fetchOn) {
        const link = h('input', { type: 'url', class: 'bh-link', placeholder: 'Product page link (Wickes or B&Q)', maxlength: '500', value: (prices[m.key] && prices[m.key].url) || '', 'aria-label': `Product page for ${m.label}` });
        const say = h('span', { class: 'bh-age' });
        const go = h('button', { type: 'button', class: 'bh-btn bh-small', text: 'Fetch price' });
        link.addEventListener('change', () => { prices[m.key] = { ...(prices[m.key] || {}), url: link.value.trim() }; if (!prices[m.key].url) delete prices[m.key].url; if (!Object.keys(prices[m.key]).length) delete prices[m.key]; savePrices(); });
        go.addEventListener('click', async () => {
          const url = link.value.trim();
          if (!url) { say.textContent = 'Paste the product page link first.'; return; }
          go.disabled = true;
          say.textContent = 'Reading the page…';
          try {
            const r = await api('POST', '/api/birdhouse/price', { url });
            record({ p: r.price, at: today(), src: r.shop, url });
            say.textContent = '';
          } catch (err) {
            say.textContent = err.message; // quietly: the price can always be typed in
          } finally {
            go.disabled = false;
          }
        });
        fetcher = h('tr', { class: 'bh-fetchrow' }, h('td', { colspan: '5' }, h('div', { class: 'bh-fetch' }, link, go, say)));
      }
      return [h('tr', { class: fetcher ? 'bh-hasfetch' : '' },
        h('td', {}, m.label, h('br'), note),
        h('td', { class: 'bh-num', text: String(m.qty) }),
        h('td', {}, h('span', { class: 'bh-pound', text: '£' }), input),
        line,
        h('td', { class: 'bh-shops' }, ...shops.map(([name, url]) => h('a', { href: url(m.search), target: '_blank', rel: 'noopener', text: name, 'aria-label': `Check ${m.label} at ${name}` })))), fetcher];
    });
    sum();
    return h('div', { class: 'bh-cost' },
      h('h3', { class: 'bh-h', text: 'What to buy' }),
      h('table', { class: 'bh-table' },
        h('thead', {}, h('tr', {}, ...['Material', 'Qty', 'Each', 'Total', 'Check'].map((t) => h('th', { text: t })))),
        h('tbody', {}, ...rows),
        h('tfoot', {}, h('tr', {}, h('td', { text: 'Estimate' }), h('td'), h('td'), h('td', { class: 'bh-num' }, total), h('td')))),
      h('p', { class: 'bh-note', text: `Starter prices are rough guesses. Tap a shop to see its price, then type it in: it is kept here with the date.${S.fetchOn ? ' Fetch price reads one product page when you press it.' : ' Nothing is sent to the shops.'}` }));
  }

  const letter = (i) => String.fromCharCode(65 + i);

  // The boards laid out on sheets of stock: what to cut from where.
  function drawSheets() {
    const l = model.layout(S.d);
    const box = h('div', { class: 'bh-sheets' });
    l.sheets.forEach((sheet, n) => {
      const root = svg('svg', { viewBox: `-20 -20 ${l.width + 40} ${l.height + 40}`, role: 'img', 'aria-label': `Sheet ${n + 1}, ${sheet.thickness} millimetre board, ${sheet.pieces.length} pieces` });
      root.append(svg('rect', { x: 0, y: 0, width: l.width, height: l.height, class: 'bh-stock' }));
      for (const p of sheet.pieces) {
        root.append(svg('rect', { x: p.x, y: p.y, width: p.w, height: p.h, class: 'bh-board' }));
        if (Math.min(p.w, p.h) > 90) root.append(svg('text', { x: p.x + p.w / 2, y: p.y + p.h / 2 + 30, 'text-anchor': 'middle', 'font-size': 90, class: 'bh-label' }, letter(p.part)));
      }
      box.append(h('h3', { class: 'bh-h', text: `Sheet ${n + 1} · ${sheet.thickness} mm · ${l.width} × ${l.height}` }), root);
    });
    for (const g of l.timber) {
      const bars = g.bars.length;
      const root = svg('svg', { viewBox: `-20 -10 ${g.stock + 40} ${bars * 150 + 10}`, class: 'bh-bars', role: 'img', 'aria-label': `${g.width} by ${g.thickness} timber, ${bars} length${bars === 1 ? '' : 's'}` });
      g.bars.forEach((bar, i) => {
        const y = i * 150;
        root.append(svg('rect', { x: 0, y, width: g.stock, height: 120, class: 'bh-stock' }));
        for (const p of bar.pieces) {
          root.append(svg('rect', { x: p.x, y, width: p.len, height: 120, class: 'bh-board' }));
          if (p.len > 160) root.append(svg('text', { x: p.x + p.len / 2, y: y + 82, 'text-anchor': 'middle', 'font-size': 70, class: 'bh-label' }, letter(p.part)));
        }
      });
      box.append(h('h3', { class: 'bh-h', text: `${bars} × ${g.stock} mm length${bars === 1 ? '' : 's'} of ${g.width} × ${g.thickness} timber` }), root);
    }
    const waste = l.area ? Math.round((1 - l.used / l.area) * 100) : 0;
    const bits = [];
    if (l.sheets.length) bits.push(`${l.sheets.length} sheet${l.sheets.length === 1 ? '' : 's'}, ${waste}% left over`);
    if (l.timber.length) { const n = l.timber.reduce((a, g) => a + g.bars.length, 0); bits.push(`${n} length${n === 1 ? '' : 's'} of timber`); }
    box.append(h('p', { class: 'bh-note', text: `${bits.join(' · ')} · 3 mm saw cut between boards · letters match the cut list` }));
    if (l.tooBig.length) box.append(h('p', { class: 'bh-warn', text: `Too big for a ${l.width} × ${l.height} sheet: ${[...new Set(l.tooBig.map((t) => letter(t.part)))].join(', ')}. Make it smaller or join boards.` }));
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
        h('tbody', {}, ...rows.map((r, i) => h('tr', {}, h('td', { class: 'bh-key', text: letter(i) }), h('td', { text: r.name }), h('td', { text: String(r.qty) }), h('td', { text: `${r.length}` }), h('td', { text: `${r.width}` }), h('td', { text: `${r.thickness}` }))))),
      h('p', { class: 'bh-note', text: `${rows.reduce((a, r) => a + r.qty, 0)} boards · ${area.toFixed(2)} m² of board · sizes in mm` }));
  }

  function titleBlock() {
    const s = model.size(S.d);
    const cell = (label, value) => h('div', {}, h('small', { text: label }), value);
    return h('div', { class: 'bh-title' }, cell('PROJECT', `${info().name} · pine`), cell('SIZE', `${s.width} × ${s.depth} × ${s.height}`), cell('UNITS', 'mm'), cell('SHEET', '1 / 1'));
  }

  function paint() {
    $('#bh-name').textContent = info().name;
    $('#bh-chips').replaceChildren(...info().chips(S.d).map((t) => h('span', { class: 'bh-chip', text: t })));
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
    const rows = Object.entries(info().limits).map(([key, lim]) => {
      const out = h('span', { class: 'bh-val', text: String(S.d[key]) });
      const input = h('input', { type: 'range', min: lim.min, max: lim.max, step: lim.step, value: S.d[key], 'aria-label': lim.label });
      input.addEventListener('input', () => {
        S.d = model.clean({ ...S.d, [key]: input.value });
        for (const [k, f] of Object.entries(S.fields)) { f.input.value = S.d[k]; f.out.textContent = S.d[k]; }
        paint();
      });
      S.fields[key] = { input, out };
      return h('label', { class: 'bh-slider' }, h('span', { class: 'bh-row' }, h('span', { text: lim.label }), out), input);
    });
    return [projects, ...rows];
  }

  const fill = () => { const body = S.card && S.card.querySelector('.bh-body'); if (body) body.replaceChildren(...cardBody()); };

  // One small floating card at a time (Adjust, or My plans), only as big as it
  // needs; it closes on Done, Escape or a tap outside it.
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

  // ---------- Nest: saving and reopening plans ----------
  // A plan is a few hundred bytes of JSON in Nest's Birdhouse folder, so it is
  // backed up and shared like any other file. Nothing is read or written until
  // Save or My plans is pressed.

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
      const name = `${info().name} ${sz.width}x${sz.depth}x${sz.height}${EXT}`;
      const bytes = new TextEncoder().encode(JSON.stringify({ app: 'birdhouse', version: 1, plan: S.d }));
      const up = await api('POST', '/api/nest/uploads', { parent: folder.id, name, size: bytes.length, type: 'application/json' });
      if (!up.done) {
        const res = await fetch(`/api/nest/uploads/${up.id}?offset=0`, { method: 'PUT', body: bytes, credentials: 'same-origin' });
        const out = await res.json().catch(() => ({}));
        if (!res.ok || !out.done) throw new Error(out.error || 'Could not save');
      }
      say.textContent = `Saved in Nest, in the ${FOLDER} folder.`;
    } catch (err) {
      say.textContent = `Not saved: ${err.message}`;
    } finally {
      btn.disabled = false;
    }
  }

  // The Birdhouse folder, found by name in the top of My Drive (null if none yet).
  async function findFolder() {
    for (let offset = 0, page = 0; page < 10; page++) {
      const d = await api('GET', `/api/nest/folders/root?folders=1&offset=${offset}`);
      const hit = d.items.find((i) => i.kind === 'folder' && i.name === FOLDER);
      if (hit) return hit;
      if (!d.more) return null;
      offset += d.items.length;
    }
    return null;
  }

  async function openPlans() {
    if (S.card) { const same = S.cardButton === $('#bh-plans'); closeCard(); if (same) return; }
    const list = h('div', { class: 'bh-list' }, h('p', { class: 'bh-note', text: 'Looking in Nest…' }));
    popup('My plans', $('#bh-plans'), list);
    const failed = (text) => list.replaceChildren(h('p', { class: 'bh-note', text }));
    try {
      const folder = await findFolder();
      if (!S.card) return;
      if (!folder) return failed('Nothing saved yet. Press Save to Nest to keep this plan.');
      const d = await api('GET', `/api/nest/folders/${folder.id}?sort=modified&dir=desc`);
      const files = d.items.filter((i) => i.kind === 'file' && i.name.endsWith(EXT));
      if (!S.card) return;
      if (!files.length) return failed('Nothing saved yet. Press Save to Nest to keep this plan.');
      list.replaceChildren(...files.map((f) => h('button', { type: 'button', class: 'bh-plan', onclick: () => openPlan(f) },
        h('span', { text: f.name.slice(0, -EXT.length) }), h('small', { text: new Date(f.modified).toLocaleDateString() }))));
    } catch (err) {
      failed(`Couldn't open Nest: ${err.message}`);
    }
  }

  async function openPlan(f) {
    const say = $('#bh-saved');
    try {
      if (f.size > 20000) throw new Error('that file is too big to be a plan');
      const res = await fetch(`/api/nest/files/${f.id}`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`Nest said ${res.status}`);
      const data = JSON.parse(await res.text());
      if (!data || data.app !== 'birdhouse' || !data.plan) throw new Error("that isn't a Birdhouse plan");
      S.d = model.clean(data.plan);
      closeCard();
      paint();
      say.textContent = `Opened ${f.name.slice(0, -EXT.length)}.`;
    } catch (err) {
      say.textContent = `Couldn't open it: ${err.message}`;
      closeCard();
    }
  }

  // The sentence box: reads what was typed, redraws, and says what it did, so a
  // number it could not place is never quietly dropped.
  function draft(text) {
    const say = $('#bh-say');
    const p = model.parse(text, S.d.template);
    if (!p.template && !Object.keys(p.set).length && !p.unused.length) {
      say.textContent = 'Try: bookshelf 1800 tall, 800 wide, 5 shelves';
      return;
    }
    if (p.template && p.template !== S.d.template) {
      S.by[S.d.template] = S.d;
      S.d = model.defaults(p.template);
    }
    S.d = model.clean({ ...S.d, ...p.set });
    const t = model.info(S.d);
    const said = Object.keys(p.set).map((k) => `${t.limits[k].label.toLowerCase()} ${S.d[k]}`);
    say.textContent = `${p.template ? `Drafted a ${t.name.toLowerCase()}` : `Changed the ${t.name.toLowerCase()}`}${said.length ? `: ${said.join(', ')}` : ''}.${p.unused.length ? ` Couldn't place ${p.unused.join(', ')}: say what it is, like "55 thick".` : ''}`;
    fill();
    paint();
  }

  window.birdhouseOpen = () => {
    document.title = 'Birdhouse';
    if (!S.built) {
      S.built = true;
      $('#bh-adjust').addEventListener('click', openCard);
      $('#bh-save').addEventListener('click', save);
      $('#bh-plans').addEventListener('click', openPlans);
      $('#bh-ask').addEventListener('submit', (e) => { e.preventDefault(); draft($('#bh-text').value); });
    }
    closeCard();
    $('#bh-foot').classList.toggle('hidden', !hasNest());
    paint();
  };
})();
