'use strict';

// Birdhouse: plan a build. Pick the sizes, see the drawing change as you go.
// Everything is worked out in the browser (see birdhouse-model.js); nothing is
// sent anywhere and nothing runs in the background. The last plan is kept on
// this device until saving to Nest arrives.

(() => {
  const model = window.birdhouseModel;
  const KEY = 'roost-birdhouse';
  const NS = 'http://www.w3.org/2000/svg';
  const S = { d: { ...model.DEFAULTS }, built: false, card: null, view: 'front', yaw: 0.6, pitch: 0.35, fields: {} };

  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (saved) S.d = model.clean(saved);
  } catch { /* private window or old data: start from the default */ }

  const remember = () => { try { localStorage.setItem(KEY, JSON.stringify(S.d)); } catch { /* keep going without saving */ } };
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

  // Flat views, drawn in millimetres so the shapes are true to size. Lines keep
  // one thickness however big the drawing is shown. `shapes` are boxes
  // ({ x, y, w, h, cls }) inside a width x height outline.
  function drawFlat(width, height, shapes, label) {
    const big = Math.max(width, height);
    const m = big * 0.16;
    const tick = big * 0.02;
    const fs = big * 0.04;
    const root = svg('svg', { viewBox: `${-m} ${-m * 0.7} ${width + m * 1.5} ${height + m * 1.6}`, role: 'img', 'aria-label': label });
    const line = (x1, y1, x2, y2) => svg('line', { x1, y1, x2, y2, class: 'bh-dim' });
    for (const b of shapes) root.append(svg('rect', { x: b.x, y: b.y, width: b.w, height: b.h, class: b.cls || 'bh-board' }));
    const yd = height + m * 0.5;
    root.append(line(0, yd, width, yd), line(0, yd - tick, 0, yd + tick), line(width, yd - tick, width, yd + tick),
      svg('text', { x: width / 2, y: yd + fs * 1.5, 'text-anchor': 'middle', 'font-size': fs, class: 'bh-label' }, String(width)));
    const xd = -m * 0.5;
    root.append(line(xd, 0, xd, height), line(xd - tick, 0, xd + tick, 0), line(xd - tick, height, xd + tick, height),
      svg('text', { x: xd - fs * 0.5, y: height / 2, 'text-anchor': 'middle', 'font-size': fs, class: 'bh-label', transform: `rotate(-90 ${xd - fs * 0.5} ${height / 2})` }, String(height)));
    return root;
  }

  function drawFront() {
    const f = model.front(S.d);
    return drawFlat(f.width, f.height, f.boards, `Front view, ${f.width} by ${f.height} millimetres`);
  }

  // From the side the side board hides the shelves, so they are dashed.
  function drawSide() {
    const v = model.side(S.d);
    const shapes = [{ x: 0, y: 0, w: v.width, h: v.height }, ...v.lines.map((l) => ({ x: 0, y: l.y, w: v.width, h: l.h, cls: 'bh-hidden' }))];
    return drawFlat(v.width, v.height, shapes, `Side view, ${v.width} by ${v.height} millimetres`);
  }

  function drawTop() {
    const v = model.top(S.d);
    const shapes = [{ x: 0, y: 0, w: v.width, h: v.height }, { x: v.thickness, y: 0, w: v.width - 2 * v.thickness, h: v.height, cls: 'bh-hidden' }];
    return drawFlat(v.width, v.height, shapes, `Top view, ${v.width} by ${v.height} millimetres`);
  }

  // The turning picture. The frame is sized once to fit the model from any
  // angle, so it doesn't jump about as it turns; only the faces are redrawn.
  function draw3d() {
    const d = S.d;
    const r = Math.sqrt(d.width ** 2 + d.depth ** 2 + d.height ** 2) / 2 * 1.08;
    const root = svg('svg', { viewBox: `${-r} ${-r} ${2 * r} ${2 * r}`, class: 'bh-3d', role: 'img', 'aria-label': `3D view of the ${d.width} by ${d.height} by ${d.depth} millimetre bookshelf, drag to turn` });
    const faces = svg('g');
    root.append(faces);
    const redraw = () => {
      faces.replaceChildren(...model.project(S.d, S.yaw, S.pitch).map((f) => svg('polygon', { points: f.pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' '), class: 'bh-face', 'fill-opacity': f.light })));
    };
    redraw();
    let at = null;
    let frame = 0;
    root.addEventListener('pointerdown', (e) => { at = [e.clientX, e.clientY]; root.setPointerCapture(e.pointerId); });
    root.addEventListener('pointermove', (e) => {
      if (!at) return;
      S.yaw += (e.clientX - at[0]) * 0.01;
      S.pitch = Math.min(1.3, Math.max(-0.3, S.pitch + (e.clientY - at[1]) * 0.01));
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
      S.pitch = Math.min(1.3, Math.max(-0.3, S.pitch + step[1]));
      redraw();
    });
    root.setAttribute('tabindex', '0');
    return root;
  }

  const VIEWS = [['front', 'Front', drawFront], ['side', 'Side', drawSide], ['top', 'Top', drawTop], ['3d', '3D', draw3d]];

  function tabs() {
    return VIEWS.map(([id, name]) => h('button', {
      type: 'button', role: 'tab', class: `bh-tab${S.view === id ? ' on' : ''}`, 'aria-selected': String(S.view === id), text: name,
      onclick: () => { S.view = id; paint(); },
    }));
  }

  // The cut list: what to saw, and how much board it adds up to.
  function cutList() {
    const rows = model.parts(S.d);
    const metres = rows.reduce((a, r) => a + r.qty * r.length, 0) / 1000;
    return h('div', {},
      h('h3', { class: 'bh-h', text: 'Cut list' }),
      h('table', { class: 'bh-table' },
        h('thead', {}, h('tr', {}, ...['Part', 'Qty', 'Length', 'Width', 'Thick'].map((t) => h('th', { text: t })))),
        h('tbody', {}, ...rows.map((r) => h('tr', {}, h('td', { text: r.name }), h('td', { text: String(r.qty) }), h('td', { text: `${r.length}` }), h('td', { text: `${r.width}` }), h('td', { text: `${r.thickness}` }))))),
      h('p', { class: 'bh-note', text: `${rows.reduce((a, r) => a + r.qty, 0)} boards, ${metres.toFixed(1)} m of ${S.d.depth} mm wide board · sizes in mm` }));
  }

  function chips() {
    const d = S.d;
    return [`H ${d.height}`, `W ${d.width}`, `D ${d.depth}`, `${d.shelves} shelves`, `Pine ${d.thickness}`].map((t) => h('span', { class: 'bh-chip', text: t }));
  }

  function titleBlock() {
    const d = S.d;
    const cell = (label, value) => h('div', {}, h('small', { text: label }), value);
    return h('div', { class: 'bh-title' }, cell('PROJECT', 'Bookshelf · pine'), cell('SIZE', `${d.width} × ${d.height} × ${d.depth}`), cell('UNITS', 'mm'), cell('SHEET', '1 / 1'));
  }

  function paint() {
    $('#bh-tabs').replaceChildren(...tabs());
    $('#bh-view').replaceChildren(VIEWS.find((v) => v[0] === S.view)[2]());
    $('#bh-cuts').replaceChildren(cutList());
    $('#bh-chips').replaceChildren(...chips());
    $('#bh-title').replaceChildren(titleBlock());
    remember();
  }

  // The Adjust card: opens beside the button, only as big as it needs, and
  // closes on Done, Escape or a tap outside it.
  function openCard() {
    if (S.card) return closeCard();
    S.fields = {};
    const rows = Object.entries(model.LIMITS).map(([key, lim]) => {
      const out = h('span', { class: 'bh-val', text: String(S.d[key]) });
      const input = h('input', { type: 'range', min: lim.min, max: lim.max, step: lim.step, value: S.d[key], 'aria-label': lim.label });
      input.addEventListener('input', () => {
        S.d = model.clean({ ...S.d, [key]: input.value });
        for (const [k, el] of Object.entries(S.fields)) { el.input.value = S.d[k]; el.out.textContent = S.d[k]; }
        paint();
      });
      S.fields[key] = { input, out };
      return h('label', { class: 'bh-slider' }, h('span', { class: 'bh-row' }, h('span', { text: lim.label }), out), input);
    });
    const card = h('div', { class: 'bh-card', role: 'dialog', 'aria-label': 'Adjust sizes' },
      h('div', { class: 'bh-card-head' }, h('b', { class: 'mono', text: 'Adjust' }), h('button', { type: 'button', class: 'bh-x', 'aria-label': 'Close', text: '✕', onclick: closeCard })),
      ...rows,
      h('div', { class: 'bh-actions' },
        h('button', { type: 'button', class: 'bh-btn solid', text: 'Done', onclick: closeCard }),
        h('button', { type: 'button', class: 'bh-btn', text: 'Reset', onclick: () => { S.d = { ...model.DEFAULTS }; closeCard(); paint(); openCard(); } })));
    S.card = card;
    $('#view-birdhouse').append(card);
    $('#bh-adjust').setAttribute('aria-expanded', 'true');
    setTimeout(() => document.addEventListener('pointerdown', outside), 0);
    document.addEventListener('keydown', escape);
    card.querySelector('input').focus({ preventScroll: true });
  }
  const outside = (e) => { if (S.card && !S.card.contains(e.target) && !$('#bh-adjust').contains(e.target)) closeCard(); };
  const escape = (e) => { if (e.key === 'Escape') { closeCard(); $('#bh-adjust').focus(); } };

  function closeCard() {
    if (!S.card) return;
    S.card.remove();
    S.card = null;
    S.fields = {};
    $('#bh-adjust').setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside);
    document.removeEventListener('keydown', escape);
  }

  window.birdhouseOpen = () => {
    document.title = 'Birdhouse';
    if (!S.built) {
      S.built = true;
      $('#bh-adjust').addEventListener('click', openCard);
    }
    closeCard();
    paint();
  };
})();
