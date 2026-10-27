'use strict';

// Birdhouse's plans: a template turns a few sizes (millimetres) into boards.
// Pure arithmetic, no page code, so the browser and the tests share it.
//
// Each template only says what its boards are (a box in millimetres: x across,
// y front to back, z up). The front, side and top views, the cut list and the
// 3D picture are all worked out from those boards, so a new template is just
// a new list of boards.

(() => {
  const range = (min, max, step, label) => ({ min, max, step, label });

  const TEMPLATES = {
    bookshelf: {
      name: 'Bookshelf',
      // "shelves" counts every horizontal board, top and bottom included.
      limits: { height: range(300, 2400, 10, 'Height'), width: range(200, 2400, 10, 'Width'), depth: range(100, 800, 10, 'Depth'), shelves: range(2, 12, 1, 'Shelves'), thickness: range(6, 40, 1, 'Board thickness') },
      defaults: { height: 1800, width: 800, depth: 300, shelves: 5, thickness: 18 },
      words: { height: ['tall', 'high', 'height'], width: ['wide', 'width', 'across'], depth: ['deep', 'depth'], shelves: ['shelves', 'shelf', 'boards'], thickness: ['thick', 'thickness'] },
      order: ['height', 'width', 'depth'],
      fit(d) { d.thickness = Math.min(d.thickness, Math.floor((d.width - 20) / 2), Math.floor(d.height / (d.shelves * 2))); },
      chips: (d, f = String) => [`H ${f(d.height)}`, `W ${f(d.width)}`, `D ${f(d.depth)}`, `${d.shelves} shelves`, `Pine ${f(d.thickness)}`],
      solids(d) {
        const t = d.thickness;
        const out = [
          { name: 'Side', x: 0, y: 0, z: 0, w: t, d: d.depth, h: d.height },
          { name: 'Side', x: d.width - t, y: 0, z: 0, w: t, d: d.depth, h: d.height },
        ];
        const span = d.height - t;
        for (let i = 0; i < d.shelves; i++) {
          const end = i === 0 || i === d.shelves - 1;
          out.push({ name: end ? 'Top and bottom' : 'Shelf', x: t, y: 0, z: Math.round((span * i) / (d.shelves - 1)), w: d.width - 2 * t, d: d.depth, h: t });
        }
        return out;
      },
    },

    table: {
      name: 'Table',
      limits: { height: range(300, 1200, 10, 'Height'), width: range(400, 3000, 10, 'Length'), depth: range(300, 1200, 10, 'Width'), thickness: range(12, 60, 1, 'Top thickness'), leg: range(30, 120, 5, 'Leg size') },
      defaults: { height: 740, width: 1200, depth: 700, thickness: 25, leg: 60 },
      words: { width: ['long', 'length'], depth: ['wide', 'width', 'deep', 'depth'], height: ['tall', 'high', 'height'], thickness: ['thick', 'thickness'], leg: ['leg', 'legs'] },
      order: ['width', 'depth', 'height'],
      fit(d) { d.leg = Math.min(d.leg, Math.floor((Math.min(d.width, d.depth) - 20) / 4)); d.thickness = Math.min(d.thickness, Math.floor(d.height / 4)); },
      chips: (d, f = String) => [`L ${f(d.width)}`, `W ${f(d.depth)}`, `H ${f(d.height)}`, `Top ${f(d.thickness)}`, `Legs ${f(d.leg)}`],
      solids(d) {
        const ov = Math.min(30, Math.floor(d.width / 10)); // the top overhangs the legs a little
        const lg = d.leg;
        const apron = Math.min(80, Math.floor(d.height / 5));
        const at = 20;
        const lh = d.height - d.thickness;
        const out = [{ name: 'Top', x: 0, y: 0, z: lh, w: d.width, d: d.depth, h: d.thickness }];
        for (const x of [ov, d.width - ov - lg]) for (const y of [ov, d.depth - ov - lg]) out.push({ name: 'Leg', x, y, z: 0, w: lg, d: lg, h: lh });
        const az = lh - apron;
        const run = d.width - 2 * ov - 2 * lg;
        const gap = d.depth - 2 * ov - 2 * lg;
        for (const y of [ov, d.depth - ov - at]) out.push({ name: 'Long apron', x: ov + lg, y, z: az, w: run, d: at, h: apron });
        for (const x of [ov, d.width - ov - at]) out.push({ name: 'Short apron', x, y: ov + lg, z: az, w: at, d: gap, h: apron });
        return out;
      },
    },

    box: {
      name: 'Box',
      limits: { width: range(100, 1200, 10, 'Width'), depth: range(100, 900, 10, 'Depth'), height: range(50, 800, 10, 'Height'), thickness: range(4, 30, 1, 'Board thickness') },
      defaults: { width: 400, depth: 300, height: 200, thickness: 12 },
      words: { width: ['wide', 'width', 'long', 'length'], depth: ['deep', 'depth'], height: ['tall', 'high', 'height'], thickness: ['thick', 'thickness'] },
      order: ['width', 'depth', 'height'],
      fit(d) { d.thickness = Math.min(d.thickness, Math.floor((Math.min(d.width, d.depth) - 20) / 2), Math.floor(d.height / 2)); },
      chips: (d, f = String) => [`W ${f(d.width)}`, `D ${f(d.depth)}`, `H ${f(d.height)}`, `Board ${f(d.thickness)}`],
      solids(d) {
        const t = d.thickness;
        const wall = d.height - t;
        return [
          { name: 'Bottom', x: 0, y: 0, z: 0, w: d.width, d: d.depth, h: t },
          { name: 'Front and back', x: 0, y: 0, z: t, w: d.width, d: t, h: wall },
          { name: 'Front and back', x: 0, y: d.depth - t, z: t, w: d.width, d: t, h: wall },
          { name: 'End', x: 0, y: t, z: t, w: t, d: d.depth - 2 * t, h: wall },
          { name: 'End', x: d.width - t, y: t, z: t, w: t, d: d.depth - 2 * t, h: wall },
        ];
      },
    },

    bench: {
      name: 'Bench',
      limits: { width: range(300, 2400, 10, 'Length'), depth: range(150, 600, 10, 'Width'), height: range(200, 700, 10, 'Height'), thickness: range(15, 60, 1, 'Seat thickness') },
      defaults: { width: 1000, depth: 350, height: 450, thickness: 30 },
      words: { width: ['long', 'length'], depth: ['wide', 'width', 'deep', 'depth'], height: ['tall', 'high', 'height'], thickness: ['thick', 'thickness', 'seat'] },
      order: ['width', 'depth', 'height'],
      fit(d) { d.thickness = Math.min(d.thickness, Math.floor(d.height / 3)); },
      chips: (d, f = String) => [`L ${f(d.width)}`, `W ${f(d.depth)}`, `H ${f(d.height)}`, `Seat ${f(d.thickness)}`],
      solids(d) {
        const inset = Math.min(60, Math.floor(d.width / 8));
        const pt = 25;
        const lh = d.height - d.thickness;
        const strap = Math.min(100, Math.floor(lh / 2));
        return [
          { name: 'Seat', x: 0, y: 0, z: lh, w: d.width, d: d.depth, h: d.thickness },
          { name: 'End panel', x: inset, y: 30, z: 0, w: pt, d: d.depth - 60, h: lh },
          { name: 'End panel', x: d.width - inset - pt, y: 30, z: 0, w: pt, d: d.depth - 60, h: lh },
          { name: 'Stretcher', x: inset + pt, y: Math.round((d.depth - 20) / 2), z: lh - strap, w: d.width - 2 * inset - 2 * pt, d: 20, h: strap },
        ];
      },
    },

    cabinet: {
      name: 'Cabinet',
      limits: { height: range(300, 2000, 10, 'Height'), width: range(300, 1200, 10, 'Width'), depth: range(200, 700, 10, 'Depth'), shelves: range(0, 6, 1, 'Shelves inside'), doors: range(0, 2, 1, 'Doors'), thickness: range(12, 25, 1, 'Board thickness') },
      defaults: { height: 900, width: 600, depth: 350, shelves: 1, doors: 2, thickness: 18 },
      words: { height: ['tall', 'high', 'height'], width: ['wide', 'width'], depth: ['deep', 'depth'], shelves: ['shelves', 'shelf'], doors: ['doors', 'door'], thickness: ['thick', 'thickness'] },
      order: ['height', 'width', 'depth'],
      fit(d) { d.thickness = Math.min(d.thickness, Math.floor((d.width - 20) / 4), Math.floor(d.height / 6)); },
      chips: (d, f = String) => [`H ${f(d.height)}`, `W ${f(d.width)}`, `D ${f(d.depth)}`, `${d.shelves === 1 ? '1 shelf' : `${d.shelves} shelves`}`, `${d.doors} door${d.doors === 1 ? '' : 's'}`, `Pine ${f(d.thickness)}`],
      solids(d) {
        const t = d.thickness;
        const back = 6; // hardboard back
        const front = d.doors ? t : 0; // doors sit on the front
        const cd = d.depth - front; // the box behind the doors
        const inner = d.width - 2 * t;
        const out = [
          { name: 'Side', x: 0, y: front, z: 0, w: t, d: cd, h: d.height },
          { name: 'Side', x: d.width - t, y: front, z: 0, w: t, d: cd, h: d.height },
          { name: 'Top', x: t, y: front, z: d.height - t, w: inner, d: cd, h: t },
          { name: 'Bottom', x: t, y: front, z: 0, w: inner, d: cd, h: t },
          { name: 'Back', x: t, y: d.depth - back, z: t, w: inner, d: back, h: d.height - 2 * t },
        ];
        const room = d.height - 2 * t;
        for (let i = 1; i <= d.shelves; i++) out.push({ name: 'Shelf', x: t, y: front, z: t + Math.round((room * i) / (d.shelves + 1)) - Math.round(t / 2), w: inner, d: cd - back, h: t });
        if (d.doors) {
          const dw = d.doors === 2 ? Math.floor((d.width - 6) / 2) : d.width - 4;
          for (let i = 0; i < d.doors; i++) out.push({ name: 'Door', x: 2 + i * (dw + 2), y: 0, z: 2, w: dw, d: t, h: d.height - 4 });
        }
        return out;
      },
    },

    desk: {
      name: 'Desk',
      limits: { width: range(800, 2000, 10, 'Length'), depth: range(400, 900, 10, 'Width'), height: range(600, 900, 10, 'Height'), thickness: range(18, 40, 1, 'Top thickness'), panel: range(15, 30, 1, 'Side panel thickness') },
      defaults: { width: 1400, depth: 700, height: 740, thickness: 25, panel: 18 },
      words: { width: ['long', 'length'], depth: ['wide', 'width', 'deep', 'depth'], height: ['tall', 'high', 'height'], thickness: ['thick', 'thickness', 'top'], panel: ['panel', 'panels'] },
      order: ['width', 'depth', 'height'],
      fit(d) { d.panel = Math.min(d.panel, Math.floor(d.width / 10)); },
      chips: (d, f = String) => [`L ${f(d.width)}`, `W ${f(d.depth)}`, `H ${f(d.height)}`, `Top ${f(d.thickness)}`, `Panels ${f(d.panel)}`],
      solids(d) {
        const inset = Math.min(60, Math.floor(d.width / 10));
        const lh = d.height - d.thickness;
        const modesty = Math.min(300, Math.floor(lh / 3));
        const p = d.panel;
        return [
          { name: 'Top', x: 0, y: 0, z: lh, w: d.width, d: d.depth, h: d.thickness },
          { name: 'Side panel', x: inset, y: 30, z: 0, w: p, d: d.depth - 60, h: lh },
          { name: 'Side panel', x: d.width - inset - p, y: 30, z: 0, w: p, d: d.depth - 60, h: lh },
          { name: 'Back panel', x: inset + p, y: d.depth - 30 - p, z: lh - modesty, w: d.width - 2 * inset - 2 * p, d: p, h: modesty },
        ];
      },
    },
  };

  const IDS = Object.keys(TEMPLATES);

  // Sizes kept to what the template allows, so a slider or a saved plan can
  // never make an impossible board. Unknown templates become a bookshelf.
  function clean(input) {
    const id = input && TEMPLATES[input.template] ? input.template : 'bookshelf';
    const t = TEMPLATES[id];
    const out = { template: id };
    for (const [key, lim] of Object.entries(t.limits)) {
      let v = Math.round(Number(input && input[key]));
      if (!Number.isFinite(v)) v = t.defaults[key];
      out[key] = Math.min(lim.max, Math.max(lim.min, v));
    }
    t.fit(out);
    return out;
  }

  const defaults = (id) => clean({ template: id, ...TEMPLATES[id].defaults });
  const info = (d) => TEMPLATES[clean(d).template];
  const solids = (d) => { d = clean(d); return TEMPLATES[d.template].solids(d); };

  // A flat view: each board as a rectangle, and whether another board in front
  // of it hides it (then it is drawn dashed). from = 'front' | 'side' | 'top'.
  //   front: x across, height up.   side (from the right): depth across, front on the left.
  //   top: x across, the back of the piece at the top of the page.
  function view(d, from) {
    d = clean(d);
    const all = solids(d);
    const W = Math.max(...all.map((b) => b.x + b.w));
    const D = Math.max(...all.map((b) => b.y + b.d));
    const H = Math.max(...all.map((b) => b.z + b.h));
    const flat = {
      front: { width: W, height: H, rect: (b) => ({ x: b.x, y: H - b.z - b.h, w: b.w, h: b.h }), near: (b) => -b.y },
      side: { width: D, height: H, rect: (b) => ({ x: b.y, y: H - b.z - b.h, w: b.d, h: b.h }), near: (b) => b.x + b.w },
      top: { width: W, height: D, rect: (b) => ({ x: b.x, y: D - b.y - b.d, w: b.w, h: b.d }), near: (b) => b.z + b.h },
    }[from];
    const rects = all.map((b) => ({ ...flat.rect(b), near: flat.near(b) }));
    const covers = (a, r) => a.x <= r.x && a.y <= r.y && a.x + a.w >= r.x + r.w && a.y + a.h >= r.y + r.h;
    const shapes = rects.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h, hidden: rects.some((o) => o !== r && o.near > r.near && covers(o, r)) }));
    return { width: flat.width, height: flat.height, shapes };
  }

  // The cut list: boards of the same name and size are one row. Length is the
  // longest side, thickness the shortest.
  function parts(d) {
    const rows = new Map();
    for (const b of solids(d)) {
      const [length, width, thickness] = [b.w, b.d, b.h].sort((a, c) => c - a);
      const key = `${b.name}|${length}|${width}|${thickness}`;
      if (rows.has(key)) rows.get(key).qty++;
      else rows.set(key, { name: b.name, qty: 1, length, width, thickness });
    }
    return [...rows.values()];
  }

  // Lays the boards out on sheets of stock, a sheet per thickness at a time,
  // largest first. Boards go along the sheet in rows (each row as tall as its
  // first board), with a saw cut's width between them. A board that will not
  // fit either way round is listed in tooBig rather than dropped.
  //   -> { sheets: [{ thickness, pieces: [{ part, x, y, w, h }] }], timber: [{ width,
  //        thickness, stock, bars: [{ pieces: [{ part, x, len }] }] }], tooBig, area, used }
  // Strips 100 mm wide or less are cut from 2400 mm lengths instead, end to end.
  const SHEET = [2440, 1220];
  const KERF = 3;
  const STRIP = 100; // boards this narrow or less are cut from timber lengths
  const TIMBER = 2400;

  function layout(d, opts) {
    const [SW, SH] = (opts && opts.sheet) || SHEET;
    const kerf = opts && opts.kerf !== undefined ? opts.kerf : KERF;
    const rows = parts(d);
    const pieces = [];
    rows.forEach((r, part) => { for (let i = 0; i < r.qty; i++) pieces.push({ part, l: r.length, w: r.width, t: r.thickness }); });
    // Narrow boards (strips) come from lengths of timber; the rest from sheets.
    const strips = pieces.filter((p) => p.w <= STRIP);
    const flats = pieces.filter((p) => p.w > STRIP);
    flats.sort((a, b) => b.t - a.t || b.l - a.l || b.w - a.w);
    const have = ownedStock(opts && opts.stock);
    // Wood already in the workshop goes in first, biggest pieces first.
    const sheets = have.sheets.map((s) => ({ thickness: s.thick, W: s.w, H: s.l, owned: true, rows: [], pieces: [] }));
    const tooBig = [];
    const timber = [];
    const stock = (opts && opts.timber) || TIMBER;
    strips.sort((a, b) => b.l - a.l);
    for (const p of strips) {
      let group = timber.find((g) => g.width === p.w && g.thickness === p.t);
      if (!group) {
        group = { width: p.w, thickness: p.t, stock, bars: have.timber.filter((o) => o.w === p.w && o.thick === p.t).map((o) => ({ len: o.l, owned: true, pieces: [], left: o.l })) };
        timber.push(group);
      }
      // First bar with room left (a saw cut goes between boards).
      const bar = group.bars.find((b) => b.left >= p.l + kerf);
      if (bar) { bar.pieces.push({ part: p.part, x: bar.len - bar.left, len: p.l }); bar.left -= p.l + kerf; continue; }
      if (p.l > stock) { tooBig.push({ part: p.part, w: p.l, h: p.w }); continue; }
      group.bars.push({ len: stock, owned: false, pieces: [{ part: p.part, x: 0, len: p.l }], left: stock - p.l - kerf });
    }
    const waysFor = (p, W, H) => [[p.l, p.w], [p.w, p.l]].filter(([w, h]) => w <= W && h <= H);
    for (const p of flats) {
      let done = false;
      for (const sheet of sheets) {
        if (sheet.thickness !== p.t) continue;
        // Long way along the sheet first, then turned a quarter if that does not fit.
        for (const [w, h] of waysFor(p, sheet.W, sheet.H)) {
          // Into a row with room beside it and height to spare ...
          const row = sheet.rows.find((r) => r.h >= h && sheet.W - r.x >= w);
          if (row) {
            sheet.pieces.push({ part: p.part, x: row.x, y: row.y, w, h });
            row.x += w + kerf;
            done = true;
            break;
          }
          // ... or a new row under the last one.
          const y = sheet.rows.length ? sheet.rows[sheet.rows.length - 1].y + sheet.rows[sheet.rows.length - 1].h + kerf : 0;
          if (y + h <= sheet.H) {
            sheet.rows.push({ y, h, x: w + kerf });
            sheet.pieces.push({ part: p.part, x: 0, y, w, h });
            done = true;
            break;
          }
        }
        if (done) break;
      }
      if (done) continue;
      const ways = waysFor(p, SW, SH);
      if (!ways.length) { tooBig.push({ part: p.part, w: p.l, h: p.w }); continue; }
      const [w, h] = ways[0];
      sheets.push({ thickness: p.t, W: SW, H: SH, owned: false, rows: [{ y: 0, h, x: w + kerf }], pieces: [{ part: p.part, x: 0, y: 0, w, h }] });
    }
    // Owned wood nothing was cut from is left on the shelf.
    const cut = sheets.filter((sh) => sh.pieces.length);
    const area = cut.reduce((a, sh) => a + sh.W * sh.H, 0);
    const used = cut.reduce((a, sh) => a + sh.pieces.reduce((b, q) => b + q.w * q.h, 0), 0);
    return {
      width: SW, height: SH,
      sheets: cut.map((sh) => ({ thickness: sh.thickness, width: sh.W, height: sh.H, owned: sh.owned, pieces: sh.pieces })),
      tooBig, area, used,
      timber: timber.map((g) => ({ width: g.width, thickness: g.thickness, stock: g.stock, bars: g.bars.filter((b) => b.pieces.length).map((b) => ({ len: b.len, owned: b.owned, pieces: b.pieces })) })).filter((g) => g.bars.length),
    };
  }

  // Workshop stock cleaned for the layout: sheets (thickness, width, length)
  // and timber (width, thickness, length), each repeated by its quantity,
  // biggest first so the best pieces are used before the offcuts.
  //   item: { kind: 'sheet', thick, w, l, qty } | { kind: 'timber', w, thick, l, qty }
  function ownedStock(list) {
    const sheets = [];
    const timber = [];
    for (const it of Array.isArray(list) ? list : []) {
      if (!it || (it.kind !== 'sheet' && it.kind !== 'timber')) continue;
      const n = Math.min(50, Math.max(0, Math.round(Number(it.qty))));
      const [a, b, c] = [Number(it.w), Number(it.l), Number(it.thick)];
      if (![a, b, c].every((v) => Number.isFinite(v) && v > 0 && v <= 10000) || !n) continue;
      for (let i = 0; i < n; i++) {
        if (it.kind === 'sheet') sheets.push({ thick: Math.round(c), w: Math.max(a, b), l: Math.min(a, b) });
        else timber.push({ w: Math.round(Math.max(a, c)), thick: Math.round(Math.min(a, c)), l: b });
      }
    }
    sheets.sort((x, y) => y.w * y.l - x.w * x.l);
    timber.sort((x, y) => y.l - x.l);
    return { sheets, timber };
  }

  // What to buy: sheets and timber lengths from the layout, plus fixings. The
  // price on each line is a rough starter guess (pounds), only there until the
  // person sets their own; `search` is what to type into a shop's search box.
  //   -> [{ key, label, qty, search, estimate }]
  function materials(d, opts) {
    const l = layout(d, opts);
    const out = [];
    const sheetsBy = {};
    for (const sh of l.sheets) {
      const e = sheetsBy[sh.thickness] || (sheetsBy[sh.thickness] = { buy: 0, have: 0 });
      if (sh.owned) e.have++; else e.buy++;
    }
    for (const [t, e] of Object.entries(sheetsBy).sort((a, b) => a[0] - b[0])) {
      out.push({ key: `sheet-${t}`, label: `${t} mm sheet, ${l.width} × ${l.height}`, qty: e.buy, have: e.have, search: `${t}mm sheet board ${l.width}x${l.height}`, estimate: Math.round((l.width * l.height) / 1e6 * (4 + 0.7 * t) * 100) / 100 });
    }
    for (const g of l.timber) {
      const have = g.bars.filter((b) => b.owned).length;
      out.push({ key: `timber-${g.width}x${g.thickness}`, label: `${g.width} × ${g.thickness} timber, ${g.stock} mm length`, qty: g.bars.length - have, have, search: `${g.width}x${g.thickness} timber ${g.stock / 1000}m`, estimate: Math.round(0.00264 * g.width * g.thickness * 100) / 100 });
    }
    out.push({ key: 'screws', label: 'Wood screws, box', qty: 1, have: 0, search: 'wood screws box', estimate: 5 });
    out.push({ key: 'glue', label: 'Wood glue, 250 ml', qty: 1, have: 0, search: 'wood glue 250ml', estimate: 5 });
    return out;
  }

  // The faces of those boards as seen from a turned and tilted viewpoint,
  // furthest first, so drawing them in order hides what is behind. yaw turns
  // the model about its upright axis, pitch tilts the view down (both radians).
  // Each face is { pts: [[x, y] x4], light } in millimetres, y growing downward.
  const FACES = [
    { n: [0, -1, 0], v: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
    { n: [0, 1, 0], v: [[0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]] },
    { n: [-1, 0, 0], v: [[0, 0, 0], [0, 1, 0], [0, 1, 1], [0, 0, 1]] },
    { n: [1, 0, 0], v: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },
    { n: [0, 0, 1], v: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
    { n: [0, 0, -1], v: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]] },
  ];

  function size(d) {
    const all = solids(d);
    return { width: Math.max(...all.map((b) => b.x + b.w)), depth: Math.max(...all.map((b) => b.y + b.d)), height: Math.max(...all.map((b) => b.z + b.h)) };
  }

  function project(d, yaw, pitch) {
    const all = solids(d);
    const s = size(d);
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    const mid = [s.width / 2, s.depth / 2, s.height / 2];
    // Turn about the upright axis, then tilt. depth grows away from the viewer.
    const turn = (x, y, z) => {
      const x1 = x * cy - y * sy;
      const y1 = x * sy + y * cy;
      return { sx: x1, sy: -(y1 * sp + z * cp), depth: y1 * cp - z * sp };
    };
    const faces = [];
    for (const b of all) {
      for (const f of FACES) {
        const n = turn(...f.n);
        if (n.depth >= 0) continue; // facing away
        const pts = f.v.map(([u, v, w]) => turn(b.x + u * b.w - mid[0], b.y + v * b.d - mid[1], b.z + w * b.h - mid[2]));
        faces.push({ pts, depth: pts.reduce((a, p) => a + p.depth, 0) / 4, light: Math.round((0.1 + 0.14 * Math.max(0, -n.sy) + 0.08 * -n.depth) * 100) / 100 });
      }
    }
    faces.sort((a, b) => b.depth - a.depth);
    return faces.map((f) => ({ pts: f.pts.map((p) => [p.sx, p.sy]), light: f.light }));
  }

  // Reads a sentence like "bookshelf 1800 tall, 800 wide, 5 shelves" or
  // "table 1200 x 700 x 740, 25mm top". Words only pick the project and the
  // size each number belongs to; anything it cannot place is reported so
  // nothing is silently ignored. It never guesses a size that was not typed.
  //   -> { template: id | null, set: { key: value }, unused: [text] }
  const KINDS = {
    bookshelf: ['bookshelf', 'bookcase', 'shelf', 'shelves', 'shelving'],
    table: ['table'],
    desk: ['desk', 'workstation'],
    cabinet: ['cabinet', 'cupboard', 'sideboard', 'unit'],
    box: ['box', 'crate', 'chest'],
    bench: ['bench', 'seat'],
  };
  const MM = { mm: 1, cm: 10, m: 1000, in: 25.4, inch: 25.4, inches: 25.4, '"': 25.4 };
  const NUM = String.raw`(\d+(?:[.,]\d+)?)\s*(mm|cm|m|inches|inch|in|")?`;

  function parse(text, current) {
    const src = String(text || '').toLowerCase().slice(0, 300);
    const words = src.match(/[a-z]+/g) || [];
    let template = null;
    for (const w of words) {
      template = IDS.find((id) => KINDS[id].includes(w)) || null;
      if (template) break;
    }
    const id = template || (current && TEMPLATES[current] ? current : 'bookshelf');
    const t = TEMPLATES[id];
    const set = {};
    const unused = [];
    const mm = (n, u) => Math.round(Number(n.replace(/^(\d{1,3}),(\d{3})$/, '$1$2').replace(',', '.')) * (MM[u] || 1)); // 1,200 is twelve hundred, 1,5 is one and a half
    const keyFor = (word) => (word ? Object.keys(t.words).find((k) => t.words[k].includes(word)) : null);
    let rest = src;

    // "A x B x C": the sizes in the order this project is usually quoted.
    const triple = new RegExp(`${NUM}\\s*[x×*]\\s*${NUM}\\s*[x×*]\\s*${NUM}`);
    const m3 = rest.match(triple);
    if (m3) {
      const raw = [[m3[1], m3[2]], [m3[3], m3[4]], [m3[5], m3[6]]];
      // One unit after the last number covers them all ("80 x 30 x 180 cm").
      const unit = raw[2][1] || raw[1][1] || raw[0][1];
      t.order.forEach((key, i) => { set[key] = mm(raw[i][0], raw[i][1] || unit); });
      rest = rest.replace(triple, ' ');
    }

    const re = new RegExp(NUM, 'g');
    for (const m of [...rest.matchAll(re)]) {
      const after = (rest.slice(m.index + m[0].length).match(/^[\s,]*([a-z]+)/) || [])[1];
      const before = (rest.slice(0, m.index).match(/([a-z]+)[\s:=]*$/) || [])[1];
      const key = keyFor(after) || keyFor(before);
      if (!key) { unused.push(m[0].trim()); continue; }
      // "5 shelves" is a count, not a length.
      set[key] = key === 'shelves' || key === 'doors' ? Math.round(Number(m[1])) : mm(m[1], m[2]);
    }
    return { template, set, unused };
  }

  const exported = { TEMPLATES, IDS, clean, defaults, info, solids, size, view, parts, layout, materials, project, parse, ownedStock };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  else window.birdhouseModel = exported;
})();
