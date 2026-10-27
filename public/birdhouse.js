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
  const S = { d: model.defaults('bookshelf'), by: {}, built: false, card: null, fields: {}, view: 'front', yaw: 0.6, pitch: 0.35 };

  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (saved) {
      S.d = model.clean(saved.d || saved); // plans saved by the first version were the sizes alone
      for (const [id, d] of Object.entries(saved.by || {})) if (model.TEMPLATES[id]) S.by[id] = model.clean({ ...d, template: id });
    }
  } catch { /* private window or old data: start from the default */ }

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

  const VIEWS = [['front', 'Front', () => drawFlat('front', 'Front')], ['side', 'Side', () => drawFlat('side', 'Side')], ['top', 'Top', () => drawFlat('top', 'Top')], ['3d', '3D', draw3d]];

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
        h('thead', {}, h('tr', {}, ...['Part', 'Qty', 'Length', 'Width', 'Thick'].map((t) => h('th', { text: t })))),
        h('tbody', {}, ...rows.map((r) => h('tr', {}, h('td', { text: r.name }), h('td', { text: String(r.qty) }), h('td', { text: `${r.length}` }), h('td', { text: `${r.width}` }), h('td', { text: `${r.thickness}` }))))),
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

  const fill = () => { if (S.card) S.card.querySelector('.bh-body').replaceChildren(...cardBody()); };

  function openCard() {
    if (S.card) return closeCard();
    const card = h('div', { class: 'bh-card', role: 'dialog', 'aria-label': 'Adjust' },
      h('div', { class: 'bh-card-head' }, h('b', { class: 'mono', text: 'Adjust' }), h('button', { type: 'button', class: 'bh-x', 'aria-label': 'Close', text: '✕', onclick: closeCard })),
      h('div', { class: 'bh-body' }),
      h('div', { class: 'bh-actions' },
        h('button', { type: 'button', class: 'bh-btn solid', text: 'Done', onclick: closeCard }),
        h('button', { type: 'button', class: 'bh-btn', text: 'Reset', onclick: () => { S.d = model.defaults(S.d.template); fill(); paint(); } })));
    S.card = card;
    fill();
    $('#view-birdhouse').append(card);
    $('#bh-adjust').setAttribute('aria-expanded', 'true');
    setTimeout(() => document.addEventListener('pointerdown', outside), 0);
    document.addEventListener('keydown', escape);
    card.querySelector('.bh-pick.on').focus({ preventScroll: true });
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
