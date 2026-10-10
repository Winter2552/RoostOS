'use strict';

// Choosing which drive Nest and Glint keep their files on, from Admin → Storage.
// Like updates, Roost never touches Docker: it leaves a request file and the
// roost-updater service (updater/update-service.js) does the work and reports
// in a status file. Moving only changes where Nest's folder is mounted, so it
// is offered while Nest holds no files; with files in it the copy is a manual job.

const fs = require('fs');
const path = require('path');

const REQUEST_FILE = 'nest-drive-request.json';
const STATUS_FILE = 'nest-drive-status.json';
// The drive list is looked at again when it is older than this.
const STALE_AFTER = 60 * 1000;

function readStatus(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, STATUS_FILE), 'utf8'));
  } catch {
    return null;
  }
}

function writeRequest(dataDir, request) {
  const file = path.join(dataDir, REQUEST_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...request, at: new Date().toISOString() }));
  fs.renameSync(tmp, file);
}

function hasRequest(dataDir) {
  return fs.existsSync(path.join(dataDir, REQUEST_FILE));
}

// How long the waiting request has gone unanswered, in ms, or 0 when none waits.
// The updater takes a request within seconds, so a long wait means it is not
// reading them (typically an older updater that was never redeployed).
function requestAge(dataDir, now = Date.now()) {
  try {
    const at = Date.parse(JSON.parse(fs.readFileSync(path.join(dataDir, REQUEST_FILE), 'utf8')).at);
    return Number.isFinite(at) ? Math.max(1, now - at) : 1;
  } catch {
    return hasRequest(dataDir) ? 1 : 0;
  }
}

// True when anything but empty folders is in Nest's folder (stops at the first file).
function hasFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (!e.isDirectory()) return true;
    if (hasFiles(path.join(dir, e.name))) return true;
  }
  return false;
}

const stale = (status, now = Date.now()) => !status || !(now - Date.parse(status.updatedAt) < STALE_AFTER);

// What the Admin card shows. state: off (no answer yet), idle or moving.
// onDrive: Nest's folder is already on a plugged-in drive (under /media).
function summarize(status, nestDir) {
  if (!status) return { state: 'off' };
  const current = status.current || null;
  return {
    state: status.state === 'moving' ? 'moving' : 'idle',
    drives: status.drives || [],
    current,
    onDrive: Boolean(current && current.startsWith('/media/')),
    error: status.error || null,
    mediaSeen: status.mediaSeen !== false,
    phase: status.phase || null,
    last: status.last || null,
    empty: !hasFiles(nestDir),
  };
}

module.exports = { readStatus, writeRequest, hasRequest, requestAge, hasFiles, summarize, stale, REQUEST_FILE, STATUS_FILE };
