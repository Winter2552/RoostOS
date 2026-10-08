'use strict';

// Roost dashboard client. Plain JS, no build step.

const ICONS = {
  play: '<path d="M8 5.5v13l11-6.5z"/>',
  orbit: '<circle cx="12" cy="12" r="3.2" fill="currentColor"/><ellipse cx="12" cy="12" rx="10" ry="4.6"/><ellipse cx="12" cy="12" rx="10" ry="4.6" transform="rotate(60 12 12)"/>',
  folder: '<path d="M3 6.5h6l2 2.2h10v10.3H3z"/><path d="M3 10.5h18"/>',
  spark: '<path d="M12 3l2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2z"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5" fill="currentColor"/><rect x="4" y="13" width="7" height="7" rx="1.5" fill="currentColor"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  cloud: '<path d="M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 9.5 4.3 4.3 0 0 0 7 18z"/>',
  music: '<path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  home: '<path d="M3 11l9-7 9 7v9h-6v-6H9v6H3z"/>',
};

const state = { serverName: 'Roost', publicUrl: '', mailEnabled: false, user: null, apps: [], status: {}, users: [], defaultLimitGb: null, diskGb: null };

const $ = (sel, root = document) => root.querySelector(sel);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v !== undefined && v !== null) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
}

function icon(name) {
  const span = el('span', { class: 'icon-tile', 'aria-hidden': 'true' });
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round">${ICONS[name] || ICONS.grid}</svg>`;
  return span;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.startsWith('/api/login') && !linkToken()) {
    showWelcome(false);
  }
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

function flash(form, text, ok = true) {
  const msg = $('.msg', form);
  msg.textContent = text;
  msg.className = `msg ${ok ? 'ok' : 'error'}`;
}

