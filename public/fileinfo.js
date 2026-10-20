'use strict';

// Info for a file or folder: its details, plus what Google kept about it when it
// was moved from Drive or Photos. Shared by Nest and Glint.
//
//   fileInfo.open(id, space, app)   (app: 'nest', or 'glint' for a photo) shows the panel (right side on a computer, a
//                              sheet from the bottom on a phone)
//   fileInfo.close()
//
// It asks the server once, when it opens. Rows with nothing to show are left out.

window.fileInfo = (function fileInfo() {
  let panel = null;
  let body = null;
  let title = null;
  let token = 0;
  let back = null;

  const when = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const mimeName = (it) => {
    if (it.kind === 'folder') return 'Folder';
    const ext = /\.([^./]+)$/.exec(it.name);
    return it.mime || (ext ? `${ext[1].toUpperCase()} file` : 'File');
  };

  function row(label, ...value) {
    const v = value.filter((x) => x !== null && x !== '' && x !== undefined);
    if (!v.length) return null;
    return el('div', { class: 'finfo-row' }, el('span', { class: 'mono muted', text: label }), el('div', { class: 'finfo-val' }, ...v));
  }

  function copyBtn(text) {
    const b = el('button', { type: 'button', class: 'link-btn mono', text: 'Copy' });
    b.onclick = async () => {
      try {
        await navigator.clipboard.writeText(text);
        b.textContent = 'Copied';
        setTimeout(() => { b.textContent = 'Copy'; }, 1500);
      } catch { /* no clipboard here: the text can still be selected */ }
    };
    return b;
  }

  const line = (text) => el('div', { text });
  const outside = (href, text) => el('a', { href, target: '_blank', rel: 'noopener noreferrer', text });
  const who = (p) => [p.name, p.email].filter(Boolean).join(' · ');
  const ROLE = { owner: 'Owner', writer: 'Can edit', commenter: 'Can comment', reader: 'Can view', organizer: 'Manager', fileOrganizer: 'Manager' };

  function sections(it) {
    const g = it.google;
    const out = [el('div', { class: 'finfo-group' },
      row('Type', mimeName(it)),
      it.kind === 'file' ? row('Size', `${bytes(it.size)} (${it.size.toLocaleString()} bytes)`) : null,
      row('Where', it.where.join(' › ')),
      row('Modified', when(it.modified)),
      row('Added to Roost', when(it.created)))];
    if (!g) return out;
    if (g.source === 'drive') {
      out.push(el('div', { class: 'finfo-group' }, el('h4', { class: 'mono', text: 'From Google Drive' }),
        row('Owner', g.owner ? who(g.owner) : ''),
        row('Created', g.created ? when(g.created) : ''),
        row('Last modified', g.modified ? when(g.modified) : ''),
        row('Starred', g.starred ? 'Yes' : ''),
        row('Shared with', ...(g.shared || []).map((p) => line(`${who(p)}${ROLE[p.role] ? ` · ${ROLE[p.role]}` : ''}`))),
        row('Original type', g.mime && g.mime !== it.mime ? g.mime : ''),
        row('Drive ID', g.driveId ? el('span', { class: 'finfo-id' }, line(g.driveId), copyBtn(g.driveId)) : ''),
        row('Drive link', g.link ? outside(g.link, 'Open in Google Drive') : '')));
    } else if (g.source === 'photos') {
      const place = g.lat !== undefined ? `${g.lat}, ${g.lng}` : '';
      out.push(el('div', { class: 'finfo-group' }, el('h4', { class: 'mono', text: 'From Google Photos' }),
        row('Taken', g.taken ? when(g.taken) : ''),
        row('Added to Google', g.created ? when(g.created) : ''),
        row('Description', g.description || ''),
        row('Place', place ? el('span', { class: 'finfo-id' }, line(place), copyBtn(place)) : ''),
        row('People', ...(g.people || []).map(line)),
        row('Uploaded from', g.origin || ''),
        row('Starred', g.starred ? 'Yes' : ''),
        row('Google Photos link', g.link ? outside(g.link, 'Open in Google Photos') : '')));
    }
    if (g.comments && g.comments.length) out.push(commentsGroup(g.comments));
    return out;
  }

  // Drive comments with their replies, as they were.
  function commentsGroup(list) {
    const reply = (r) => el('div', { class: 'finfo-reply' },
      el('div', {}, el('b', { text: r.author || 'Someone' }), r.action ? el('span', { class: 'muted', text: ` · ${r.action}` }) : null),
      r.text ? el('div', { class: 'finfo-text', text: r.text }) : null,
      r.date ? el('div', { class: 'mono muted', text: r.date }) : null);
    return el('div', { class: 'finfo-group' }, el('h4', { class: 'mono', text: `Comments (${list.length})` }),
      ...list.map((c) => el('div', { class: 'finfo-comment' },
        el('div', {}, el('b', { text: c.author || 'Someone' }), c.resolved ? el('span', { class: 'mono muted', text: ' · resolved' }) : null),
        c.about ? el('blockquote', { class: 'finfo-about', text: c.about }) : null,
        c.text ? el('div', { class: 'finfo-text', text: c.text }) : null,
        c.date ? el('div', { class: 'mono muted', text: c.date }) : null,
        ...(c.replies || []).map(reply))));
  }

  function build() {
    title = el('b', { class: 'finfo-title' });
    body = el('div', { class: 'finfo-body' });
    const x = el('button', { type: 'button', class: 'finfo-x', 'aria-label': 'Close info', onclick: close });
    x.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    panel = el('aside', { class: 'finfo hidden', role: 'dialog', 'aria-label': 'Info', tabindex: '-1' },
      el('div', { class: 'finfo-head' },
        el('div', { class: 'finfo-name' }, el('span', { class: 'mono muted', text: 'Info' }), title),
        x),
      body);
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
    });
    document.body.append(panel);
  }

  async function open(id, space, app = 'nest') {
    if (!panel) build();
    if (panel.classList.contains('hidden')) back = document.activeElement;
    const mine = ++token;
    title.textContent = '';
    body.replaceChildren(el('p', { class: 'muted', text: 'Loading…' }));
    panel.classList.remove('hidden');
    panel.focus({ preventScroll: true });
    try {
      const { info } = await api('GET', `${app === 'glint' ? '/api/glint/info/' : '/api/nest/items/'}${encodeURIComponent(id)}${app === 'glint' ? '' : '/info'}${space ? `?space=${space}` : ''}`);
      if (mine !== token) return;
      title.textContent = info.name;
      body.replaceChildren(...sections(info).filter(Boolean));
    } catch (err) {
      if (mine === token) body.replaceChildren(el('p', { class: 'muted', text: err.message }));
    }
  }

  function close() {
    token++;
    if (panel && !panel.classList.contains('hidden')) {
      panel.classList.add('hidden');
      if (back && back.isConnected) back.focus({ preventScroll: true });
    }
    back = null;
  }

  addEventListener('hashchange', close); // Back, or any link, closes it

  return { open, close, get isOpen() { return Boolean(panel) && !panel.classList.contains('hidden'); } };
}());
