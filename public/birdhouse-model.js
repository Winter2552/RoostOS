'use strict';

// Birdhouse's plans: a template turns a few sizes (millimetres) into boards.
// Pure arithmetic, no page code, so the browser and the tests share it.
//
// The bookshelf: two sides run the full height; the top, the bottom and the
// shelves between them sit across, evenly spaced. "shelves" counts every
// horizontal board, top and bottom included.

(() => {
  const LIMITS = {
    height: { min: 300, max: 2400, step: 10, label: 'Height' },
    width: { min: 200, max: 2400, step: 10, label: 'Width' },
    depth: { min: 100, max: 800, step: 10, label: 'Depth' },
    shelves: { min: 2, max: 12, step: 1, label: 'Shelves' },
    thickness: { min: 6, max: 40, step: 1, label: 'Board thickness' },
  };

  const DEFAULTS = { height: 1800, width: 800, depth: 300, shelves: 5, thickness: 18 };

  function clean(input) {
    const out = {};
    for (const [key, lim] of Object.entries(LIMITS)) {
      let v = Math.round(Number(input && input[key]));
      if (!Number.isFinite(v)) v = DEFAULTS[key];
      out[key] = Math.min(lim.max, Math.max(lim.min, v));
    }
    // Boards can't be thicker than the shelf is wide, or the sides would meet.
    out.thickness = Math.min(out.thickness, Math.floor((out.width - 20) / 2), Math.floor(out.height / (out.shelves * 2)));
    return out;
  }

  // The boards as seen from the front: x and y are from the top left corner.
  function front(d) {
    d = clean(d);
    const t = d.thickness;
    const boards = [
      { kind: 'side', x: 0, y: 0, w: t, h: d.height },
      { kind: 'side', x: d.width - t, y: 0, w: t, h: d.height },
    ];
    const span = d.height - t;
    for (let i = 0; i < d.shelves; i++) {
      boards.push({ kind: i === 0 ? 'top' : i === d.shelves - 1 ? 'bottom' : 'shelf', x: t, y: Math.round((span * i) / (d.shelves - 1)), w: d.width - 2 * t, h: t });
    }
    return { width: d.width, height: d.height, boards };
  }

  // The cut list: one row per kind of board.
  function parts(d) {
    d = clean(d);
    const t = d.thickness;
    const inner = d.width - 2 * t;
    const rows = [
      { name: 'Side', qty: 2, length: d.height, width: d.depth, thickness: t },
      { name: 'Top and bottom', qty: 2, length: inner, width: d.depth, thickness: t },
    ];
    if (d.shelves > 2) rows.push({ name: 'Shelf', qty: d.shelves - 2, length: inner, width: d.depth, thickness: t });
    return rows;
  }


  // The side view: depth across, height up. The side board hides the shelves,
  // so they show as dashed lines.
  function side(d) {
    d = clean(d);
    const t = d.thickness;
    const span = d.height - t;
    const lines = [];
    for (let i = 0; i < d.shelves; i++) lines.push({ y: Math.round((span * i) / (d.shelves - 1)), h: t });
    return { width: d.depth, height: d.height, lines };
  }

  // The top view: width across, depth up the page. Sides show as strips; the
  // top board covers everything between them.
  function top(d) {
    d = clean(d);
    return { width: d.width, height: d.depth, thickness: d.thickness };
  }

  // Every board as a box in millimetres: x across, y front to back, z up.
  function solids(d) {
    d = clean(d);
    const t = d.thickness;
    const out = [
      { x: 0, y: 0, z: 0, w: t, d: d.depth, h: d.height },
      { x: d.width - t, y: 0, z: 0, w: t, d: d.depth, h: d.height },
    ];
    const span = d.height - t;
    for (let i = 0; i < d.shelves; i++) out.push({ x: t, y: 0, z: Math.round((span * i) / (d.shelves - 1)), w: d.width - 2 * t, d: d.depth, h: t });
    return out;
  }

  // The faces of those boxes as seen from a turned and tilted viewpoint,
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

  function project(d, yaw, pitch) {
    d = clean(d);
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    const mid = [d.width / 2, d.depth / 2, d.height / 2];
    // Turn about the upright axis, then tilt. depth grows away from the viewer.
    const turn = (x, y, z) => {
      const x1 = x * cy - y * sy;
      const y1 = x * sy + y * cy;
      return { sx: x1, sy: -(y1 * sp + z * cp), depth: y1 * cp - z * sp };
    };
    const faces = [];
    for (const b of solids(d)) {
      for (const f of FACES) {
        const n = turn(...f.n);
        if (n.depth >= 0) continue; // facing away
        const pts = f.v.map(([u, v, w]) => {
          const p = turn(b.x + u * b.w - mid[0], b.y + v * b.d - mid[1], b.z + w * b.h - mid[2]);
          return { sx: p.sx, sy: p.sy, depth: p.depth };
        });
        faces.push({ pts, depth: pts.reduce((a, p) => a + p.depth, 0) / 4, light: Math.round((0.1 + 0.14 * Math.max(0, -n.sy) + 0.08 * -n.depth) * 100) / 100 });
      }
    }
    faces.sort((a, b) => b.depth - a.depth);
    return faces.map((f) => ({ pts: f.pts.map((p) => [p.sx, p.sy]), light: f.light }));
  }

  const exported = { LIMITS, DEFAULTS, clean, front, side, top, solids, project, parts };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  else window.birdhouseModel = exported;
})();