// The clipboard API only works over HTTPS, and Roost is often opened on a
// plain http:// LAN address, so fall back to the older copy command.
async function copyPlain(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = el('textarea', { readonly: true, style: 'position:fixed;opacity:0' });
    area.value = text;
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

function resolveUrl(url) {
  return url.replace(/\{host\}/g, location.hostname);
}


function bytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function gb(limit) {
  return limit === null ? 'No limit' : `${limit} GB`;
}

// A slider for choosing GB, with a number box for exact values and, where
// allowed, a "No limit" box. The slider runs up to the size of the data drive.
function gbPicker({ label, allowNone = false } = {}) {
  const range = el('input', { type: 'range', min: 1, step: 1, 'aria-label': label });
  const number = el('input', { type: 'number', min: 1, step: 1, inputmode: 'numeric', 'aria-label': `${label} in GB` });
  const none = el('input', { type: 'checkbox' });
  const drive = el('span', { class: 'mono muted' });
  const node = el('div', { class: 'gb-picker' }, range,
    el('div', { class: 'gb-picker-row' },
      el('label', { class: 'gb-input' }, number, el('span', { class: 'mono muted', text: 'GB' })),
      drive,
      allowNone ? el('div', { class: 'checks' }, el('label', {}, none, 'No limit')) : null));

  const paint = () => {
    const pct = ((range.value - range.min) / (range.max - range.min || 1)) * 100;
    range.style.setProperty('--fill', `${pct}%`);
    node.classList.toggle('none', none.checked);
    number.disabled = none.checked;
  };
  const setMax = (want) => {
    const max = Math.max(Number(range.min) + 1, state.diskGb || 4000, want || 0);
    range.max = max;
    drive.textContent = state.diskGb ? `Drive ${gb(state.diskGb)}` : '';
  };
  range.addEventListener('input', () => { none.checked = false; number.value = range.value; paint(); });
  number.addEventListener('input', () => {
    const n = Math.round(Number(number.value));
    if (n > Number(range.max)) setMax(n);
    if (n) range.value = n;
    paint();
  });
  none.addEventListener('change', paint);

  node.setValue = (gbValue, min = 1) => {
    range.min = number.min = min;
    none.checked = gbValue === null;
    const v = gbValue === null ? Math.max(min, state.defaultLimitGb || 50) : gbValue;
    setMax(v);
    range.value = number.value = v;
    paint();
  };
  node.getValue = () => (none.checked ? null : number.value.trim() === '' ? NaN : Number(number.value));
  return node;
}

const pickers = {
  request: gbPicker({ label: 'Storage you need' }),
  newUser: gbPicker({ label: 'Storage limit', allowNone: true }),
  default: gbPicker({ label: 'Default storage limit', allowNone: true }),
};
$('#request-picker').replaceWith(pickers.request);
$('#new-user-picker').replaceWith(pickers.newUser);
$('#default-picker').replaceWith(pickers.default);

function shortDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function duration(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

function setServerName(name) {
  state.serverName = name;
  document.title = name;
  document.querySelectorAll('[data-server-name]').forEach((n) => { n.textContent = name; });
}

// ---------- welcome: setup / sign in ----------

let setupMode = false;

function showWelcome(setup) {
  setupMode = setup;
  state.user = null;
  $('#shell').classList.add('hidden');
  $('#secure').classList.add('hidden');
  $('#welcome').classList.remove('hidden');
  showCodeStep(null);
  $('#display-name-field').classList.toggle('hidden', !setup);
  $('#welcome-lead').textContent = setup ? 'First run · create the admin account' : 'Sign in to your home server';
  $('#welcome-form [name=password]').autocomplete = setup ? 'new-password' : 'current-password';
  $('#welcome-submit').textContent = setup ? 'Create account' : 'Continue';
  showForgot(false);
  setMailEnabled(state.mailEnabled);
}

$('#welcome-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { username: f.username.value, password: f.password.value };
  if (setupMode) body.displayName = f.displayName.value;
  try {
    const res = await api('POST', setupMode ? '/api/setup' : '/api/login', body);
    $('#welcome-msg').textContent = '';
    if (res.twoStep) {
      f.password.value = '';
      showCodeStep(res.ticket);
      return;
    }
    f.reset();
    await enter(res.user);
  } catch (err) {
    $('#welcome-msg').textContent = err.message;
  }
});

// ---------- sign in: second step ----------

let codeTicket = null;
let recoveryMode = false;

function showCodeStep(ticket) {
  codeTicket = ticket;
  const f = $('#code-form');
  $('#welcome-form').classList.toggle('hidden', Boolean(ticket));
  f.classList.toggle('hidden', !ticket);
  $('#welcome-lead').textContent = ticket ? 'One more step'
    : setupMode ? 'First run · create the admin account' : 'Sign in to your home server';
  setRecoveryMode(false);
  f.code.value = '';
  $('#code-msg').textContent = '';
  if (ticket) f.code.focus();
}

function setRecoveryMode(on) {
  recoveryMode = on;
  const input = $('#code-form').code;
  input.value = '';
  input.inputMode = on ? 'text' : 'numeric';
  input.autocomplete = on ? 'off' : 'one-time-code';
  input.maxLength = on ? 9 : 7;
  input.classList.toggle('recovery', on);
  $('#code-label').textContent = on ? 'Recovery code, like k7pm-x3qa' : '6-digit code from your authenticator app';
  $('#use-recovery').textContent = on ? 'Use the app code instead' : 'Use a recovery code';
}

async function submitCode() {
  const f = $('#code-form');
  if (!f.code.value.trim() || f.code.disabled) return;
  f.code.disabled = true;
  try {
    const { user } = await api('POST', '/api/login/code', { ticket: codeTicket, code: f.code.value, trust: f.trust.checked });
    $('#welcome-form').reset();
    showCodeStep(null);
    await enter(user);
  } catch (err) {
    if (err.status === 401) {
      // The wait ran out or there were too many tries: start again from the password.
      showCodeStep(null);
      $('#welcome-msg').textContent = err.message;
      $('#welcome-form').password.focus();
    } else {
      $('#code-msg').textContent = err.message;
      f.code.select();
    }
  } finally {
    f.code.disabled = false;
    if (codeTicket) f.code.focus();
  }
}

$('#code-form').addEventListener('submit', (e) => { e.preventDefault(); submitCode(); });

// Six digits in: sign in without needing to press the button.
$('#code-form').code.addEventListener('input', (e) => {
  if (!recoveryMode && e.target.value.replace(/\D/g, '').length === 6) submitCode();
});

$('#use-recovery').addEventListener('click', () => { setRecoveryMode(!recoveryMode); $('#code-form').code.focus(); });
$('#code-back').addEventListener('click', () => { showCodeStep(null); $('#welcome-form').password.focus(); });

// ---------- two-step setup ----------

// Draws the setup steps into a container: add Roost to an authenticator app,
// confirm one code, then save the recovery codes. Calls onDone(user) at the end.
async function twoStepSetup(container, onDone) {
  container.replaceChildren(el('p', { class: 'mono muted', text: 'Getting a code ready…' }));
  let setup;
  try {
    setup = await api('POST', '/api/me/two-step/start');
  } catch (err) {
    container.replaceChildren(el('div', { class: 'msg error', text: err.message }));
    return;
  }
  const qr = el('div', { class: 'qr-box' });
  qr.innerHTML = setup.qr; // drawn by Roost's own QR maker, no user text in it
  const key = setup.secret.match(/.{1,4}/g).join(' ');
  const copyMsg = el('span', { class: 'mono muted' });
  const code = el('input', {
    type: 'text', name: 'code', class: 'code-input', inputmode: 'numeric', autocomplete: 'one-time-code',
    maxlength: 7, required: true, 'aria-label': '6-digit code', spellcheck: 'false',
  });
  const msg = el('div', { class: 'msg error', role: 'alert' });
  const turnOn = async () => {
    if (code.disabled) return;
    code.disabled = true;
    try {
      const res = await api('POST', '/api/me/two-step/enable', { code: code.value });
      showRecoveryCodes(container, res.recoveryCodes, () => onDone(res.user));
    } catch (err) {
      msg.textContent = err.message;
      code.disabled = false;
      code.select();
    }
  };
  code.addEventListener('input', () => { if (code.value.replace(/\D/g, '').length === 6) turnOn(); });
  const form = el('form', { class: 'setup-confirm', onsubmit: (e) => { e.preventDefault(); turnOn(); } },
    el('label', { class: 'field' }, el('span', { text: '2 · Enter the 6-digit code it shows' }), code),
    el('button', { class: 'btn', type: 'submit', text: 'Turn on' }),
    msg);
  container.replaceChildren(el('div', { class: 'setup' },
    el('div', { class: 'field' }, el('span', { text: '1 · Add Roost to your authenticator app' })),
    el('p', { class: 'setup-hint', text: 'Any authenticator app works: Google or Microsoft Authenticator, 1Password, Bitwarden, or the passwords app on your phone.' }),
    el('div', { class: 'setup-add' },
      el('a', { class: 'btn ghost open-app', href: setup.uri, text: 'Open in authenticator app' }),
      qr,
      el('div', { class: 'setup-key' },
        el('span', { class: 'mono muted', text: 'Or type this key' }),
        el('code', { class: 'key', text: key }),
        el('div', { class: 'split' },
          el('button', { class: 'link-btn mono', type: 'button', text: 'Copy key', onclick: async () => { copyMsg.textContent = (await copyPlain(setup.secret)) ? 'Copied' : 'Select and copy it'; } }),
          copyMsg))),
    form));
}

function showRecoveryCodes(container, codes, onDone) {
  const text = `${state.serverName} recovery codes for ${state.user.username}\nEach code signs you in once if you lose your phone.\n\n${codes.join('\n')}\n`;
  const note = el('span', { class: 'mono muted' });
  const download = () => {
    const a = el('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })), download: `${state.serverName.toLowerCase()}-recovery-codes.txt` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  container.replaceChildren(el('div', { class: 'setup' },
    el('div', { class: 'field' }, el('span', { text: 'Save your recovery codes' })),
    el('p', { class: 'setup-hint', text: "If you lose your phone, each code signs you in once. Keep them somewhere safe that isn't your phone, like a password manager or a printout." }),
    el('ol', { class: 'recovery-codes mono' }, codes.map((c) => el('li', { text: c }))),
    el('div', { class: 'row', style: 'margin-top:0' },
      el('button', { class: 'btn ghost small', type: 'button', text: 'Copy', onclick: async () => { note.textContent = (await copyPlain(codes.join('\n'))) ? 'Copied' : ''; } }),
      el('button', { class: 'btn ghost small', type: 'button', text: 'Download', onclick: download }),
      note),
    el('button', { class: 'btn', type: 'button', text: "I've saved them", onclick: onDone })));
}

function needsSecureStep(u) {
  return (u.twoStep.required && !u.twoStep.on) || u.twoStep.offer;
}

function showSecure(user) {
  $('#welcome').classList.add('hidden');
  $('#join').classList.add('hidden');
  $('#shell').classList.add('hidden');
  $('#secure').classList.remove('hidden');
  const required = user.twoStep.required;
  $('#secure-lead').textContent = required
    ? 'Admins need a code from their phone as well as a password'
    : 'Add a code from your phone as well as your password. You can do this later in Profile.';
  $('#secure-later').classList.toggle('hidden', required);
  twoStepSetup($('#secure-setup'), (u) => enter(u));
}

$('#secure-later').addEventListener('click', async () => {
  try {
    const { user } = await api('POST', '/api/me/two-step/skip');
    await enter(user);
  } catch (err) {
    $('#secure-setup').prepend(el('div', { class: 'msg error', text: err.message }));
  }
});

$('#secure-logout').addEventListener('click', async () => {
  await api('POST', '/api/logout').catch(() => {});
  showWelcome(false);
});
function showForgot(show) {
  $('#welcome-form').classList.toggle('hidden', show);
  $('#forgot-form').classList.toggle('hidden', !show);
  $('#forgot-msg').textContent = '';
  $('#welcome-lead').textContent = show ? "We'll email you a link to choose a new password"
    : setupMode ? 'First run · create the admin account' : 'Sign in to your home server';
  if (show) {
    const f = $('#forgot-form');
    f.login.value = $('#welcome-form').username.value;
    f.login.focus();
  }
}

$('#forgot-open').addEventListener('click', () => showForgot(true));
$('#forgot-back').addEventListener('click', () => showForgot(false));

$('#forgot-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#forgot-msg');
  try {
    await api('POST', '/api/forgot', { login: e.target.login.value });
    msg.className = 'msg ok';
    msg.textContent = 'If that account has an email address, a reset link is on its way. It works for 1 hour.';
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = err.message;
  }
});

function setMailEnabled(on) {
  state.mailEnabled = on;
  document.querySelectorAll('.mail-only').forEach((n) => n.classList.toggle('hidden', !on));
  $('#forgot-open').classList.toggle('hidden', !on || setupMode);
}

// ---------- invite and reset links ----------

// Invite links look like https://roostos.network/j/K7PX-2QM9 (reset: /r/).
const LINK_RE = /^\/[jr]\/([A-Za-z0-9-]{8,9})\/?$/;

function linkToken() {
  const m = location.pathname.match(LINK_RE);
  return m ? m[1] : null;
}

