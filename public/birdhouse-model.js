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

  // ---- Framed construction ----
  // Real furniture is a frame of timber posts and rails with thin plywood fixed
  // to it as skins; the frame carries the load and keeps it square. "Panel"
  // style (sheets butted together) is kept for small boxes and quick sketches.
  const SKIN = 12; // plywood skins, mm
  const JOIN = {
    post: 'Rails butt-screwed between posts: 2 × 60 mm screws per end, pilot holes, glue',
    rail: 'Screwed into the posts: 2 × 60 mm screws per end, pilot holes, glue',
    shelf: 'Rests on the side rails; glue and screw down through the top',
    top: 'Screwed down through the rails and posts, glue',
    skin: 'Glued and screwed or nailed to the frame about every 150 mm',
    door: 'Hung on two hinges, screwed to the frame',
    panel: 'Butt joint: glue and screws, or dowels or pocket holes',
  };
  const B = (name, x, y, z, w, d, h, join) => ({ name, x, y, z, w, d, h, join });

  // A box frame: four posts, rails across the front and back and along the
  // sides, a pair of side rails at each shelf level, side and back skins, a top
  // board overhanging them. o: { inner (shelves between bottom and top),
  // topT (top board thickness, 0 for none), boardT (shelf thickness), front
  // (space kept at the front for doors or a front skin) }.
  function carcass(d, o) {
    const f = d.frame;
    const s = SKIN;
    const W = d.width;
    const D = d.depth;
    const front = o.front || 0;
    const top = o.topT || 0;
    const Hf = d.height - top;
    const x0 = s;
    const x1 = W - s;
    const y0 = front;
    const y1 = D - s;
    const across = x1 - x0 - 2 * f;
    const deep = y1 - y0 - 2 * f;
    const out = [];
    for (const x of [x0, x1 - f]) for (const y of [y0, y1 - f]) out.push(B('Post', x, y, 0, f, f, Hf, JOIN.post));
    for (const z of [0, Hf - f]) {
      out.push(B('Front rail', x0 + f, y0, z, across, f, f, JOIN.rail));
      out.push(B('Back rail', x0 + f, y1 - f, z, across, f, f, JOIN.rail));
    }
    // Levels: the bottom, then the shelves between it and the top rails.
    const levels = [0];
    for (let i = 1; i <= o.inner; i++) levels.push(Math.round(((Hf - f) * i) / (o.inner + 1)));
    for (const z of [...levels.slice(1), Hf - f]) for (const x of [x0, x1 - f]) out.push(B('Side rail', x, y0 + f, z, f, deep, f, JOIN.rail));
    for (const z of levels) {
      if (z === 0) for (const x of [x0, x1 - f]) out.push(B('Side rail', x, y0 + f, 0, f, deep, f, JOIN.rail));
      out.push(B('Shelf', x0, y0 + f, z + f, x1 - x0, deep, o.boardT, JOIN.shelf));
    }
    out.push(B('Side skin', 0, 0, 0, s, D, Hf, JOIN.skin), B('Side skin', W - s, 0, 0, s, D, Hf, JOIN.skin));
    out.push(B('Back skin', x0, y1, 0, x1 - x0, s, Hf, JOIN.skin));
    if (top) out.push(B('Top', 0, 0, Hf, W, D, top, JOIN.top));
    return out;
  }


  const TEMPLATES = {
    bookshelf: {
      name: 'Bookshelf',
      // "shelves" counts every horizontal board, top and bottom included.
      limits: { height: range(300, 2400, 10, 'Height'), width: range(200, 2400, 10, 'Width'), depth: range(100, 800, 10, 'Depth'), shelves: range(2, 12, 1, 'Shelves'), thickness: range(6, 40, 1, 'Board thickness'), frame: range(34, 94, 1, 'Frame timber') },
      defaults: { height: 1800, width: 800, depth: 300, shelves: 5, thickness: 18, frame: 44 },
      words: { height: ['tall', 'high', 'height'], width: ['wide', 'width', 'across'], depth: ['deep', 'depth'], shelves: ['shelves', 'shelf', 'boards'], thickness: ['thick', 'thickness'], frame: ['frame', 'timber', 'post'] },
      order: ['height', 'width', 'depth'],
      fit(d) {
        d.thickness = Math.min(d.thickness, Math.floor((d.width - 20) / 2), Math.floor(d.height / (d.shelves * 2)));
        d.frame = Math.min(d.frame, Math.floor((Math.min(d.width - 2 * SKIN, d.depth) - 20) / 3));
        // Shelves need room between the rails.
        d.shelves = Math.max(2, Math.min(d.shelves, Math.floor(d.height / (d.frame + d.thickness + 40))));
      },
      chips: (d, f = String) => [`H ${f(d.height)}`, `W ${f(d.width)}`, `D ${f(d.depth)}`, `${d.shelves} shelves`, d.style === 'framed' ? `Framed ${f(d.frame)}` : `Pine ${f(d.thickness)}`],
      framed: (d) => carcass(d, { inner: d.shelves - 2, topT: d.thickness, boardT: d.thickness }),
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
      framed: (d) => TEMPLATES.table.solids(d, true),
      fit(d) { d.leg = Math.min(d.leg, Math.floor((Math.min(d.width, d.depth) - 20) / 4)); d.thickness = Math.min(d.thickness, Math.floor(d.height / 4)); },
      chips: (d, f = String) => [`L ${f(d.width)}`, `W ${f(d.depth)}`, `H ${f(d.height)}`, `Top ${f(d.thickness)}`, `Legs ${f(d.leg)}`],
      solids(d, braced) {
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
        // Framed: low stretchers tie the legs together so it cannot rack.
        if (braced) {
          const sz = Math.min(40, lg);
          const bz = Math.min(150, Math.floor(lh / 4));
          for (const y of [ov + lg / 2 - sz / 2, d.depth - ov - lg / 2 - sz / 2]) out.push(B('Low stretcher', ov + lg, Math.round(y), bz, run, sz, sz, JOIN.rail));
          for (const x of [ov + lg / 2 - sz / 2, d.width - ov - lg / 2 - sz / 2]) out.push(B('Low stretcher', Math.round(x), ov + lg, bz, sz, gap, sz, JOIN.rail));
        }
        return out;
      },
    },

    stool: {
      name: 'Stool',
      limits: { height: range(200, 800, 10, 'Height'), width: range(200, 500, 10, 'Seat width'), depth: range(200, 500, 10, 'Seat depth'), thickness: range(15, 40, 1, 'Seat thickness'), leg: range(30, 80, 1, 'Leg size') },
      defaults: { height: 450, width: 320, depth: 320, thickness: 25, leg: 44 },
      words: { height: ['tall', 'high', 'height'], width: ['wide', 'width'], depth: ['deep', 'depth'], thickness: ['thick', 'thickness', 'seat'], leg: ['leg', 'legs'] },
      order: ['width', 'depth', 'height'],
      fit(d) { d.leg = Math.min(d.leg, Math.floor((Math.min(d.width, d.depth) - 50) / 3)); d.thickness = Math.min(d.thickness, Math.floor(d.height / 4)); },
      chips: (d, f = String) => [`W ${f(d.width)}`, `D ${f(d.depth)}`, `H ${f(d.height)}`, `Seat ${f(d.thickness)}`, `Legs ${f(d.leg)}`],
      framed: (d) => TEMPLATES.stool.solids(d, true),
      // Four legs tied by aprons under the seat; framed adds low stretchers so it cannot wobble.
      solids(d, braced) {
        const ov = 15;
        const lg = d.leg;
        const at = 20;
        const lh = d.height - d.thickness;
        const apron = Math.min(60, Math.floor(lh / 5));
        const run = d.width - 2 * ov - 2 * lg;
        const gap = d.depth - 2 * ov - 2 * lg;
        const out = [{ name: 'Seat', x: 0, y: 0, z: lh, w: d.width, d: d.depth, h: d.thickness }];
        for (const x of [ov, d.width - ov - lg]) for (const y of [ov, d.depth - ov - lg]) out.push({ name: 'Leg', x, y, z: 0, w: lg, d: lg, h: lh });
        for (const y of [ov, d.depth - ov - at]) out.push({ name: 'Long apron', x: ov + lg, y, z: lh - apron, w: run, d: at, h: apron });
        for (const x of [ov, d.width - ov - at]) out.push({ name: 'Short apron', x, y: ov + lg, z: lh - apron, w: at, d: gap, h: apron });
        if (braced) {
          const sz = Math.min(30, lg);
          const bz = Math.min(150, Math.floor(lh / 4));
          for (const y of [ov + lg / 2 - sz / 2, d.depth - ov - lg / 2 - sz / 2]) out.push(B('Low stretcher', ov + lg, Math.round(y), bz, run, sz, sz, JOIN.rail));
          for (const x of [ov + lg / 2 - sz / 2, d.width - ov - lg / 2 - sz / 2]) out.push(B('Low stretcher', Math.round(x), ov + lg, bz, sz, gap, sz, JOIN.rail));
        }
        return out;
      },
    },

    box: {
      name: 'Box',
      limits: { width: range(100, 1200, 10, 'Width'), depth: range(100, 900, 10, 'Depth'), height: range(50, 800, 10, 'Height'), thickness: range(4, 30, 1, 'Board thickness'), frame: range(34, 94, 1, 'Frame timber') },
      defaults: { width: 400, depth: 300, height: 200, thickness: 12, frame: 34 },
      words: { width: ['wide', 'width', 'long', 'length'], depth: ['deep', 'depth'], height: ['tall', 'high', 'height'], thickness: ['thick', 'thickness'], frame: ['frame', 'timber', 'post'] },
      order: ['width', 'depth', 'height'],
      fit(d) {
        d.thickness = Math.min(d.thickness, Math.floor((Math.min(d.width, d.depth) - 20) / 2), Math.floor(d.height / 2));
        d.frame = Math.max(10, Math.min(d.frame, Math.floor((Math.min(d.width, d.depth) - 2 * SKIN - 20) / 3), Math.floor(d.height / 4)));
      },
      chips: (d, f = String) => [`W ${f(d.width)}`, `D ${f(d.depth)}`, `H ${f(d.height)}`, d.style === 'framed' ? `Framed ${f(d.frame)}` : `Board ${f(d.thickness)}`],
      // A crate: a timber frame with plywood on every side and a plywood floor.
      framed(d) {
        const out = carcass(d, { inner: 0, topT: 0, boardT: SKIN, front: SKIN });
        out.push(B('Front skin', SKIN, 0, 0, d.width - 2 * SKIN, SKIN, d.height, JOIN.skin));
        return out;
      },
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
      limits: { width: range(300, 2400, 10, 'Length'), depth: range(150, 600, 10, 'Width'), height: range(200, 700, 10, 'Height'), thickness: range(15, 60, 1, 'Seat thickness'), frame: range(34, 94, 1, 'Frame timber') },
      defaults: { width: 1000, depth: 350, height: 450, thickness: 30, frame: 44 },
      words: { width: ['long', 'length'], depth: ['wide', 'width', 'deep', 'depth'], height: ['tall', 'high', 'height'], thickness: ['thick', 'thickness', 'seat'], frame: ['frame', 'timber', 'legs', 'post'] },
      order: ['width', 'depth', 'height'],
      fit(d) { d.thickness = Math.min(d.thickness, Math.floor(d.height / 3)); d.frame = Math.min(d.frame, Math.floor(d.depth / 4)); },
      chips: (d, f = String) => [`L ${f(d.width)}`, `W ${f(d.depth)}`, `H ${f(d.height)}`, `Seat ${f(d.thickness)}`, ...(d.style === 'framed' ? [`Framed ${f(d.frame)}`] : [])],
      framed(d) {
        const f = d.frame;
        const inset = Math.min(60, Math.floor(d.width / 8));
        const lh = d.height - d.thickness;
        const run = d.width - 2 * inset - 2 * f;
        const deep = d.depth - 2 * f - 2 * 30;
        const out = [B('Seat', 0, 0, lh, d.width, d.depth, d.thickness, JOIN.top)];
        for (const x of [inset, d.width - inset - f]) for (const y of [30, d.depth - 30 - f]) out.push(B('Post', x, y, 0, f, f, lh, JOIN.post));
        for (const y of [30, d.depth - 30 - f]) out.push(B('Front rail', inset + f, y, lh - f, run, f, f, JOIN.rail));
        for (const x of [inset, d.width - inset - f]) out.push(B('Side rail', x, 30 + f, lh - f, f, deep, f, JOIN.rail));
        // A low rail down the middle ties the two ends together.
        out.push(B('Stretcher', inset + f, Math.round((d.depth - f) / 2), Math.round(lh / 4), run, f, f, JOIN.rail));
        return out;
      },
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
      limits: { height: range(300, 2000, 10, 'Height'), width: range(300, 1200, 10, 'Width'), depth: range(200, 700, 10, 'Depth'), shelves: range(0, 6, 1, 'Shelves inside'), doors: range(0, 2, 1, 'Doors'), thickness: range(12, 25, 1, 'Board thickness'), frame: range(34, 94, 1, 'Frame timber') },
      defaults: { height: 900, width: 600, depth: 350, shelves: 1, doors: 2, thickness: 18, frame: 44 },
      words: { height: ['tall', 'high', 'height'], width: ['wide', 'width'], depth: ['deep', 'depth'], shelves: ['shelves', 'shelf'], doors: ['doors', 'door'], thickness: ['thick', 'thickness'], frame: ['frame', 'timber', 'post'] },
      order: ['height', 'width', 'depth'],
      fit(d) {
        d.thickness = Math.min(d.thickness, Math.floor((d.width - 20) / 4), Math.floor(d.height / 6));
        d.frame = Math.min(d.frame, Math.floor((Math.min(d.width - 2 * SKIN, d.depth) - 20) / 3));
        d.shelves = Math.min(d.shelves, Math.floor(d.height / (d.frame + d.thickness + 40)));
      },
      chips: (d, f = String) => [`H ${f(d.height)}`, `W ${f(d.width)}`, `D ${f(d.depth)}`, `${d.shelves === 1 ? '1 shelf' : `${d.shelves} shelves`}`, `${d.doors} door${d.doors === 1 ? '' : 's'}`, d.style === 'framed' ? `Framed ${f(d.frame)}` : `Pine ${f(d.thickness)}`],
      framed(d) {
        const t = d.thickness;
        const front = d.doors ? t : 0;
        const out = carcass(d, { inner: d.shelves, topT: t, boardT: t, front });
        if (d.doors) {
          const dw = d.doors === 2 ? Math.floor((d.width - 6) / 2) : d.width - 4;
          for (let i = 0; i < d.doors; i++) out.push(B('Door', 2 + i * (dw + 2), 0, 2, dw, t, d.height - 4, JOIN.door));
        }
        return out;
      },
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
      limits: { width: range(800, 2000, 10, 'Length'), depth: range(400, 900, 10, 'Width'), height: range(600, 900, 10, 'Height'), thickness: range(18, 40, 1, 'Top thickness'), panel: range(15, 30, 1, 'Side panel thickness'), frame: range(34, 94, 1, 'Frame timber') },
      defaults: { width: 1400, depth: 700, height: 740, thickness: 25, panel: 18, frame: 44 },
      words: { width: ['long', 'length'], depth: ['wide', 'width', 'deep', 'depth'], height: ['tall', 'high', 'height'], thickness: ['thick', 'thickness', 'top'], panel: ['panel', 'panels'], frame: ['frame', 'timber', 'post', 'legs'] },
      order: ['width', 'depth', 'height'],
      fit(d) { d.panel = Math.min(d.panel, Math.floor(d.width / 10)); d.frame = Math.min(d.frame, Math.floor(d.depth / 8)); },
      chips: (d, f = String) => [`L ${f(d.width)}`, `W ${f(d.depth)}`, `H ${f(d.height)}`, `Top ${f(d.thickness)}`, d.style === 'framed' ? `Framed ${f(d.frame)}` : `Panels ${f(d.panel)}`],
      framed(d) {
        const f = d.frame;
        const inset = Math.min(60, Math.floor(d.width / 10));
        const m = 30;
        const lh = d.height - d.thickness;
        const run = d.width - 2 * inset - 2 * f;
        const deep = d.depth - 2 * m - 2 * f;
        const modesty = Math.min(300, Math.floor(lh / 3));
        const out = [B('Top', 0, 0, lh, d.width, d.depth, d.thickness, JOIN.top)];
        for (const x of [inset, d.width - inset - f]) for (const y of [m, d.depth - m - f]) out.push(B('Post', x, y, 0, f, f, lh, JOIN.post));
        // Each end is a ladder of two rails; the back rail stops it swaying.
        for (const z of [lh - f, Math.round(lh / 4)]) for (const x of [inset, d.width - inset - f]) out.push(B('Side rail', x, m + f, z, f, deep, f, JOIN.rail));
        out.push(B('Back rail', inset + f, d.depth - m - f, lh - f, run, f, f, JOIN.rail));
        out.push(B('Back rail', inset + f, d.depth - m - f, Math.round(lh / 4), run, f, f, JOIN.rail));
        out.push(B('Side skin', inset - SKIN, m, 0, SKIN, d.depth - 2 * m, lh, JOIN.skin), B('Side skin', d.width - inset, m, 0, SKIN, d.depth - 2 * m, lh, JOIN.skin));
        out.push(B('Back skin', inset + f, d.depth - m - SKIN, lh - f - modesty, run, SKIN, modesty, JOIN.skin));
        return out;
      },
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


  // A free-form design: the boards themselves are the plan (from an AI helper
  // or pasted in), instead of sizes fed to a template. Everything else
  // (drawings, cut list, layout, cost) works off the boards exactly the same.
  TEMPLATES.custom = {
    name: 'Custom',
    custom: true,
    limits: {},
    defaults: {},
    words: {},
    order: [],
    fit() {},
    chips: (d, f = String) => { const z = size(d); return [`W ${f(z.width)}`, `D ${f(z.depth)}`, `H ${f(z.height)}`, `${d.boards.length} boards`]; },
    solids: (d) => d.boards.map((b) => ({ ...b })),
  };

  // Custom designs are made by asking, not picked from a tile.
  const IDS = Object.keys(TEMPLATES).filter((id) => !TEMPLATES[id].custom);

  // Sizes kept to what the template allows, so a slider or a saved plan can
  // never make an impossible board. Unknown templates become a bookshelf.
  function clean(input) {
    const id = input && TEMPLATES[input.template] ? input.template : 'bookshelf';
    const t = TEMPLATES[id];
    if (t.custom) {
      const out = { template: id, style: 'panel', boards: sanitizeBoards(input && input.boards).boards, notes: plain(input && input.notes, 1500) };
      const st = cleanStock(input && input.stock);
      if (st) out.stock = st;
      return out;
    }
    const out = { template: id };
    for (const [key, lim] of Object.entries(t.limits)) {
      let v = Math.round(Number(input && input[key]));
      if (!Number.isFinite(v)) v = t.defaults[key];
      out[key] = Math.min(lim.max, Math.max(lim.min, v));
    }
    // Framed (timber frame with plywood skins) is how it is really built; panel
    // (boards butted together) stays for quick sketches.
    out.style = t.framed && !(input && input.style === 'panel') ? 'framed' : 'panel';
    t.fit(out);
    return out;
  }


  // ---- Free-form boards ----
  // The board or sheet a person says they have, so a design can be held to it:
  // { w, l, t, qty } in mm (width, length, thickness), or null.
  function cleanStock(s) {
    if (!s || typeof s !== 'object') return null;
    const [a, b, t, q] = [s.w, s.l, s.t, s.qty === undefined ? 1 : s.qty].map((v) => Math.round(Number(v)));
    if (![a, b, t, q].every(Number.isFinite) || a < 20 || b < 20 || t < 1 || a > 3000 || b > 3000 || t > 100 || q < 1) return null;
    return { w: Math.min(a, b), l: Math.max(a, b), t, qty: Math.min(q, 20) };
  }
  const MAX_BOARDS = 120;
  const plain = (v, n) => String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

  // Boards cleaned to whole millimetres inside sensible limits, and moved so
  // the piece starts at the origin (the drawings expect that).
  //   -> { boards, dropped }  (dropped: how many were unusable or over the limit)
  function sanitizeBoards(input) {
    const list = Array.isArray(input) ? input : [];
    const out = [];
    let dropped = 0;
    for (const b of list) {
      if (!b || typeof b !== 'object') { dropped++; continue; }
      const n = (v) => Math.round(Number(v));
      const [x, y, z, w, d, h] = [b.x, b.y, b.z, b.w, b.d, b.h].map(n);
      if (![x, y, z].every((v) => Number.isFinite(v) && Math.abs(v) <= 6000) || ![w, d, h].every((v) => Number.isFinite(v) && v >= 1 && v <= 6000)) { dropped++; continue; }
      if (out.length >= MAX_BOARDS) { dropped++; continue; }
      out.push({ name: plain(b.name, 40) || 'Board', x, y, z, w, d, h, join: plain(b.join, 120) });
    }
    if (out.length) {
      const [mx, my, mz] = [Math.min(...out.map((b) => b.x)), Math.min(...out.map((b) => b.y)), Math.min(...out.map((b) => b.z))];
      for (const b of out) { b.x -= mx; b.y -= my; b.z -= mz; }
    }
    return { boards: out, dropped };
  }

  // Things wrong with a set of boards: boards that pass through each other, and
  // boards not attached to the rest. Plain sentences, empty if all is well.
  function boardProblems(boards) {
    const out = [];
    const over = (a0, al, b0, bl) => Math.min(a0 + al, b0 + bl) - Math.max(a0, b0);
    const pairs = [];
    for (let i = 0; i < boards.length; i++) {
      for (let j = i + 1; j < boards.length; j++) {
        const a = boards[i];
        const b = boards[j];
        const ox = over(a.x, a.w, b.x, b.w);
        const oy = over(a.y, a.d, b.y, b.d);
        const oz = over(a.z, a.h, b.z, b.h);
        if (ox > 3 && oy > 3 && oz > 3 && ox * oy * oz > 0.1 * Math.min(a.w * a.d * a.h, b.w * b.d * b.h)) pairs.push(`${a.name} and ${b.name}`);
      }
    }
    if (pairs.length) out.push(`${plural(pairs.length, 'pair')} of boards pass through each other (${[...new Set(pairs)].slice(0, 3).join(', ')}${pairs.length > 3 ? ', ...' : ''}).`);
    // Boards that touch (within 2 mm) are attached; find the groups.
    const root = boards.map((_, i) => i);
    const find = (i) => { while (root[i] !== i) { root[i] = root[root[i]]; i = root[i]; } return i; };
    for (let i = 0; i < boards.length; i++) {
      for (let j = i + 1; j < boards.length; j++) {
        const a = boards[i];
        const b = boards[j];
        if (over(a.x, a.w, b.x, b.w) >= -2 && over(a.y, a.d, b.y, b.d) >= -2 && over(a.z, a.h, b.z, b.h) >= -2) root[find(i)] = find(j);
      }
    }
    if (boards.length) {
      const main = find(0);
      const sizes = new Map();
      boards.forEach((_, i) => sizes.set(find(i), (sizes.get(find(i)) || 0) + 1));
      const biggest = [...sizes.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const loose = boards.filter((_, i) => find(i) !== biggest);
      if (loose.length && main !== undefined) out.push(`${plural(loose.length, 'board')} not attached to the rest (${[...new Set(loose.map((b) => b.name))].slice(0, 4).join(', ')}).`);
    }
    return out;
  }
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  // What to tell a designer (a person's own Claude chat, or the API) so its
  // reply can be read back: the coordinate system, the rules, the two shapes.
  function designInstructions() {
    const kinds = IDS.map((id) => {
      const t = TEMPLATES[id];
      const sizes = Object.entries(t.limits).map(([k, l]) => `${k} (${l.label}, ${l.min} to ${l.max}${k === 'shelves' || k === 'doors' ? '' : ' mm'})`).join(', ');
      return `- ${id}: ${t.name}. ${sizes}`;
    }).join('\n');
    return `You design woodworking projects for an app called Birdhouse. Reply with one JSON object in a code block.

Either pick a built-in type and give its sizes:
{"template": "bookshelf", "name": "Hall shelves", "sizes": {"height": 1800, "width": 800}}
Built-in types (whole millimetres; shelves and doors are plain counts; use only the keys listed):
${kinds}

Or, when none of them fits what was asked (or a custom design would be better), design it yourself, board by board:
{"template": "custom", "name": "Record shelf", "notes": "Why it is built this way and what to watch.", "boards": [{"name": "Post", "x": 0, "y": 0, "z": 0, "w": 44, "d": 44, "h": 600, "join": "Rails screwed between posts, 2 x 60 mm screws per end, glue"}]}

Rules for custom designs:
- All sizes are whole millimetres. x runs left to right, y front to back, z up. Each board is a box with its lowest, left, front corner at (x, y, z) and size w along x, d along y, h along z.
- Build it the way a woodworker would: a frame of timber posts and rails (for example 44 x 44 or 44 x 94 mm) with thin plywood (6 to 18 mm) fixed to it as skins, shelves resting on rails, back panels or braces to stop it racking. Do not just butt big sheets together.
- The piece stands on the floor (its lowest boards start at z = 0). Every board must touch the boards it is fixed to, and nothing may float or pass through another board.
- Use standard stock: sheets 2440 x 1220 mm, timber up to 2400 mm long, usual plywood and timber thicknesses.
- If I say what board or sheet I have (for example "a 700 x 600 x 18 mm pine board"), that is all the wood there is for the boards of that thickness. Add "stock": {"w": 600, "l": 700, "t": 18, "qty": 1} to the JSON (width, length, thickness in mm, and how many) and make every board of that thickness, cleats and uprights included, fit inside it: add up the area of the cut parts plus about 3 mm saw cut around each, check it is no more than the board's area, and check the parts really pack onto it. If the idea cannot be made from that board, make it smaller or simpler instead of using more wood. Pegs, dowels and other thicknesses are bought separately.
- Give identical boards the same name, a short name each (at most 40 characters), and a "join" saying how it is fixed.
- At most 100 boards. Make it stable: wide enough for its height, and say in the notes if it should be fixed to a wall.
- "notes" is 2 to 5 sentences: why it is built this way and anything to watch for.`;
  }

  // A design as the JSON a designer replies with, so it can be sent back for changes.
  function describeDesign(d, name) {
    const t = TEMPLATES[d.template];
    if (t.custom) return JSON.stringify({ template: 'custom', name, notes: d.notes || '', ...(d.stock ? { stock: d.stock } : {}), boards: d.boards.map((b) => ({ name: b.name, x: b.x, y: b.y, z: b.z, w: b.w, d: b.d, h: b.h, join: b.join })) });
    const sizes = {};
    for (const k of Object.keys(t.limits)) sizes[k] = d[k];
    return JSON.stringify({ template: d.template, name, sizes });
  }

  // The request that goes with a design for changing it.
  function reviseRequest(d, name, change) {
    return `Here is the current design:\n\`\`\`json\n${describeDesign(d, name)}\n\`\`\`\n\nChange it like this: ${String(change).trim()}\n\nReply with the complete updated design in the same format. Keep everything I did not ask to change, and keep it buildable (nothing floating or passing through other boards).`;
  }

  // Reads a designer's reply: the built-in kind or a custom design.
  //   -> { ok: true, d, name, notes, problems } | { ok: false, error }
  function readDesign(reply) {
    const text = String(reply || '');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return { ok: false, error: 'no design in that reply' };
    let data;
    try { data = JSON.parse(text.slice(start, end + 1)); } catch { return { ok: false, error: 'the design was not valid JSON' }; }
    if (!data || typeof data !== 'object' || !TEMPLATES[data.template]) return { ok: false, error: 'the design did not name a project type' };
    const t = TEMPLATES[data.template];
    const name = plain(data.name, 60) || t.name;
    if (t.custom) {
      const { boards, dropped } = sanitizeBoards(data.boards);
      if (boards.length < 2) return { ok: false, error: 'a custom design needs at least two boards' };
      const problems = boardProblems(boards);
      if (dropped) problems.push(`${plural(dropped, 'board')} could not be used (bad sizes or over the ${MAX_BOARDS} limit).`);
      const d = clean({ template: 'custom', boards, notes: data.notes, stock: data.stock });
      problems.push(...fitProblems(d));
      return { ok: true, d, name, notes: plain(data.notes, 1500), problems };
    }
    const sizes = data.sizes && typeof data.sizes === 'object' ? data.sizes : {};
    const set = {};
    for (const k of Object.keys(t.limits)) if (sizes[k] !== undefined && Number.isFinite(Number(sizes[k]))) set[k] = Number(sizes[k]);
    return { ok: true, d: clean({ template: data.template, ...t.defaults, ...set }), name, notes: plain(data.notes, 1500), problems: [] };
  }

  const defaults = (id) => clean({ template: id, ...TEMPLATES[id].defaults });
  const info = (d) => TEMPLATES[clean(d).template];
  // Every board says how it is joined; boards a template did not label get the
  // usual join for their kind.
  function joinFor(b, framed) {
    if (b.join) return b.join;
    if (!framed) return JOIN.panel;
    if (/post|leg/i.test(b.name)) return JOIN.post;
    if (/rail|apron|stretcher/i.test(b.name)) return JOIN.rail;
    if (/top|seat/i.test(b.name)) return JOIN.top;
    return JOIN.skin;
  }
  const solids = (d) => {
    d = clean(d);
    const t = TEMPLATES[d.template];
    const framed = d.style === 'framed';
    return (framed ? t.framed(d) : t.solids(d)).map((b) => ({ ...b, join: joinFor(b, framed) }));
  };

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
      const key = `${b.name}|${length}|${width}|${thickness}|${b.join}`;
      if (rows.has(key)) rows.get(key).qty++;
      else rows.set(key, { name: b.name, qty: 1, length, width, thickness, join: b.join });
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

  // Guillotine packing of boards onto sheets, first fit by sheet and best short
  // side fit by free space. Wood in the workshop (have) is used first. Returns
  // the sheets with pieces, the saw cuts in order ({ n, dir: 'h' | 'v', at,
  // from, to }: 'h' runs along the sheet, 'v' across it) and the leftovers
  // worth keeping (offcuts, at least 150 mm each way).
  const OFFCUT = 150;
  function packSheets(flats, haveSheets, o) {
    const { SW, SH, kerf, noBuy, trim, grain } = o;
    const mk = (thickness, W, H, owned) => ({ thickness, W, H, owned, pieces: [], cuts: [], free: [{ x: trim, y: trim, w: W - 2 * trim, h: H - 2 * trim, depth: 0 }] });
    const sheets = haveSheets.map((s) => mk(s.thick, s.w, s.l, true));
    const tooBig = [];
    const unplaced = [];
    const other = [];
    const waysFor = (p, W, H) => (grain ? [[p.l, p.w]] : [[p.l, p.w], [p.w, p.l]]).filter(([w, h]) => w <= W && h <= H);
    const fitIn = (sheet, p) => {
      let hit = null;
      sheet.free.forEach((r, i) => {
        for (const [w, h] of waysFor(p, r.w, r.h)) {
          const lose = Math.min(r.w - w, r.h - h);
          if (!hit || lose < hit.lose) hit = { i, w, h, lose };
        }
      });
      return hit;
    };
    const place = (sheet, hit, p) => {
      const r = sheet.free[hit.i];
      const { w, h } = hit;
      const cw = Math.min(w + kerf, r.w);
      const ch = Math.min(h + kerf, r.h);
      const rw = r.w - cw;
      const rh = r.h - ch;
      sheet.pieces.push({ part: p.part, x: r.x, y: r.y, w, h });
      const next = [];
      const d = r.depth;
      const cut = (dir, at, from, to, depth) => sheet.cuts.push({ dir, at, from, to, depth });
      if (rw < rh) {
        if (rh > 0) cut('h', r.y + h, r.x, r.x + r.w, d);
        if (rw > 0) cut('v', r.x + w, r.y, r.y + h, d + 1);
        next.push({ x: r.x + cw, y: r.y, w: rw, h: ch, depth: d + 2 }, { x: r.x, y: r.y + ch, w: r.w, h: rh, depth: d + 1 });
      } else {
        if (rw > 0) cut('v', r.x + w, r.y, r.y + r.h, d);
        if (rh > 0) cut('h', r.y + h, r.x, r.x + w, d + 1);
        next.push({ x: r.x + cw, y: r.y, w: rw, h: r.h, depth: d + 1 }, { x: r.x, y: r.y + ch, w: cw, h: rh, depth: d + 2 });
      }
      sheet.free.splice(hit.i, 1, ...next.filter((n) => n.w > 0 && n.h > 0));
    };
    for (const p of flats) {
      let done = false;
      for (const sheet of sheets) {
        if (sheet.thickness !== p.t) continue;
        const hit = fitIn(sheet, p);
        if (hit) { place(sheet, hit, p); done = true; break; }
      }
      if (done) continue;
      if (noBuy) { (sheets.some((sh) => sh.thickness === p.t) ? unplaced : other).push(p.part); continue; }
      const sheet = mk(p.t, SW, SH, false);
      const hit = fitIn(sheet, p);
      if (!hit) { tooBig.push({ part: p.part, w: p.l, h: p.w }); continue; }
      place(sheet, hit, p);
      sheets.push(sheet);
    }
    for (const sh of sheets) {
      sh.cuts.sort((a, b) => a.depth - b.depth);
      sh.cuts.forEach((c, i) => { c.n = i + 1; delete c.depth; });
      sh.offcuts = sh.free.filter((f) => Math.min(f.w, f.h) >= OFFCUT).sort((a, b) => b.w * b.h - a.w * a.h).map((f) => ({ x: f.x, y: f.y, w: f.w, h: f.h }));
    }
    return { sheets, tooBig, unplaced, other };
  }

  function layout(d, opts) {
    const [SW, SH] = (opts && opts.sheet) || SHEET;
    const kerf = opts && opts.kerf !== undefined ? opts.kerf : KERF;
    const rows = (opts && opts.rows) || parts(d);
    const pieces = [];
    rows.forEach((r, part) => { for (let i = 0; i < r.qty; i++) pieces.push({ part, l: r.length, w: r.width, t: r.thickness }); });
    // Narrow boards (strips) come from lengths of timber; the rest from sheets.
    const strip = opts && opts.strip === false ? 0 : STRIP;
    const noBuy = !!(opts && opts.noBuy); // only the stock given: what does not fit is reported, never bought
    const unplaced = [];
    const other = [];
    const strips = pieces.filter((p) => p.w <= strip);
    const flats = pieces.filter((p) => p.w > strip);
    flats.sort((a, b) => b.t - a.t || b.l - a.l || b.w - a.w);
    const have = ownedStock(opts && opts.stock);
    // Wood already in the workshop goes in first, biggest pieces first.
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
    // Sheets: guillotine packing (every saw cut runs edge to edge), tried in a
    // few board orders; the one that buys fewest sheets, then uses fewest, then
    // needs fewest cuts, wins.
    const o = { SW, SH, kerf, noBuy, trim: Math.max(0, Number(opts && opts.trim) || 0), grain: !!(opts && opts.grain) };
    const orders = [
      (a, b) => b.t - a.t || b.l - a.l || b.w - a.w,
      (a, b) => b.t - a.t || b.l * b.w - a.l * a.w,
      (a, b) => b.t - a.t || b.w - a.w || b.l - a.l,
      (a, b) => b.t - a.t || Math.max(b.l, b.w) - Math.max(a.l, a.w) || b.l * b.w - a.l * a.w,
    ];
    let best = null;
    for (const cmp of orders) {
      const r = packSheets([...flats].sort(cmp), have.sheets, o);
      const bought = r.sheets.filter((sh) => sh.pieces.length && !sh.owned).length;
      const used = r.sheets.filter((sh) => sh.pieces.length).length;
      const cuts = r.sheets.reduce((n, sh) => n + sh.cuts.length, 0);
      const score = [r.tooBig.length + r.unplaced.length + r.other.length, bought, used, cuts];
      if (!best || score.findIndex((v, i) => v !== best.score[i]) >= 0 && score[score.findIndex((v, i) => v !== best.score[i])] < best.score[score.findIndex((v, i) => v !== best.score[i])]) best = { r, score };
    }
    const { sheets, tooBig: tooBigSheets } = best.r;
    unplaced.push(...best.r.unplaced);
    other.push(...best.r.other);
    tooBig.push(...tooBigSheets);
    // Owned wood nothing was cut from is left on the shelf.
    const cut = sheets.filter((sh) => sh.pieces.length);
    const area = cut.reduce((a, sh) => a + sh.W * sh.H, 0);
    const used = cut.reduce((a, sh) => a + sh.pieces.reduce((b, q) => b + q.w * q.h, 0), 0);
    return {
      width: SW, height: SH,
      sheets: cut.map((sh) => ({ thickness: sh.thickness, width: sh.W, height: sh.H, owned: sh.owned, pieces: sh.pieces, cuts: sh.cuts, offcuts: sh.offcuts })),
      tooBig, area, used, unplaced, other,
      timber: timber.map((g) => ({ width: g.width, thickness: g.thickness, stock: g.stock, bars: g.bars.filter((b) => b.pieces.length).map((b) => ({ len: b.len, owned: b.owned, pieces: b.pieces })) })).filter((g) => g.bars.length),
    };
  }

  // Does the design fit the board the person said they have? Only that stock is
  // used (nothing is bought) and the saw cut is counted. Without a stated board
  // it is null.
  //   -> { stock, sheets, unplaced: [{ name, qty }], other: [{ name, qty, thickness }],
  //        need, have, over }  (areas in m2; over > 0 means not enough board)
  function fit(d) {
    d = clean(d);
    const st = d.stock;
    if (!st) return null;
    const rows = parts(d);
    const list = [];
    const other = [];
    rows.forEach((r, part) => { for (let i = 0; i < r.qty; i++) (r.thickness === st.t ? list : other).push(r.thickness === st.t ? { part, l: r.length, w: r.width } : part); });
    // Pieces go on the boards of the stated stock with the saw cut kept between
    // them; several orders are tried and the one that places most wins.
    let best = null;
    const orders = [(a, b) => b.l * b.w - a.l * a.w, (a, b) => b.l - a.l || b.w - a.w, (a, b) => b.w - a.w || b.l - a.l];
    for (const order of orders) {
      const boards = Array.from({ length: st.qty }, () => ({ free: [{ x: 0, y: 0, w: st.l + KERF, h: st.w + KERF }], pieces: [] }));
      const left = [];
      for (const p of list.slice().sort(order)) {
        let pick = null;
        for (const bd of boards) {
          for (const f of bd.free) {
            for (const [w, h] of [[p.l, p.w], [p.w, p.l]]) {
              if (w + KERF > f.w || h + KERF > f.h) continue;
              const score = Math.min(f.w - w - KERF, f.h - h - KERF);
              if (!pick || score < pick.score) pick = { bd, f, w, h, score };
            }
          }
        }
        if (!pick) { left.push(p.part); continue; }
        const { bd, f, w, h } = pick;
        bd.pieces.push({ part: p.part, x: f.x, y: f.y, w, h });
        // Cut the used corner out of every free area it touches, keeping what is left.
        const used = { x: f.x, y: f.y, w: w + KERF, h: h + KERF };
        const next = [];
        for (const r of bd.free) {
          if (used.x >= r.x + r.w || used.x + used.w <= r.x || used.y >= r.y + r.h || used.y + used.h <= r.y) { next.push(r); continue; }
          if (used.x > r.x) next.push({ x: r.x, y: r.y, w: used.x - r.x, h: r.h });
          if (used.x + used.w < r.x + r.w) next.push({ x: used.x + used.w, y: r.y, w: r.x + r.w - used.x - used.w, h: r.h });
          if (used.y > r.y) next.push({ x: r.x, y: r.y, w: r.w, h: used.y - r.y });
          if (used.y + used.h < r.y + r.h) next.push({ x: r.x, y: used.y + used.h, w: r.w, h: r.y + r.h - used.y - used.h });
        }
        bd.free = next.filter((r, i) => r.w > 0 && r.h > 0 && !next.some((o, j) => j !== i && o.x <= r.x && o.y <= r.y && o.x + o.w >= r.x + r.w && o.y + o.h >= r.y + r.h && (o.w * o.h > r.w * r.h || j < i)));
      }
      if (!best || left.length < best.left.length) best = { boards, left };
    }
    const count = (idx) => { const m = new Map(); for (const i of idx) m.set(i, (m.get(i) || 0) + 1); return [...m].map(([i, qty]) => ({ name: rows[i].name, qty, thickness: rows[i].thickness })); };
    let need = 0;
    for (const r of rows) if (r.thickness === st.t) need += r.qty * (r.length + KERF) * (r.width + KERF);
    const have = st.qty * st.w * st.l;
    const sheets = best.boards.filter((bd) => bd.pieces.length).map((bd) => ({ thickness: st.t, width: st.l, height: st.w, owned: true, pieces: bd.pieces }));
    const area = sheets.length * st.l * st.w;
    const usedArea = sheets.reduce((a, sh) => a + sh.pieces.reduce((b, q) => b + q.w * q.h, 0), 0);
    const layout = { width: st.l, height: st.w, sheets, timber: [], tooBig: [], area, used: usedArea };
    return { stock: st, layout, sheets, unplaced: count(best.left), other: count(other), need: need / 1e6, have: have / 1e6, over: Math.max(0, need - have) / 1e6 };
  }

  // Plain sentences for what a stated board cannot give, empty when all is well.
  function fitProblems(d) {
    const f = fit(d);
    if (!f) return [];
    const out = [];
    const st = f.stock;
    const of = (list) => list.map((u) => `${u.name}${u.qty > 1 ? ` × ${u.qty}` : ''}`).join(', ');
    const board = `${st.qty > 1 ? `${st.qty} × ` : ''}${st.l} × ${st.w} × ${st.t} mm`;
    if (f.unplaced.length) out.push(`Does not fit the ${board} board you have: ${of(f.unplaced)}. The parts that need cutting from it come to ${f.need.toFixed(2)} m² (with saw cuts) and the board is ${f.have.toFixed(2)} m²${f.over > 0 ? `, over by ${f.over.toFixed(2)} m²` : ', so they will not pack into it'}. Make it smaller or get more board.`);
    if (f.other.length) out.push(`Needs different wood than the ${st.t} mm board: ${of(f.other)} (buy separately).`);
    return out;
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
  function stockLines(l) {
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
    return out;
  }
  // Screws, glue, hinges and the anti-tip kit for one design.
  function fixingLines(d) {
    const out = [];
    const c = clean(d);
    const boards = solids(c).length;
    if (c.style === 'framed' || c.template === 'custom') out.push({ key: 'screws', label: '60 mm wood screws, box of 200', qty: Math.max(1, Math.ceil((boards * 6) / 200)), have: 0, search: '60mm wood screws box 200', estimate: 8 });
    else out.push({ key: 'screws', label: 'Wood screws, box', qty: 1, have: 0, search: 'wood screws box', estimate: 5 });
    out.push({ key: 'glue', label: 'Wood glue, 250 ml', qty: 1, have: 0, search: 'wood glue 250ml', estimate: 5 });
    if (c.doors) out.push({ key: 'hinges', label: 'Cabinet hinges, pair', qty: c.doors, have: 0, search: 'cabinet hinges pair', estimate: 3 });
    if (checks(c).some((k) => k.tip)) out.push({ key: 'antitip', label: 'Anti-tip wall bracket kit', qty: 1, have: 0, search: 'furniture anti tip wall bracket', estimate: 4 });
    return out;
  }
  function materials(d, opts) {
    return [...stockLines(layout(d, opts)), ...fixingLines(d)];
  }

  // Several designs cut from the same sheets and timber, so offcuts from one go
  // to the next. Boards are named "1 Side" (design number, then the part).
  //   -> { layout, rows: [{ ...part, project }], materials, apart }
  // apart is the sheets and timber lengths the same designs need one at a time.
  function combine(designs, opts) {
    const ds = designs.map(clean);
    const rows = ds.flatMap((d, i) => parts(d).map((r) => ({ ...r, name: `${i + 1} ${r.name}`, project: i })));
    const l = layout(ds[0], { ...opts, rows });
    const lines = new Map();
    const add = (m) => { const e = lines.get(m.key); if (e) e.qty += m.qty; else lines.set(m.key, { ...m }); };
    stockLines(l).forEach(add);
    ds.flatMap(fixingLines).forEach(add);
    if (lines.has('glue')) lines.get('glue').qty = Math.max(1, Math.ceil(ds.length / 2));
    const count = (m) => m.filter((x) => /^(sheet|timber)-/.test(x.key)).reduce((a, x) => a + x.qty, 0);
    const apart = ds.reduce((a, d) => a + count(materials(d, opts)), 0);
    return { layout: l, rows, materials: [...lines.values()], apart, together: count([...lines.values()]) };
  }

  // Things worth knowing before building: it might tip, sag or rack. Each is
  // { level: 'warn' | 'note', text, tip? } (tip: needs fixing to the wall).
  function checks(d) {
    d = clean(d);
    const out = [];
    if (d.template === 'custom') {
      for (const text of boardProblems(d.boards)) out.push({ level: 'warn', text });
      for (const text of fitProblems(d)) out.push({ level: 'warn', text });
      const z = size(d);
      if (z.height / Math.min(z.width, z.depth) > 4) out.push({ level: 'note', tip: true, text: 'Tall for its footprint: fix it to the wall with an anti-tip bracket; one is on the shopping list.' });
      return out;
    }
    if (d.template === 'bookshelf' || d.template === 'cabinet') {
      const ratio = d.height / d.depth;
      const times = Math.round(ratio * 10) / 10;
      if (ratio > 7) out.push({ level: 'warn', tip: true, text: `It is ${times} times as tall as it is deep, so it will tip easily. Make it deeper, and fix it to the wall.` });
      else if (ratio > 4 && d.style === 'panel') out.push({ level: 'warn', tip: true, text: `Sheets butted together have no frame or back, so a piece this tall (${times} times its depth) can rack and topple. Switch to Framed, and fix it to the wall.` });
      else if (ratio > 4) out.push({ level: 'note', tip: true, text: `Fix it to the wall with an anti-tip bracket; one is on the shopping list.` });
      const span = d.width - (d.style === 'framed' ? 2 * (SKIN + d.frame) : 2 * d.thickness);
      if (d.shelves > 0 && span > 50 * d.thickness) out.push({ level: 'note', text: 'Shelves this wide can sag: use thicker boards or add a middle support.' });
    }
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
    desk: ['desk', 'workstation', 'workbench'],
    cabinet: ['cabinet', 'cupboard', 'sideboard', 'unit', 'wardrobe', 'nightstand', 'bedside'],
    box: ['box', 'crate', 'chest', 'trunk'],
    bench: ['bench', 'pew'],
    stool: ['stool', 'footstool', 'barstool'],
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

  // ---------- build steps and the timeline ----------
  // The saved part of a project's build: when it starts, hours a day to spend,
  // the finish, and which steps are ticked off.
  const FINISHES = { none: 'No finish', oil: 'Oil', paint: 'Paint', varnish: 'Varnish' };
  const FINISH_COATS = { oil: { coats: 2, wait: [6, 12] }, paint: { coats: 2, wait: [4, 12] }, varnish: { coats: 3, wait: [6, 12] } };
  function cleanBuild(input) {
    const i = input && typeof input === 'object' ? input : {};
    const hours = Math.round(Number(i.hours) * 2) / 2;
    return {
      start: /^\d{4}-\d{2}-\d{2}$/.test(String(i.start)) && !Number.isNaN(Date.parse(i.start)) ? String(i.start) : '',
      hours: Number.isFinite(hours) && hours >= 1 && hours <= 12 ? hours : 4,
      finish: FINISHES[i.finish] ? i.finish : 'none',
      done: [...new Set((Array.isArray(i.done) ? i.done : []).map(String).filter((v) => /^[a-z0-9]{2,12}$/.test(v)))].slice(0, 30),
    };
  }

  // The steps to build a design, in order. work and wait are hours; wait is the
  // time to leave it alone afterwards (glue, finish). tools are what each step
  // needs. Rough, from the number of boards, and the same every time.
  //   -> [{ id, name, work, wait, waitName, tools: [] }]
  function steps(d, finish) {
    const n = Math.max(1, parts(d).reduce((a, r) => a + r.qty, 0));
    const half = (v) => Math.max(0.5, Math.round(v * 2) / 2);
    const framed = d.style === 'framed';
    const out = [
      { id: 'cut', name: 'Cut the boards', work: half(0.3 + 0.12 * n), wait: 0, tools: ['Saw (circular or panel)', 'Tape and square'] },
      { id: 'sand', name: 'Sand every part', work: half(0.05 * n + 0.3), wait: 0, tools: ['Sander and sandpaper'] },
      { id: 'build', name: framed ? 'Glue and screw the frames' : 'Glue and screw it together', work: half(0.4 + 0.15 * n), wait: 12, waitName: 'Glue dries', tools: ['Drill and pilot bit', 'Clamps', 'Wood glue'] },
    ];
    if (framed) out.push({ id: 'fit', name: 'Fit the shelves and skins', work: half(0.3 + 0.08 * n), wait: 0, tools: ['Drill and pilot bit'] });
    const f = FINISH_COATS[finish];
    if (f) {
      for (let c = 1; c <= f.coats; c++) {
        out.push({ id: `coat${c}`, name: `${FINISHES[finish]}, coat ${c}`, work: half(0.2 + 0.05 * n), wait: c === f.coats ? f.wait[1] : f.wait[0], waitName: `Coat ${c} dries`, tools: ['Brush and rag'] });
      }
    }
    if (d.template === 'bookshelf' || d.template === 'cabinet') out.push({ id: 'wall', name: 'Fix it to the wall (anti-tip)', work: 0.5, wait: 0, tools: ['Drill and pilot bit', 'Spirit level'] });
    return out;
  }

  // Lays the steps out in days from the start. hoursPerDay is the time you give
  // it each day; waiting runs on the clock. Positions are in days (fractions
  // of a day), so a bar is drawn at its position and length.
  //   -> { steps: [{ ...step, at, len, waitAt, waitLen }], days, ready, work, waiting }
  function schedule(list, hoursPerDay) {
    const perDay = Math.min(12, Math.max(1, Number(hoursPerDay) || 4));
    let t = 0;
    let work = 0;
    let waiting = 0;
    const out = list.map((st) => {
      const row = { ...st, at: t, len: st.work / perDay, waitAt: 0, waitLen: 0 };
      t += row.len;
      work += st.work;
      if (st.wait) {
        row.waitAt = t;
        row.waitLen = st.wait / 24;
        t += row.waitLen;
        waiting += st.wait;
      }
      return row;
    });
    return { steps: out, days: t, ready: Math.max(1, Math.ceil(t - 1e-9)), work, waiting };
  }

  // Every tool the steps need, once each.
  const toolsFor = (list) => [...new Set(list.flatMap((st) => st.tools))];

  const exported = { combine, FINISHES, cleanBuild, steps, schedule, toolsFor, fit, fitProblems, cleanStock, TEMPLATES, IDS, clean, defaults, info, solids, size, view, parts, layout, materials, project, parse, ownedStock, checks, sanitizeBoards, boardProblems, designInstructions, readDesign, describeDesign, reviseRequest };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  else window.birdhouseModel = exported;
})();
