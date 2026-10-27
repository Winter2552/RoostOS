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

  const exported = { LIMITS, DEFAULTS, clean, front, parts };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  else window.birdhouseModel = exported;
})();
