'use strict';

// Updating Roost from inside Roost. The web app never touches Docker or git:
// it leaves a small request file ("check" or "apply") in the data folder, and
// the separate roost-updater service (updater/update-service.js) does the work
// and reports back in a status file, the same way the backup service does.

const fs = require('fs');
const path = require('path');

const REQUEST_FILE = 'update-request.json';
const STATUS_FILE = 'update-status.json';
const LOGGED_FILE = 'update-logged.txt';
const ACTIONS = new Set(['check', 'apply']);
// The updater writes at least every 5 minutes while it is alive.
const STOPPED_AFTER = 15 * 60 * 1000;

function readStatus(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, STATUS_FILE), 'utf8'));
  } catch {
    return null;
  }
}

function writeRequest(dataDir, action) {
  if (!ACTIONS.has(action)) throw new Error('Unknown update action');
  const file = path.join(dataDir, REQUEST_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ action, at: new Date().toISOString() }));
  fs.renameSync(tmp, file);
}

function hasRequest(dataDir) {
  return fs.existsSync(path.join(dataDir, REQUEST_FILE));
}

// What the Admin card shows. state: off (no updater yet), stopped, checking,
// applying, available, current, or error (never managed to look).
function summarize(status, now = Date.now()) {
  if (!status) return { state: 'off' };
  const last = status.last
    ? {
      ok: status.last.ok,
      nothing: Boolean(status.last.nothing),
      error: status.last.error || null,
      detail: status.last.detail || null,
      rolledBack: status.last.rolledBack,
      from: status.last.from || null,
      to: status.last.to || null,
      count: status.last.count || 0,
      needsRedeploy: Boolean(status.last.needsRedeploy),
      at: status.last.at || null,
      finishedAt: status.last.finishedAt || null,
    }
    : null;
  const out = {
    head: status.head || null,
    behind: status.behind || 0,
    commits: status.commits || [],
    composeChanged: Boolean(status.composeChanged),
    updaterChanged: Boolean(status.updaterChanged),
    conflicts: status.conflicts || [],
    ahead: status.ahead || 0,
    checkedAt: status.checkedAt || null,
    checkError: status.checkError || null,
    phase: status.phase || null,
    last,
  };
  if (now - Date.parse(status.updatedAt) > STOPPED_AFTER) return { ...out, state: 'stopped' };
  if (status.state === 'applying') return { ...out, state: 'applying' };
  if (status.state === 'checking') return { ...out, state: 'checking' };
  if (!status.head) return { ...out, state: 'error' };
  return { ...out, state: out.behind ? 'available' : 'current' };
}

// So an update's outcome is written to the activity log once, even across restarts.
function lastLogged(dataDir) {
  try {
    return fs.readFileSync(path.join(dataDir, LOGGED_FILE), 'utf8').trim();
  } catch {
    return '';
  }
}

function markLogged(dataDir, at) {
  fs.writeFileSync(path.join(dataDir, LOGGED_FILE), String(at));
}

module.exports = { readStatus, writeRequest, hasRequest, summarize, lastLogged, markLogged, REQUEST_FILE, STATUS_FILE };