// Links use the public address from Admin → Server when one is set, so a link
// made at home still opens from anywhere.
function linkUrl(kind, token) {
  return `${state.publicUrl || location.origin}/${kind === 'reset' ? 'r' : 'j'}/${token}`;
}

let joinToken = null;
let joinKind = null;

async function showJoin(token) {
  joinToken = token;
  $('#welcome').classList.add('hidden');
  $('#shell').classList.add('hidden');
  $('#join').classList.remove('hidden');
  $('#join-form').classList.add('hidden');
  $('#join-signin').classList.add('hidden');
  $('#join-msg').textContent = '';
  $('#join .hello').classList.remove('hidden');
  $('#join-lead').textContent = 'Checking your link…';
  let info;
  try {
    info = await api('GET', `/api/links/${token}`);
  } catch (err) {
    $('#join .hello').classList.add('hidden');
    $('#join-title').textContent = 'This link has stopped working';
    $('#join-lead').textContent = `${err.message}. Ask whoever sent it for a new one.`;
    $('#join-signin').classList.remove('hidden');
    return;
  }
  setServerName(info.serverName);
  joinKind = info.kind;
  const f = $('#join-form');
  f.reset();
  const invite = info.kind === 'invite';
  document.querySelectorAll('.join-invite').forEach((n) => n.classList.toggle('hidden', !invite));
  f.username.required = invite;
  if (invite) {
    $('#join-title').textContent = `Join ${info.serverName}`;
    const who = info.invitedBy ? `${info.invitedBy} invited you` : "You're invited";
    $('#join-lead').textContent = info.apps.length ? `${who} · ${info.apps.join(', ')}` : who;
    $('#join-submit').textContent = 'Create account';
    usernameHint('');
  } else {
    $('#join-title').textContent = 'Choose a new password';
    $('#join-lead').textContent = `For @${info.username}`;
    f.resetUsername.value = info.username;
    $('#join-submit').textContent = 'Save password';
  }
  f.classList.remove('hidden');
  (invite ? f.displayName : f.password).focus();
}

function usernameHint(text, bad = false) {
  const hint = $('#join-username-hint');
  hint.textContent = text || "Letters, numbers, . _ - · you can't change it later";
  hint.classList.toggle('bad', bad);
  hint.classList.toggle('good', !bad && Boolean(text));
}

// Check the username a moment after the person stops typing, not on every key.
let usernameTimer;
$('#join-form').username.addEventListener('input', (e) => {
  clearTimeout(usernameTimer);
  const name = e.target.value.trim().toLowerCase();
  if (!name) return usernameHint('');
  usernameTimer = setTimeout(async () => {
    try {
      const r = await api('GET', `/api/links/${joinToken}?username=${encodeURIComponent(name)}`);
      if (e.target.value.trim().toLowerCase() === name) usernameHint(r.available ? `@${name} is free` : r.reason, !r.available);
    } catch { /* the submit will say what's wrong */ }
  }, 350);
});

// Suggest a username from the name they type, until they edit it themselves.
$('#join-form').displayName.addEventListener('input', (e) => {
  const u = $('#join-form').username;
  if (u.dataset.touched) return;
  u.value = e.target.value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9._-]+/g, '').slice(0, 32);
  u.dispatchEvent(new Event('input'));
});
$('#join-form').username.addEventListener('keydown', (e) => { e.target.dataset.touched = '1'; });

document.querySelectorAll('.show-password').forEach((btn) => btn.addEventListener('click', () => {
  const input = btn.previousElementSibling;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.textContent = show ? 'Hide' : 'Show';
}));

