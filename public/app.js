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

const state = { serverName: 'Roost', user: null, apps: [], status: {}, users: [], defaultLimitGb: null, diskGb: null };

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
  if (res.status === 401 && url !== '/api/login') {
    showWelcome(false);
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function flash(form, text, ok = true) {
  const msg = $('.msg', form);
  msg.textContent = text;
  msg.className = `msg ${ok ? 'ok' : 'error'}`;
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
  $('#welcome').classList.remove('hidden');
  $('#display-name-field').classList.toggle('hidden', !setup);
  $('#welcome-lead').textContent = setup ? 'First run · create the admin account' : 'Sign in to your home server';
  $('#welcome-form [name=password]').autocomplete = setup ? 'new-password' : 'current-password';
  $('#welcome-submit').textContent = setup ? 'Create account' : 'Continue';
}

$('#welcome-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { username: f.username.value, password: f.password.value };
  if (setupMode) body.displayName = f.displayName.value;
  try {
    const { user } = await api('POST', setupMode ? '/api/setup' : '/api/login', body);
    f.reset();
    $('#welcome-msg').textContent = '';
    await enter(user);
  } catch (err) {
    $('#welcome-msg').textContent = err.message;
  }
});

// ---------- shell ----------

async function enter(user) {
  state.user = user;
  $('#welcome').classList.add('hidden');
  $('#shell').classList.remove('hidden');
  document.querySelectorAll('.admin-only').forEach((n) => n.classList.toggle('hidden', user.role !== 'admin'));
  renderUser();
  await Promise.all([loadApps(), loadSystem()]);
  if (user.role === 'admin') loadAlerts();
  route();
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
}

const VIEWS = ['apps', 'status', 'profile', 'admin'];

function route() {
  if (!state.user) return;
  let view = (location.hash.replace('#/', '') || 'apps');
  if (!VIEWS.includes(view) || (view === 'admin' && state.user.role !== 'admin')) view = 'apps';
  for (const v of VIEWS) $(`#view-${v}`).classList.toggle('hidden', v !== view);
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  if (view === 'admin') loadAdmin();
  if (view === 'profile') loadStorage();
  if (view === 'status') loadStatus();
}

window.addEventListener('hashchange', route);

$('#logout').addEventListener('click', async () => {
  await api('POST', '/api/logout').catch(() => {});
  closeAlerts();
  showWelcome(false);
});

// ---------- alerts (admins) ----------

const ALERTS_REFRESH_MS = 30 * 1000;
const alerts = { data: null, busy: false };

function clock(iso) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// "14:02" today, "3 Oct 14:02" on another day.
function when(iso) {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? clock(iso) : `${shortDate(iso)} ${clock(iso)}`;
}

async function loadAlerts() {
  if (alerts.busy || !state.user || state.user.role !== 'admin') return;
  alerts.busy = true;
  try {
    renderAlerts(await api('GET', '/api/alerts'));
  } catch {
    // Keep what the bell showed last.
  } finally {
    alerts.busy = false;
  }
}

function alertRow(a) {
  const cleared = Boolean(a.resolvedAt);
  const kind = cleared ? '' : a.dismissedAt ? 'starting' : 'offline';
  let meta;
  if (!cleared) meta = `Since ${when(a.startedAt)} · ${ago(a.startedAt)}${a.dismissedAt ? ' · ignored until fixed' : ''}`;
  else if (a.startedAt === a.resolvedAt) meta = when(a.resolvedAt);
  else meta = `${when(a.startedAt)} – ${clock(a.resolvedAt)} · lasted ${duration((Date.parse(a.resolvedAt) - Date.parse(a.startedAt)) / 1000)}`;
  const ignore = !cleared && !a.dismissedAt
    ? el('button', { class: 'link-btn mono', type: 'button', text: 'Ignore', onclick: () => dismissAlert(a.id) })
    : null;
  return el('div', { class: `alert-row${cleared ? ' cleared' : ''}` },
    el('span', { class: `dot ${kind}` }),
    el('div', { class: 'alert-text' },
      el('div', { text: a.title }),
      el('div', { class: 'mono muted', text: a.detail }),
      el('div', { class: 'mono muted', text: meta })),
    ignore);
}

function renderAlerts(data) {
  alerts.data = data;
  const loud = data.active.filter((a) => !a.dismissedAt).length;
  const count = $('#bell-count');
  count.textContent = loud > 9 ? '9+' : String(loud);
  count.classList.toggle('hidden', !loud);
  $('#bell').classList.toggle('loud', loud > 0);
  $('#bell').setAttribute('aria-label', loud ? `Alerts: ${loud} problem${loud > 1 ? 's' : ''}` : 'Alerts');
  $('#alerts-checked').textContent = data.checkedAt ? `Checked ${clock(data.checkedAt)}` : 'First check running';

  const list = [];
  if (data.active.length) list.push(...data.active.map(alertRow));
  else list.push(el('p', { class: 'alerts-quiet' }, el('span', { class: 'dot online' }), 'All quiet'));
  if (data.recent.length) {
    list.push(el('div', { class: 'mono muted alerts-sub', text: 'Cleared · last 7 days' }));
    list.push(...data.recent.map(alertRow));
  }
  $('#alerts-list').replaceChildren(...list);
  renderAlertSettings(data.settings);
}

async function dismissAlert(id) {
  try {
    renderAlerts(await api('POST', `/api/alerts/${id}/dismiss`));
  } catch {
    loadAlerts();
  }
}

