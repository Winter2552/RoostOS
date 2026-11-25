'use strict';

// A small PDF writer for Birdhouse plan sheets, built in-house (no library, no
// outside service). Black on white, vector drawings, one monospace font, so
// the file is tiny and prints sharply. Coordinates are in points from the top
// left of the page; the writer flips them for PDF.

(() => {
  const W = 595.28; // A4
  const H = 841.89;

  // PDF's built-in fonts use Latin-1 text, so anything outside it becomes "?".
  const latin = (s) => String(s).replace(/[^\x20-\x7e\xa0-\xff]/g, (c) => (c === '–' || c === '—' ? '-' : c === '’' ? "'" : '?'));
  const esc = (s) => latin(s).replace(/([\\()])/g, '\\$1');
  const num = (n) => (Math.round(n * 100) / 100).toString();
  const gray = (g) => `${num(g)} ${num(g)} ${num(g)}`;
  const advance = (text, size) => latin(text).length * size * 0.6; // Courier is 0.6 em wide

  function create() {
    const pages = [];
    let ops = null;
    const doc = {
      width: W, height: H,
      page() { ops = []; pages.push(ops); },
      raw(s) { ops.push(s); },
      advance,
      text(str, x, y, size, o = {}) {
        const w = advance(str, size);
        const px = o.anchor === 'middle' ? x - w / 2 : o.anchor === 'end' ? x - w : x;
        const font = o.bold ? 'F2' : 'F1';
        const tm = o.rotate ? `0 1 -1 0 ${num(px)} ${num(H - y)}` : `1 0 0 1 ${num(px)} ${num(H - y)}`;
        ops.push(`BT /${font} ${num(size)} Tf ${gray(o.gray ?? 0)} rg ${tm} Tm (${esc(str)}) Tj ET`);
      },
      line(x1, y1, x2, y2, o = {}) {
        ops.push(`q ${num(o.width ?? 0.6)} w ${gray(o.gray ?? 0)} RG ${o.dash ? `[${o.dash.join(' ')}] 0 d ` : ''}${num(x1)} ${num(H - y1)} m ${num(x2)} ${num(H - y2)} l S Q`);
      },
      rect(x, y, w, h, o = {}) {
        const paint = o.fill != null && o.stroke !== false ? 'B' : o.fill != null ? 'f' : 'S';
        ops.push(`q ${num(o.width ?? 0.6)} w ${gray(o.gray ?? 0)} RG ${gray(o.fill ?? 1)} rg ${o.dash ? `[${o.dash.join(' ')}] 0 d ` : ''}${num(x)} ${num(H - y - h)} ${num(w)} ${num(h)} re ${paint} Q`);
      },
      polygon(pts, o = {}) {
        const path = pts.map((p, i) => `${num(p[0])} ${num(H - p[1])} ${i ? 'l' : 'm'}`).join(' ');
        ops.push(`q ${num(o.width ?? 0.5)} w ${gray(o.gray ?? 0)} RG ${gray(o.fill ?? 1)} rg 1 j ${path} h B Q`);
      },
      circle(cx, cy, r, o = {}) {
        const k = 0.5523 * r;
        const y = H - cy;
        ops.push(`q ${gray(o.fill ?? 0)} rg ${num(cx + r)} ${num(y)} m ${num(cx + r)} ${num(y + k)} ${num(cx + k)} ${num(y + r)} ${num(cx)} ${num(y + r)} c ${num(cx - k)} ${num(y + r)} ${num(cx - r)} ${num(y + k)} ${num(cx - r)} ${num(y)} c ${num(cx - r)} ${num(y - k)} ${num(cx - k)} ${num(y - r)} ${num(cx)} ${num(y - r)} c ${num(cx + k)} ${num(y - r)} ${num(cx + r)} ${num(y - k)} ${num(cx + r)} ${num(y)} c f Q`);
      },
      // Draw an <svg> made of rect, line, polygon, circle and text, scaled to
      // fit the box; returns the height used.
      svg(root, x, y, w, maxH) {
        const [vx, vy, vw, vh] = root.getAttribute('viewBox').split(/[\s,]+/).map(Number);
        const s = Math.min(w / vw, maxH / vh);
        const ox = x + (w - vw * s) / 2;
        const X = (v) => ox + (v - vx) * s;
        const Y = (v) => y + (v - vy) * s;
        const a = (el, k) => Number(el.getAttribute(k));
        const cls = (el) => el.getAttribute('class') || '';
        for (const el of root.querySelectorAll('rect,line,polygon,circle,text')) {
          const c = cls(el);
          const tag = el.tagName.toLowerCase();
          if (tag === 'rect') {
            const dashed = /bh-hidden|bh-stock|bh-offcut/.test(c);
            const o = { x: X(a(el, 'x')), y: Y(a(el, 'y')), w: a(el, 'width') * s, h: a(el, 'height') * s };
            if (dashed) doc.rect(o.x, o.y, o.w, o.h, { gray: c.includes('bh-offcut') ? 0.6 : 0.35, dash: [3, 2.5], width: 0.5 });
            else doc.rect(o.x, o.y, o.w, o.h, { fill: 0.92, width: 0.7 });
          } else if (tag === 'line') {
            doc.line(X(a(el, 'x1')), Y(a(el, 'y1')), X(a(el, 'x2')), Y(a(el, 'y2')), { gray: 0.25, width: 0.5 });
          } else if (tag === 'polygon') {
            const pts = el.getAttribute('points').trim().split(/\s+/).map((p) => p.split(',').map(Number)).map(([px, py]) => [X(px), Y(py)]);
            const light = el.hasAttribute('fill-opacity') ? Number(el.getAttribute('fill-opacity')) : 1;
            doc.polygon(pts, { fill: 1 - 0.7 * light, width: 0.5 });
          } else if (tag === 'circle') {
            doc.circle(X(a(el, 'cx')), Y(a(el, 'cy')), a(el, 'r') * s, { fill: 0 });
          } else {
            const fs = a(el, 'font-size') * s;
            const tx = X(a(el, 'x'));
            const ty = Y(a(el, 'y'));
            const anchor = el.getAttribute('text-anchor') === 'middle' ? 'middle' : 'start';
            const rot = /rotate\(\s*-90/.test(el.getAttribute('transform') || '');
            const white = c.includes('bh-cutnum');
            doc.text(el.textContent, tx, ty, fs, { anchor, rotate: rot, gray: white ? 1 : c.includes('bh-note-svg') ? 0.4 : 0, bold: white });
          }
        }
        return vh * s;
      },
      // The finished file as bytes.
      build() {
        const objs = [];
        const add = (body) => objs.push(body) && objs.length; // returns the object number
        add('<< /Type /Catalog /Pages 2 0 R >>');
        add(''); // pages, filled in below
        add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>');
        add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>');
        const kids = [];
        for (const p of pages) {
          const stream = p.join('\n');
          const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
          kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(W)} ${num(H)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${content} 0 R >>`));
        }
        objs[1] = `<< /Type /Pages /Count ${kids.length} /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] >>`;
        let out = '%PDF-1.4\n';
        const at = [];
        objs.forEach((body, i) => { at.push(out.length); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
        const xref = out.length;
        out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${at.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
        // Everything is Latin-1, so one byte per character.
        const bytes = new Uint8Array(out.length);
        for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 255;
        return bytes;
      },
    };
    return doc;
  }

  const api = { create, advance, W, H };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.BirdhousePdf = api;
})();
