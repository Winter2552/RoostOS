'use strict';

// Birdhouse: plan a build. Pick the sizes, see the drawing change as you go.
// Everything is worked out in the browser (see birdhouse-model.js); nothing is
// sent anywhere and nothing runs in the background. The last plan is kept on
// this device until saving to Nest arrives.

(() => {
  const model = window.birdhouseModel;
  const KEY = 'roost-birdhouse';
  const NS = 'http://www.w3.org/2000/svg';
  const S = { d: { ...model.DEFAULTS }, built: false, card: null };

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

  // The front view, drawn in millimetres so the shapes are true to size. Lines
  // keep one thickness however big the drawing is shown.
  function drawFront() {
    const f = model.front(S.d);
    const big = Math.max(f.width, f.height);
    const m = big * 0.16;
    const tick = big * 0.02;
    const fs = big * 0.04;
    const root = svg('svg', { viewBox: `${-m} ${-m * 0.7} ${f.width + m * 1.5} ${f.height + m * 1.6}`, role: 'img', 'aria-label': `Front view, ${f.width} by ${f.height} millimetres` });
    const line = (x1, y1, x2, y2, cls) => svg('line', { x1, y1, x2, y2, class: cls });
    for (const b of f.boards) root.append(svg('rect', { x: b.x, y: b.y, width: b.w, height: b.h, class: 'bh-board' }));
    const yd = f.height + m * 0.5;
    root.append(
      line(0, yd, f.width, yd, 'bh-dim'), line(0, yd - tick, 0, yd + tick, 'bh-dim'), line(f.width, yd - tick, f.width, yd + tick, 'bh-dim'),
      svg('text', { x: f.width / 2, y: yd + fs * 1.5, 'text-anchor': 'middle', 'font-size': fs, class: 'bh-label' }, String(f.width)));
    const xd = -m * 0.5;
    const rot = svg('text', { x: xd - fs * 0.5, y: f.height / 2, 'text-anchor': 'middle', 'font-size': fs, class: 'bh-label', transform: `rotate(-90 ${xd - fs * 0.5} ${f.height / 2})` }, String(f.height));
    root.append(line(xd, 0, xd, f.height, 'bh-dim'), line(xd - tick, 0, xd + tick, 0, 'bh-dim'), line(xd - tick, f.height, xd + tick, f.height, 'bh-dim'), rot);
    return root;
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
    $('#bh-view').replaceChildren(drawFront());
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