$('#join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { password: f.password.value };
  if (joinKind === 'invite') Object.assign(body, { username: f.username.value, displayName: f.displayName.value, email: f.email.value });
  const button = $('#join-submit');
  button.disabled = true;
  try {
    const { user } = await api('POST', `/api/links/${joinToken}`, body);
    joinToken = null;
    $('#join').classList.add('hidden');
    history.replaceState(null, '', '/#/apps');
    await enter(user);
  } catch (err) {
    $('#join-msg').textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

$('#join-signin').addEventListener('click', (e) => {
  e.preventDefault();
  history.replaceState(null, '', '/');
  $('#join').classList.add('hidden');
  showWelcome(false);
});

// Copy works on plain http:// home addresses too, where the clipboard API is off.
async function copyText(input) {
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    input.select();
    document.execCommand('copy');
  }
}

// A link box with Copy, and Share where the browser has a share sheet.
function linkBox(url, note, shareText) {
  const input = el('input', { type: 'text', readonly: true, value: url, 'aria-label': 'Link', spellcheck: 'false' });
  const copy = el('button', { class: 'btn small', type: 'button', text: 'Copy link' });
  copy.addEventListener('click', async () => {
    await copyText(input);
    copy.textContent = 'Copied';
    setTimeout(() => { copy.textContent = 'Copy link'; }, 1600);
  });
  input.addEventListener('focus', () => input.select());
  const share = navigator.share
    ? el('button', { class: 'btn ghost small', type: 'button', text: 'Share', onclick: () => navigator.share({ title: state.serverName, text: shareText, url }).catch(() => {}) })
    : null;
  return el('div', { class: 'link-box' }, input, el('div', { class: 'row', style: 'margin:0' }, copy, share), el('div', { class: 'mono muted', text: note }));
}

function untilDate(iso) {
  return new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// ---------- shell ----------

async function enter(user) {
  state.user = user;
  if (needsSecureStep(user)) {
    showSecure(user);
    return;
  }
  $('#secure').classList.add('hidden');
  $('#welcome').classList.add('hidden');
  $('#join').classList.add('hidden');
  $('#shell').classList.remove('hidden');
  document.querySelectorAll('.admin-only').forEach((n) => n.classList.toggle('hidden', user.role !== 'admin'));
  renderUser();
  await Promise.all([loadApps(), loadSystem()]);
  loadBackup();
  route();
  if (user.role === 'admin' && !location.hash.startsWith('#/admin')) loadSetup();
}

function renderUser() {
  const u = state.user;
  const name = u.displayName || u.username;
  $('#avatar').textContent = name.charAt(0).toUpperCase();
  $('#who-name').textContent = name;
  $('#hero-name').textContent = name;
  $('#profile-role').textContent = u.role;
  $('#profile-form').displayName.value = u.displayName;
  $('#profile-form').username.value = u.username;
  $('#profile-form').email.value = u.email || '';
}

const VIEWS = ['apps', 'nest', 'status', 'profile', 'admin'];

const hasNest = () => state.apps.some((a) => a.id === 'nest' && a.url === '#/nest');

function route() {
  if (!state.user) return;
  const [first, ...rest] = location.hash.replace(/^#\/?/, '').split('/');
  let view = first || 'apps';
  if (!VIEWS.includes(view) || (view === 'admin' && state.user.role !== 'admin') || (view === 'nest' && !hasNest())) view = 'apps';
  for (const v of VIEWS) $(`#view-${v}`).classList.toggle('hidden', v !== view);
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  if (view === 'admin') loadAdmin();
  if (view === 'profile') { loadStorage(); loadTwoStep(); }
  if (view === 'status') loadStatus();
  if (view === 'nest') window.nestOpen(rest);
  else document.title = state.serverName;
}

window.addEventListener('hashchange', () => { if (state.user) route(); });

$('#logout').addEventListener('click', async () => {
  await api('POST', '/api/logout').catch(() => {});
  showWelcome(false);
});

// ---------- apps ----------

async function loadApps() {
  const { apps } = await api('GET', '/api/apps');
  state.apps = apps;
  $('.nav [data-view=nest]').classList.toggle('hidden', !hasNest());
  renderApps();
  api('GET', '/api/apps/status').then(({ status }) => { state.status = status; renderApps(); }).catch(() => {});
}

function renderApps() {
  const list = $('#apps');
  const total = state.apps.length;
  if (!total) {
    list.replaceChildren(el('div', { class: 'empty mono', text: 'No apps yet. Ask an admin to give you access.' }));
    return;
  }
  list.replaceChildren(...state.apps.map((app) => {
    const status = app.url ? state.status[app.id] || 'checking' : 'unset';
    const label = { online: 'Online', offline: 'Offline', checking: 'Checking', unset: 'Not set up' }[status];
    const isAdmin = state.user.role === 'admin';
    const children = [
      icon(app.icon),
      el('div', {}, el('div', { class: 'mono muted', text: app.tagline }), el('h3', { text: app.name })),
      el('p', { text: app.description }),
      el('div', { class: 'app-foot mono' },
        el('span', {}, el('span', { class: `dot ${status}` }), label),
        el('span', { text: app.url ? 'Open →' : isAdmin ? 'Add link' : '' })),
    ];
    // Apps built into Roost (like Nest) open in place; the rest in a new tab.
    const builtIn = app.url.startsWith('#/');
    return app.url
      ? el('a', builtIn ? { class: 'card app-card', href: app.url } : { class: 'card app-card', href: resolveUrl(app.url), target: '_blank', rel: 'noopener' }, children)
      : el('div', { class: 'card app-card disabled' }, children);
  }));
}

// ---------- system panel ----------

async function loadSystem() {
  try {
    const s = await api('GET', '/api/system');
    const used = s.memory.total - s.memory.free;
    $('#stat-uptime').textContent = duration(s.uptime);
    $('#stat-mem').textContent = `${bytes(used)} / ${bytes(s.memory.total)}`;
    $('#stat-load').textContent = s.load ? `${s.load[0].toFixed(2)} · ${s.cpus} cpu` : `${s.cpus} cpu`;
    $('#stat-disk').textContent = s.disk ? `${bytes(s.disk.free)} free` : '—';
    if (s.disk) state.diskGb = Math.floor(s.disk.total / 1024 ** 3);
    $('#foot-host').textContent = s.hostname;
  } catch {
    // The panel just keeps its dashes if stats aren't available.
  }
}

// ---------- backup line ----------

function backupWhen(iso) {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(iso).setHours(0, 0, 0, 0)) / 86400000);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `yesterday ${time}`;
  if (days < 7) return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

// One quiet line under the stats: when the last backup finished, or what is
// wrong. Hidden until backups are set up.
async function loadBackup() {
  const line = $('#backup-line');
  let b;
  try {
    b = await api('GET', '/api/backup');
  } catch {
    return;
  }
  const last = b.lastOk ? `Last backup ${backupWhen(b.lastOk)}` : 'No backup yet';
  const [dot, text] = {
    ok: ['online', last],
    late: ['warn', last],
    none: ['', 'First backup on its way'],
    running: ['', b.lastOk ? `Backing up now · ${last.toLowerCase()}` : 'First backup running'],
    failed: ['offline', `Last backup failed · ${b.lastOk ? backupWhen(b.lastOk) : 'none yet'}`],
    drive: ['offline', 'Backup drive not found'],
    stopped: ['offline', 'Backups aren’t running'],
  }[b.state] || [];
  line.classList.toggle('hidden', !text);
  if (!text) return;
  line.replaceChildren(el('span', { class: `dot ${dot}` }), text);
  // Admins can tap through to the setup checklist, where the backup steps are.
  if (state.user.role === 'admin') line.href = '#/admin';
  else line.removeAttribute('href');
  line.title = b.message || '';
}

// ---------- status page ----------

const STATUS_REFRESH_MS = 5 * 1000;
const FULL_AT = 90;
let statusBusy = false;

function pct(used, total) {
  return total ? Math.round((used / total) * 100) : 0;
}

function meter(percent) {
  return el('div', { class: `meter${percent >= FULL_AT ? ' high' : ''}`, role: 'meter', 'aria-valuenow': percent, 'aria-valuemin': 0, 'aria-valuemax': 100 },
    el('i', { style: `width:${Math.min(100, percent)}%` }));
}

function statCard(label, value, sub, bar) {
  return el('div', { class: 'card stat-card' },
    el('div', { class: 'mono muted', text: label }),
    el('div', { class: 'stat-value', text: value }),
    bar === undefined ? null : meter(bar),
    el('div', { class: 'mono muted stat-sub', text: sub }));
}

function ago(iso) {
  return duration(Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000));
}

// Docker state → a dot colour and a short label.
function containerState(c) {
  if (c.state === 'running') {
    if (c.health === 'unhealthy') return { kind: 'offline', label: 'Unhealthy', rank: 3 };
    if (c.health === 'starting') return { kind: 'starting', label: 'Starting', rank: 1 };
    return { kind: 'online', label: c.health === 'healthy' ? 'Running · healthy' : 'Running', rank: 0 };
  }
  if (c.state === 'restarting') return { kind: 'offline', label: 'Restarting', rank: 4 };
  if (c.state === 'paused') return { kind: 'starting', label: 'Paused', rank: 2 };
  return { kind: 'offline', label: 'Stopped', rank: 5 };
}

function containerSince(c) {
  const exit = c.exitCode ? ` (exit ${c.exitCode})` : '';
  if (c.startedAt) return `up ${ago(c.startedAt)}`;
  if (c.state === 'restarting') return `crashing${exit}`;
  if (c.finishedAt) return `stopped ${ago(c.finishedAt)} ago${exit}`;
  return c.state;
}

function worstContainer(list) {
  return list.slice().sort((x, y) => containerState(y).rank - containerState(x).rank)[0];
}

const WEB_LABEL = { online: 'Online', offline: 'Offline', unset: 'Not set up' };

// An app's state comes from its containers when Docker can see them,
// otherwise from the web check.
function appState(a, dockerOk) {
  if (a.containers.length) return containerState(worstContainer(a.containers));
  if (dockerOk && a.web.state !== 'online') return { kind: a.web.state === 'unset' ? 'unset' : 'offline', label: 'No container' };
  return { kind: a.web.state, label: WEB_LABEL[a.web.state] };
}

function appStatusCard(a, dockerOk) {
  const st = appState(a, dockerOk);
  const lines = [];
  if (a.containers.length) {
    const c = worstContainer(a.containers);
    lines.push(containerSince(c) + (c.restarts ? ` · ${c.restarts} restart${c.restarts > 1 ? 's' : ''}` : ''));
    lines.push(a.containers.map((x) => x.name).join(', '));
  } else if (a.id === 'roost') {
    lines.push(`up ${duration(a.uptime)}`);
  }
  if (a.id !== 'roost') {
    lines.push(a.web.state === 'online' ? `Web online · ${a.web.ms} ms` : a.web.state === 'offline' ? 'Web offline' : 'No link set');
  }
  lines.push(a.containers.length ? 'Source: Docker' : 'Source: web check');
  return el('div', { class: `card stat-card app-status ${st.kind}` },
    el('div', { class: 'app-status-head' }, icon(a.icon), el('div', { class: 'mono muted', text: a.tagline })),
    el('div', { class: 'stat-value', text: a.name }),
    el('div', { class: 'mono stat-state' }, el('span', { class: `dot ${st.kind}` }), st.label),
    el('div', { class: 'stat-lines mono muted' }, lines.map((t) => el('div', { text: t }))));
}

async function loadStatus() {
  if (statusBusy) return;
  statusBusy = true;
  try {
    renderStatus(await api('GET', '/api/status'));
  } catch {
    $('#status-updated').textContent = 'Roost is not answering';
    setSummary('offline', "Can't reach the server right now");
  } finally {
    statusBusy = false;
  }
}

function setSummary(kind, text) {
  $('#status-summary').replaceChildren(el('span', { class: `dot ${kind}` }), el('span', { text }));
}

function renderStatus(s) {
  const memUsed = s.memory.total - s.memory.available;
  const memPct = pct(memUsed, s.memory.total);
  $('#status-server').replaceChildren(
    statCard('Uptime', duration(s.uptime), `Roost up ${duration(s.roostUptime)}`),
    statCard('CPU', `${Math.round(s.cpu.percent)}%`, `${s.cpu.load ? `Load ${s.cpu.load[0].toFixed(2)} · ` : ''}${s.cpu.cores} cores`, s.cpu.percent),
    statCard('Memory', bytes(memUsed), `${memPct}% of ${bytes(s.memory.total)}`, memPct),
    statCard('Host', s.hostname, s.platform),
  );

  $('#status-disks').replaceChildren(...s.disks.map((d) => {
    if (d.missing) return statCard(d.label, 'Not found', d.path);
    const used = d.total - d.free;
    return statCard(d.label, `${bytes(d.free)} free`, `${bytes(used)} of ${bytes(d.total)} used`, pct(used, d.total));
  }));

  $('#status-apps').replaceChildren(...s.apps.map((a) => appStatusCard(a, s.docker.ok)));

  const note = $('#status-note');
  note.classList.toggle('hidden', s.docker.ok);
  note.textContent = s.docker.ok ? '' : "Docker isn't connected, so apps show a web check only (does the app answer on its link).";

  $('#status-others-wrap').classList.toggle('hidden', !s.otherContainers.length);
  $('#status-others').replaceChildren(...s.otherContainers.map((c) => {
    const st = containerState(c);
    return el('div', { class: 'container-row' },
      el('span', { class: 'mono' }, el('span', { class: `dot ${st.kind}` }), c.name),
      el('span', { class: 'mono muted', text: `${st.label} · ${containerSince(c)}` }));
  }));

  const problems = [
    ...s.apps.map((a) => [a, appState(a, s.docker.ok)]).filter(([, st]) => st.kind === 'offline').map(([a, st]) => `${a.name}: ${st.label.toLowerCase()}`),
    ...s.disks.filter((d) => !d.missing && pct(d.total - d.free, d.total) >= FULL_AT).map((d) => `${d.label} drive is nearly full`),
    ...s.disks.filter((d) => d.missing).map((d) => `${d.label} drive not found`),
    ...(memPct >= FULL_AT ? ['Memory is nearly full'] : []),
  ];
  setSummary(problems.length ? 'offline' : 'online', problems.length ? problems.join(' · ') : 'Everything is running');
  $('#status-updated').textContent = `Updated ${new Date(s.checkedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
}

function tickClock() {
  const now = new Date();
  $('#clock').textContent = now.toLocaleString(undefined, { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  const h = now.getHours();
  $('#greeting').textContent = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

// ---------- profile ----------

$('#profile-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const { user } = await api('PATCH', '/api/me', { displayName: e.target.displayName.value, email: e.target.email.value });
    state.user = user;
    renderUser();
    flash(e.target, 'Saved');
  } catch (err) { flash(e.target, err.message, false); }
});

$('#password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('PATCH', '/api/me', { currentPassword: f.currentPassword.value, newPassword: f.newPassword.value });
    f.reset();
    flash(f, 'Password changed');
  } catch (err) { flash(f, err.message, false); }
});

// ---------- two-step in profile ----------

async function loadTwoStep() {
  const t = await api('GET', '/api/me/two-step');
  const on = t.on;
  $('#two-step-dot').className = `dot ${on ? 'online' : t.required ? 'offline' : ''}`;
  $('#two-step-text').textContent = on
    ? `On since ${shortDate(t.since)} · ${t.recoveryLeft} recovery code${t.recoveryLeft === 1 ? '' : 's'} left`
    : 'Off';
  $('#two-step-off').classList.toggle('hidden', on);
  $('#two-step-on').classList.toggle('hidden', !on);
  $('#two-step-setup-here').replaceChildren();
  // Admins who must keep it on move it to a new phone instead of turning it off.
  $('#two-step-off-btn').textContent = t.required ? 'Move to a new phone' : 'Turn off';
  $('#two-step-devices').replaceChildren(...[
    el('span', { class: 'mono muted', text: `${t.trustedDevices} trusted device${t.trustedDevices === 1 ? '' : 's'}` }),
    t.trustedDevices ? el('button', { class: 'link-btn mono', type: 'button', text: 'Forget them', onclick: forgetDevices }) : null,
  ].filter(Boolean));
}

async function forgetDevices() {
  try {
    await api('POST', '/api/me/two-step/forget-devices');
    await loadTwoStep();
    flash($('#two-step-on'), 'Every device will be asked for a code next time');
  } catch (err) { flash($('#two-step-on'), err.message, false); }
}

$('#two-step-begin').addEventListener('click', () => {
  $('#two-step-off').classList.add('hidden');
  twoStepSetup($('#two-step-setup-here'), (user) => { state.user = user; loadTwoStep(); });
});

$('#two-step-on').addEventListener('click', async (e) => {
  const act = e.target.dataset && e.target.dataset.act;
  if (!act) return;
  const f = $('#two-step-on');
  if (!f.password.value) {
    flash(f, 'Type your password first', false);
    f.password.focus();
    return;
  }
  try {
    if (act === 'codes') {
      const res = await api('POST', '/api/me/two-step/recovery-codes', { password: f.password.value });
      f.reset();
      flash(f, '');
      f.classList.add('hidden');
      showRecoveryCodes($('#two-step-setup-here'), res.recoveryCodes, () => { state.user = res.user; loadTwoStep(); });
    } else {
      const moving = state.user.twoStep.required;
      if (!moving && !confirm('Turn off two-step sign-in? Your password alone will sign you in.')) return;
      const { user } = await api('POST', '/api/me/two-step/disable', { password: f.password.value });
      f.reset();
      flash(f, '');
      state.user = user;
      await loadTwoStep();
      if (moving) {
        $('#two-step-off').classList.add('hidden');
        twoStepSetup($('#two-step-setup-here'), (u) => { state.user = u; loadTwoStep(); });
      }
    }
  } catch (err) { flash(f, err.message, false); }
});
$('#two-step-on').addEventListener('submit', (e) => e.preventDefault());

// ---------- storage ----------

const REQUEST_LABEL = { pending: 'Waiting for an admin', approved: 'Approved', declined: 'Declined' };

async function loadStorage() {
  const { storage, requests } = await api('GET', '/api/me/storage');
  const isAdmin = state.user.role === 'admin';
  const pct = storage.limitBytes ? Math.min(100, (storage.usedBytes / storage.limitBytes) * 100) : 0;
  $('#storage-fill').style.width = `${pct}%`;
  $('#storage-fill').classList.toggle('full', pct >= 90);
  $('#storage-used').textContent = `${bytes(storage.usedBytes)} used`;
  $('#storage-limit').textContent = storage.limitGb === null ? 'No limit' : `of ${storage.limitGb} GB`;
  const pending = requests.some((r) => r.status === 'pending');
  $('#storage-request-form').classList.toggle('hidden', isAdmin || pending);
  $('#storage-admin-note').classList.toggle('hidden', !isAdmin);
  if (storage.limitGb !== null) pickers.request.setValue(storage.limitGb * 2, storage.limitGb + 1);
  $('#storage-requests').replaceChildren(...requests.map((r) => el('div', { class: 'request-row' },
    el('div', {},
      el('div', { text: `Asked for ${r.requestedGb} GB` }),
      el('div', { class: 'mono muted', text: [shortDate(r.createdAt), r.note].filter(Boolean).join(' · ') })),
    el('div', { class: 'request-status' },
      el('span', { class: `pill ${r.status}`, text: REQUEST_LABEL[r.status] }),
      r.status === 'approved' ? el('span', { class: 'mono muted', text: `Now ${r.approvedGb} GB` }) : null,
      r.reply ? el('span', { class: 'mono muted', text: r.reply }) : null))));
}

$('#storage-request-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('POST', '/api/me/storage-requests', { requestedGb: pickers.request.getValue(), note: f.note.value });
    f.reset();
    flash(f, '');
    loadStorage();
  } catch (err) { flash(f, err.message, false); }
});

function renderStorageRequests(requests) {
  const list = $('#storage-requests-admin');
  if (!requests.length) {
    list.replaceChildren(el('div', { class: 'mono muted', text: 'Nothing waiting' }));
    return;
  }
  list.replaceChildren(...requests.map((r) => {
    const name = r.user ? r.user.displayName : 'Removed user';
    const amount = gbPicker({ label: `New limit for ${name}` });
    amount.setValue(r.requestedGb);
    const msg = el('div', { class: 'msg' });
    const decide = async (action) => {
      try {
        await api('POST', `/api/admin/storage-requests/${r.id}`, action === 'approve' ? { action, limitGb: amount.getValue() } : { action });
        loadAdmin();
      } catch (err) { msg.className = 'msg error'; msg.textContent = err.message; }
    };
    return el('div', { class: 'request-row' },
      el('div', { class: 'who' },
        el('span', { class: 'avatar', text: name.charAt(0).toUpperCase() }),
        el('div', {},
          el('div', { text: `${name} asks for ${r.requestedGb} GB` }),
          el('div', { class: 'mono muted', text: `Has ${gb(r.currentGb)} · uses ${r.storage ? bytes(r.storage.usedBytes) : '—'} · ${shortDate(r.createdAt)}` }),
          r.note ? el('div', { class: 'request-note', text: `“${r.note}”` }) : null)),
      el('div', { class: 'row', style: 'margin:0' },
        amount,
        el('button', { class: 'btn small', type: 'button', text: 'Approve', onclick: () => decide('approve') }),
        el('button', { class: 'btn danger small', type: 'button', text: 'Decline', onclick: () => decide('decline') })),
      msg);
  }));
}

// ---------- admin ----------

// ---------- setup checklist ----------

const setupState = { steps: [], current: null, open: null };

async function loadSetup() {
  try {
    const data = await api('GET', '/api/admin/setup');
    setupState.steps = data.steps;
    renderSetup(data);
  } catch { /* the panel keeps its last state */ }
}

function renderSetup({ steps, done, total }) {
  const complete = done === total;
  const nudge = $('#setup-nudge');
  nudge.classList.toggle('hidden', complete);
  nudge.textContent = `Setup · ${done} of ${total} done · Continue →`;
  $('#setup-count').textContent = complete ? `All ${total} steps done` : `${done} of ${total} done`;
  $('#setup-fill').style.width = `${Math.round((done / total) * 100)}%`;
  // Once everything is done the panel folds away until asked for.
  if (setupState.open === null) setupState.open = !complete;
  $('#setup-toggle').classList.toggle('hidden', !complete);
  $('#setup-toggle').textContent = setupState.open ? 'Hide steps' : 'Show steps';
  $('#setup-body').classList.toggle('hidden', !setupState.open);
  if (!steps.some((st) => st.id === setupState.current)) setupState.current = null;
  if (!setupState.current) setupState.current = (steps.find((st) => !st.done && !st.optional) || steps.find((st) => !st.done) || steps[0]).id;

  let group = null;
  $('#setup-list').replaceChildren(...steps.flatMap((st) => {
    const items = [];
    if (st.group !== group) {
      group = st.group;
      items.push(el('li', { class: 'setup-group mono muted', text: group }));
    }
    items.push(el('li', {},
      el('button', {
        type: 'button',
        class: `setup-row${st.id === setupState.current ? ' current' : ''}`,
        'aria-current': st.id === setupState.current ? 'step' : false,
        onclick: () => { setupState.current = st.id; renderSetup({ steps, done, total }); },
      },
      el('span', { class: `setup-tick${st.done ? ' done' : ''}`, 'aria-label': st.done ? 'Done' : 'Not done' }, st.done ? '✓' : ''),
      el('span', { class: 'setup-title', text: st.title }),
      st.optional ? el('span', { class: 'mono muted', text: 'Optional' }) : null)));
    return items;
  }));

  const st = steps.find((x) => x.id === setupState.current);
  const i = steps.indexOf(st);
  const go = (to) => { setupState.current = steps[to].id; renderSetup({ steps, done, total }); };
  const action = st.action ? el('button', { class: 'btn small', type: 'button', text: st.action.label, onclick: () => openSetupAction(st.action) }) : null;
  const tick = st.manual ? el('button', {
    class: `btn ${st.done ? 'ghost ' : ''}small`, type: 'button', text: st.done ? 'Mark not done' : 'Mark done',
    onclick: async () => { await api('POST', `/api/admin/setup/${st.id}`, { done: !st.done }); loadSetup(); },
  }) : null;
  $('#setup-step').replaceChildren(
    el('div', { class: 'mono muted', text: `${st.group} · step ${i + 1} of ${steps.length}${st.done ? ' · done' : ''}` }),
    el('h4', { text: st.title }),
    el('p', { class: 'setup-why', text: st.why }),
    el('ol', { class: 'setup-how' }, st.how.map((h) => el('li', { text: h }))),
    el('div', { class: 'row', style: 'margin-top:16px' },
      action, tick,
      st.manual ? null : el('button', { class: 'btn ghost small', type: 'button', text: 'Check again', onclick: loadSetup }),
      el('span', { class: 'setup-nav' },
        el('button', { class: 'link-btn mono', type: 'button', text: '← Back', disabled: i === 0, onclick: () => go(i - 1) }),
        el('button', { class: 'link-btn mono', type: 'button', text: 'Next →', disabled: i === steps.length - 1, onclick: () => go(i + 1) }))));
}

// Jumps to the form a step is done in and puts the cursor in it.
function openSetupAction({ view, focus, field }) {
  const target = `#/${view}`;
  const jump = () => {
    const form = focus && document.getElementById(focus);
    if (!form) return;
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const input = (field && form.elements[field]) || form.querySelector('input:not([type=hidden]):not([disabled]), select, textarea');
    if (input) input.focus({ preventScroll: true });
  };
  if (location.hash === target) jump();
  else {
    location.hash = target;
    setTimeout(jump, 150);
  }
}

$('#setup-toggle').addEventListener('click', () => {
  setupState.open = !setupState.open;
  $('#setup-body').classList.toggle('hidden', !setupState.open);
  $('#setup-toggle').textContent = setupState.open ? 'Hide steps' : 'Show steps';
});

async function loadAdmin() {
  loadSetup();
  const [{ users }, { apps }, { requests, defaultLimitGb }, { invites, publicUrl }, { settings }] = await Promise.all([
    api('GET', '/api/admin/users'), api('GET', '/api/apps'), api('GET', '/api/admin/storage-requests'), api('GET', '/api/admin/invites'),
    api('GET', '/api/admin/settings')]);
  $('#settings-form').adminsNeedTwoStep.checked = settings.adminsNeedTwoStep;
  renderMailSettings(settings);
  state.users = users;
  state.apps = apps;
  state.defaultLimitGb = defaultLimitGb;
  state.publicUrl = publicUrl;
  $('#settings-form').serverName.value = state.serverName;
  $('#settings-form').publicUrl.value = publicUrl;
  pickers.default.setValue(defaultLimitGb);
  pickers.newUser.setValue(defaultLimitGb);
  renderStorageRequests(requests);
  loadActivity();
  renderAppsEditor();
  renderUsers();
  renderInvites(invites);
  $('#new-user-apps').replaceChildren(...appChecks(null));
}

function appChecks(selected) {
  return state.apps.map((a) => el('label', {},
    el('input', { type: 'checkbox', value: a.id, checked: selected === null || selected.includes(a.id) }), a.name));
}

function checkedApps(container) {
  return [...container.querySelectorAll('input[type=checkbox]:checked')].map((c) => c.value);
}

function appEditorRow(app) {
  const iconSelect = el('select', { name: 'icon' }, Object.keys(ICONS).map((k) => el('option', { value: k, text: k, selected: k === app.icon })));
  const row = el('div', { class: 'admin-app', 'data-id': app.id || '' },
    el('div', { class: 'form-grid' },
      el('label', { class: 'field' }, el('span', { text: 'Name' }), el('input', { type: 'text', name: 'name', value: app.name || '', maxlength: 40, required: true })),
      el('label', { class: 'field' }, el('span', { text: 'Tagline' }), el('input', { type: 'text', name: 'tagline', value: app.tagline || '', maxlength: 40 })),
      el('label', { class: 'field' }, el('span', { text: 'Link' }), el('input', { type: 'text', name: 'url', value: app.url || '', placeholder: 'http://{host}:8096', spellcheck: 'false' })),
      el('label', { class: 'field' }, el('span', { text: 'Icon' }), iconSelect),
      el('label', { class: 'field' }, el('span', { text: 'Container' }), el('input', { type: 'text', name: 'container', value: app.container || '', placeholder: 'Found by name if empty', spellcheck: 'false' })),
    ),
    el('div', { class: 'row' },
      el('label', { class: 'field', style: 'flex:1' }, el('span', { text: 'Description' }), el('input', { type: 'text', name: 'description', value: app.description || '', maxlength: 200 })),
      el('button', { class: 'btn danger small', type: 'button', text: 'Remove', onclick: () => row.remove() })),
  );
  return row;
}

function renderAppsEditor() {
  $('#apps-editor').replaceChildren(...state.apps.map(appEditorRow));
}

$('#add-app').addEventListener('click', () => {
  $('#apps-editor').append(appEditorRow({ icon: 'grid' }));
});

$('#apps-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const apps = [...document.querySelectorAll('#apps-editor .admin-app')].map((row) => {
    const get = (n) => $(`[name=${n}]`, row).value;
    const app = { name: get('name'), tagline: get('tagline'), url: get('url'), icon: get('icon'), description: get('description'), container: get('container') };
    if (row.dataset.id) app.id = row.dataset.id;
    return app;
  });
  try {
    ({ apps: state.apps } = await api('PUT', '/api/admin/apps', { apps }));
    flash(e.target, 'Apps saved');
    renderAppsEditor();
    renderUsers();
    $('#new-user-apps').replaceChildren(...appChecks(null));
    loadApps();
  } catch (err) { flash(e.target, err.message, false); }
});

