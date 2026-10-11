'use strict';

// Roost's HTML email: a black header with the animated Roost mark, a cream
// card with the message and one button. Built from tables with inline styles
// (the only layout every mail app agrees on), system fonts, and the header
// travels inside the email, so nothing is fetched from anywhere when it is
// opened. A plain-text version is always sent with it.

const fs = require('fs');
const path = require('path');

const HEADER_CID = 'roost-header@roost';
const HEADER = fs.readFileSync(path.join(__dirname, 'email-header.gif'));

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const FONT = "-apple-system,'Segoe UI',Helvetica,Arial,sans-serif";
const MONO = "'SFMono-Regular',Menlo,Consolas,monospace";

// `paragraphs` and `fine` are plain strings; `button` is { label, url }.
function render({ title, paragraphs = [], button = null, fine = '', signoff = '' }) {
  const p = (t, style) => `<p style="margin:0 0 16px;font:16px/1.5 ${FONT};color:#0a0a0a;${style || ''}">${esc(t)}</p>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#0a0a0a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;background:#f2efe9;border-radius:16px;overflow:hidden">
<tr><td style="background:#0a0a0a;padding:0"><img src="cid:${HEADER_CID}" width="560" height="96" alt="roost" style="display:block;width:100%;max-width:560px;height:auto;border:0"></td></tr>
<tr><td style="padding:28px 28px 8px">
<h1 style="margin:0 0 16px;font:700 24px/1.2 ${FONT};color:#0a0a0a;letter-spacing:-0.02em">${esc(title)}</h1>
${paragraphs.map((t) => p(t)).join('\n')}
${button ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 20px"><tr><td style="background:#0a0a0a;border-radius:10px"><a href="${esc(button.url)}" style="display:inline-block;padding:13px 22px;font:600 16px ${FONT};color:#f2efe9;text-decoration:none">${esc(button.label)}</a></td></tr></table>
<p style="margin:0 0 16px;font:12px/1.5 ${MONO};color:#6b6860;word-break:break-all">${esc(button.url)}</p>` : ''}
${fine ? p(fine, `font-size:13px;color:#6b6860;`) : ''}
</td></tr>
<tr><td style="padding:0 28px 26px;font:12px ${MONO};color:#6b6860;text-transform:uppercase;letter-spacing:0.04em">${esc(signoff || 'See you inside')}</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

module.exports = { render, HEADER, HEADER_CID };
