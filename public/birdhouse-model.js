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
      fit(d) { d.thickness = Math.min(d.thickness, Math.floor((d.width - 20) / 2), Math.floor(d.height / (d.shelves * 2))); },
      chips: (d) => [`H ${d.height}`, `W ${d.width}`, `D ${d.depth}`, `${d.shelves} shelves`, `Pine ${d.thickness}`],
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
      fit(d) { d.leg = Math.min(d.leg, Math.floor((Math.min(d.width, d.depth) - 20) / 4)); d.thickness = Math.min(d.thickness, Math.floor(d.height / 4)); },
      chips: (d) => [`L ${d.width}`, `W ${d.depth}`, `H ${d.height}`, `Top ${d.thickness}`, `Legs ${d.leg}`],
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
      fit(d) { d.thickness = Math.min(d.thickness, Math.floor((Math.min(d.width, d.depth) - 20) / 2), Math.floor(d.height / 2)); },
      chips: (d) => [`W ${d.width}`, `D ${d.depth}`, `H ${d.height}`, `Board ${d.thickness}`],
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
      fit(d) { d.thickness = Math.min(d.thickness, Math.floor(d.height / 3)); },
      chips: (d) => [`L ${d.width}`, `W ${d.depth}`, `H ${d.height}`, `Seat ${d.thickness}`],
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

  const exported = { TEMPLATES, IDS, clean, defaults, info, solids, size, view, parts, project };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  else window.birdhouseModel = exported;
})();