function renderUsers() {
  $('#users').replaceChildren(...state.users.map((u) => {
    const isMe = u.id === state.user.id;
    const checks = el('div', { class: 'checks' }, appChecks(u.apps));
    const limit = gbPicker({ label: `Storage limit for ${u.displayName}`, allowNone: true });
    limit.setValue(u.storage.limitGb);
    const msg = el('div', { class: 'msg' });
    const save = async () => {
      const body = { limitGb: limit.getValue() };
      if (u.role !== 'admin') body.apps = checkedApps(checks);
      try {
        await api('PATCH', `/api/admin/users/${u.id}`, body);
        msg.className = 'msg ok'; msg.textContent = 'Saved';
      } catch (err) { msg.className = 'msg error'; msg.textContent = err.message; }
    };
    const resetTwoStep = async () => {
      if (!confirm(`Reset two-step sign-in for ${u.displayName}? Their password alone will sign them in until they set it up again.`)) return;
      try {
        await api('PATCH', `/api/admin/users/${u.id}`, { resetTwoStep: true });
        loadAdmin();
      } catch (err) { msg.className = 'msg error'; msg.textContent = err.message; }
    };
    const resetSpot = el('div', { class: 'reset-spot' });
    const resetLink = async (email) => {
      try {
        const r = await api('POST', `/api/admin/users/${u.id}/reset-link`, { email });
        const note = r.emailedTo ? `Emailed to ${r.emailedTo} · ` : r.mailError ? `Not emailed: ${r.mailError} · ` : '';
        resetSpot.replaceChildren(linkBox(linkUrl('reset', r.token), `${note}Works once · until ${untilDate(r.expiresAt)} · makes any older reset link stop working`,
          `Set a new password for ${state.serverName}`));
      } catch (err) { msg.className = 'msg error'; msg.textContent = err.message; }
    };
    const remove = async () => {
      if (!confirm(`Remove ${u.displayName}? They will no longer be able to sign in.`)) return;
      try {
        await api('DELETE', `/api/admin/users/${u.id}`);
        loadAdmin();
      } catch (err) { msg.className = 'msg error'; msg.textContent = err.message; }
    };
    return el('div', { class: 'user-row' },
      el('div', { class: 'who' },
        el('span', { class: 'avatar', text: (u.displayName || u.username).charAt(0).toUpperCase() }),
        el('div', {}, el('div', { text: u.displayName }), el('div', { class: 'mono muted', text: [`@${u.username}`, u.email].filter(Boolean).join(' · ') })),
        el('span', { class: 'pill', text: u.role }),
        u.twoStep.on ? el('span', { class: 'pill approved', text: 'Two-step' }) : null),
      u.role === 'admin' ? el('span', { class: 'mono muted', text: 'Sees every app' }) : checks,
      el('div', { class: 'row user-storage' },
        el('span', { class: 'mono muted', text: `Storage · ${bytes(u.storage.usedBytes)} used` }),
        limit,
        el('button', { class: 'btn ghost small', type: 'button', text: 'Save', onclick: save })),
      isMe ? null : el('div', { class: 'row', style: 'margin:0' },
        u.twoStep.on ? el('button', { class: 'btn ghost small', type: 'button', text: 'Reset two-step', onclick: resetTwoStep }) : null,
        el('button', { class: 'btn ghost small', type: 'button', text: 'Password reset link', onclick: () => resetLink(false) }),
        u.email && state.mailEnabled ? el('button', { class: 'btn ghost small', type: 'button', text: 'Email reset link', onclick: () => resetLink(true) }) : null,
        el('button', { class: 'btn danger small', type: 'button', text: 'Remove', onclick: remove })),
      resetSpot,
      msg);
  }));
}