function openAlerts() {
  $('#alerts-panel').classList.remove('hidden');
  $('#bell').setAttribute('aria-expanded', 'true');
  loadAlerts();
}

function closeAlerts() {
  $('#alerts-panel').classList.add('hidden');
  $('#bell').setAttribute('aria-expanded', 'false');
}

$('#bell').addEventListener('click', () => {
  if ($('#alerts-panel').classList.contains('hidden')) openAlerts();
  else closeAlerts();
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.bell-wrap')) closeAlerts();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#alerts-panel').classList.contains('hidden')) {
    closeAlerts();
    $('#bell').focus();
  }
});
$('#alerts-settings-link').addEventListener('click', () => {
  closeAlerts();
  // Wait for the admin view to show, then bring the alert settings into view.
  setTimeout(() => $('#alerts-form').scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
});

const alertForm = $('#alerts-form');
const paintAlertPct = () => {
  const r = alertForm.alertDiskPct;
  r.style.setProperty('--fill', `${((r.value - r.min) / (r.max - r.min)) * 100}%`);
  $('#alert-pct-value').textContent = `${r.value}%`;
  r.disabled = !alertForm.alertDisks.checked;
  $('.alert-level', alertForm).classList.toggle('off', r.disabled);
};
alertForm.alertDiskPct.addEventListener('input', paintAlertPct);
alertForm.alertDisks.addEventListener('change', paintAlertPct);

function renderAlertSettings(s) {
  // Don't overwrite what an admin is in the middle of changing.
  if (alertForm.contains(document.activeElement)) return;
  alertForm.alertApps.checked = s.alertApps;
  alertForm.alertDisks.checked = s.alertDisks;
  alertForm.alertDiskPct.value = s.alertDiskPct;
  paintAlertPct();
}

alertForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('PATCH', '/api/admin/settings', {
      alertApps: alertForm.alertApps.checked,
      alertDisks: alertForm.alertDisks.checked,
      alertDiskPct: Number(alertForm.alertDiskPct.value),
    });
    flash(alertForm, 'Saved');
    alertForm.querySelector('button').blur();
    loadAlerts();
  } catch (err) { flash(alertForm, err.message, false); }
});

// ---------- apps ----------

async function loadApps() {
  const { apps } = await api('GET', '/api/apps');
  state.apps = apps;
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
    return app.url
      ? el('a', { class: 'card app-card', href: resolveUrl(app.url), target: '_blank', rel: 'noopener' }, children)
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
    const { user } = await api('PATCH', '/api/me', { displayName: e.target.displayName.value });
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

async function loadAdmin() {
  const [{ users }, { apps }, { requests, defaultLimitGb }] = await Promise.all([
    api('GET', '/api/admin/users'), api('GET', '/api/apps'), api('GET', '/api/admin/storage-requests')]);
  state.users = users;
  state.apps = apps;
  state.defaultLimitGb = defaultLimitGb;
  $('#settings-form').serverName.value = state.serverName;
  pickers.default.setValue(defaultLimitGb);
  pickers.newUser.setValue(defaultLimitGb);
  renderStorageRequests(requests);
  renderAppsEditor();
  renderUsers();
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
        el('div', {}, el('div', { text: u.displayName }), el('div', { class: 'mono muted', text: `@${u.username}` })),
        el('span', { class: 'pill', text: u.role })),
      u.role === 'admin' ? el('span', { class: 'mono muted', text: 'Sees every app' }) : checks,
      el('div', { class: 'row user-storage' },
        el('span', { class: 'mono muted', text: `Storage · ${bytes(u.storage.usedBytes)} used` }),
        limit,
        el('button', { class: 'btn ghost small', type: 'button', text: 'Save', onclick: save })),
      isMe ? null : el('button', { class: 'btn danger small', type: 'button', text: 'Remove', onclick: remove }),
      msg);
  }));
}

$('#new-user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('POST', '/api/admin/users', {
      displayName: f.displayName.value,
      username: f.username.value,
      password: f.password.value,
      role: f.role.value,
      apps: checkedApps($('#new-user-apps')),
      limitGb: pickers.newUser.getValue(),
    });
    f.reset();
    flash(f, 'User added');
    loadAdmin();
  } catch (err) { flash(f, err.message, false); }
});

$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const { settings } = await api('PATCH', '/api/admin/settings', {
      serverName: e.target.serverName.value,
      defaultLimitGb: pickers.default.getValue(),
    });
    setServerName(settings.serverName);
    flash(e.target, 'Saved');
  } catch (err) { flash(e.target, err.message, false); }
});

// ---------- boot ----------

(async function boot() {
  tickClock();
  setInterval(tickClock, 30 * 1000);
  setInterval(() => { if (state.user && !$('#view-apps').classList.contains('hidden')) loadSystem(); }, 15 * 1000);
  // The status page refreshes itself while it is open and the tab is visible.
  setInterval(() => {
    if (state.user && !document.hidden && !$('#view-status').classList.contains('hidden')) loadStatus();
  }, STATUS_REFRESH_MS);
  // The bell reads the server's last check, so this is cheap; it pauses in background tabs.
  setInterval(() => { if (!document.hidden) loadAlerts(); }, ALERTS_REFRESH_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadAlerts(); });
  const s = await api('GET', '/api/state');
  setServerName(s.serverName);
  if (s.user) await enter(s.user);
  else showWelcome(s.setupRequired);
})();