function renderInvites(invites) {
  const list = $('#invites');
  if (!invites.length) return list.replaceChildren();
  list.replaceChildren(el('div', { class: 'mono muted invites-head', text: 'Waiting to be used' }), ...invites.map((inv) => {
    const cancel = async () => {
      try {
        await api('DELETE', `/api/admin/invites/${inv.id}`);
        loadAdmin();
      } catch (err) { flash($('#invite-form'), err.message, false); }
    };
    return el('div', { class: 'request-row' },
      el('div', {},
        el('div', { text: inv.label || 'Invite' }),
        el('div', { class: 'mono muted', text: `${inv.role} · made ${shortDate(inv.createdAt)} · until ${untilDate(inv.expiresAt)}` })),
      el('button', { class: 'btn danger small', type: 'button', text: 'Cancel', onclick: cancel }));
  }));
}

$('#invite-form').role.addEventListener('change', (e) => {
  $('#invite-apps-row').classList.toggle('hidden', e.target.value === 'admin');
});

$('#invite-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    const { invite, token, emailedTo, mailError } = await api('POST', '/api/admin/invites', {
      label: f.label.value,
      email: state.mailEnabled ? f.email.value : '',
      role: f.role.value,
      apps: checkedApps($('#new-user-apps')),
      limitGb: pickers.newUser.getValue(),
    });
    f.reset();
    $('#invite-apps-row').classList.remove('hidden');
    flash(f, '');
    await loadAdmin();
    $('#invite-result').replaceChildren(linkBox(linkUrl('join', token),
      `${emailedTo ? `Emailed to ${emailedTo} · ` : mailError ? `Not emailed: ${mailError} · ` : ''}Works once · until ${untilDate(invite.expiresAt)} · the link is only shown now`,
      `You're invited to ${state.serverName}`));
  } catch (err) { flash(f, err.message, false); }
});

function renderMailSettings(settings) {
  const f = $('#mail-form');
  const m = settings.mail;
  f.host.value = m.host;
  f.port.value = m.host ? m.port : '';
  f.security.value = m.security;
  f.user.value = m.user;
  f.password.value = '';
  f.password.placeholder = m.hasPassword ? 'Saved · type to change' : '';
  f.from.value = m.from;
  $('#mail-needs-url').classList.toggle('hidden', !m.host || Boolean(settings.publicUrl));
  setMailEnabled(settings.mailEnabled);
}

// Picking a security type fills in its usual port.
$('#mail-form').security.addEventListener('change', (e) => {
  const port = { starttls: 587, tls: 465, none: 25 }[e.target.value];
  e.target.form.port.value = port;
});

async function saveMail(f) {
  const { settings } = await api('PATCH', '/api/admin/settings', {
    mail: {
      host: f.host.value,
      port: Number(f.port.value) || ({ starttls: 587, tls: 465, none: 25 }[f.security.value]),
      security: f.security.value,
      user: f.user.value,
      password: f.password.value,
      from: f.from.value,
    },
  });
  renderMailSettings(settings);
  renderUsers();
}

$('#mail-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await saveMail(e.target);
    flash(e.target, e.target.host.value ? 'Saved' : 'Email turned off');
  } catch (err) { flash(e.target, err.message, false); }
});

$('#mail-test').addEventListener('click', async () => {
  const f = $('#mail-form');
  flash(f, 'Sending…');
  try {
    await saveMail(f);
    const { to } = await api('POST', '/api/admin/mail-test', {});
    flash(f, `Sent to ${to}. Check that inbox (and spam).`);
    loadSetup();
  } catch (err) { flash(f, err.message, false); }
});

$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const { settings } = await api('PATCH', '/api/admin/settings', {
      serverName: e.target.serverName.value,
      defaultLimitGb: pickers.default.getValue(),
      adminsNeedTwoStep: e.target.adminsNeedTwoStep.checked,
      publicUrl: e.target.publicUrl.value,
    });
    setServerName(settings.serverName);
    state.publicUrl = settings.publicUrl || '';
    e.target.publicUrl.value = state.publicUrl;
    renderMailSettings(settings);
    flash(e.target, 'Saved');
  } catch (err) { flash(e.target, err.message, false); }
});

// ---------- activity log ----------

const ACTIVITY_LABELS = {
  'sign-in': 'Signed in',
  'sign-out': 'Signed out',
  setup: 'Set up Roost',
  'sign-in-failed': 'Failed sign-in',
  'password-changed': 'Changed password',
  'user-added': 'Added user',
  'user-changed': 'Changed user',
  'user-removed': 'Removed user',
  'user-joined': 'Joined with an invite',
  'invite-created': 'Made an invite link',
  'invite-removed': 'Cancelled an invite link',
  'reset-link-created': 'Made a password reset link',
  'password-reset': 'Reset password',
  'storage-requested': 'Asked for storage',
  'storage-approved': 'Approved storage',
  'storage-declined': 'Declined storage',
  'apps-changed': 'Changed apps',
  'settings-changed': 'Changed server settings',
};

const activity = { filter: '', last: null };

function ago(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function activityRow(e) {
  const exact = new Date(e.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const time = el('button', { type: 'button', class: 'activity-time mono muted', title: exact, text: ago(e.at) });
  time.addEventListener('click', () => { time.textContent = time.textContent === exact ? ago(e.at) : exact; });
  // "raven → mia" when an admin acted on someone else; just the name otherwise.
  const who = e.actor && e.target && e.actor !== e.target ? `${e.actor} → ${e.target}` : e.actor || e.target || 'unknown';
  return el('li', { class: `activity-row${e.kind === 'failed' ? ' failed' : ''}` },
    el('div', { class: 'activity-main' },
      el('div', {}, el('span', { class: 'activity-what', text: ACTIVITY_LABELS[e.type] || e.type }), el('span', { class: 'activity-who', text: ` · ${who}` })),
      el('div', { class: 'activity-detail mono muted', text: [e.detail, e.ip].filter(Boolean).join(' · ') })),
    time);
}

async function loadActivity(more = false) {
  const list = $('#activity');
  const params = new URLSearchParams();
  if (activity.filter) params.set('filter', activity.filter);
  if (more && activity.last) params.set('before', activity.last);
  try {
    const { entries, more: hasMore } = await api('GET', `/api/admin/activity?${params}`);
    const rows = entries.map(activityRow);
    if (more) list.append(...rows);
    else list.replaceChildren(...(rows.length ? rows : [el('li', { class: 'empty mono', text: 'Nothing here yet' })]));
    activity.last = entries.length ? entries[entries.length - 1].seq : activity.last;
    $('#activity-more-row').classList.toggle('hidden', !hasMore);
    $('#activity-panel > .msg').textContent = '';
  } catch (err) { flash($('#activity-panel'), err.message, false); }
}

$('#activity-filters').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  activity.filter = chip.dataset.filter;
  activity.last = null;
  for (const c of $('#activity-filters').children) c.setAttribute('aria-pressed', String(c === chip));
  loadActivity();
});

$('#activity-more').addEventListener('click', () => loadActivity(true));

// ---------- boot ----------

(async function boot() {
  tickClock();
  setInterval(tickClock, 30 * 1000);
  setInterval(() => { if (state.user && !$('#view-apps').classList.contains('hidden')) loadSystem(); }, 15 * 1000);
  // The status page refreshes itself while it is open and the tab is visible.
  setInterval(() => {
    if (state.user && !document.hidden && !$('#view-status').classList.contains('hidden')) loadStatus();
  }, STATUS_REFRESH_MS);
  const token = linkToken();
  if (token) return showJoin(token);
  const s = await api('GET', '/api/state');
  setServerName(s.serverName);
  state.mailEnabled = s.mailEnabled;
  if (s.user) await enter(s.user);
  else showWelcome(s.setupRequired);
})();
