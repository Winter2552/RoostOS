'use strict';

// Edits docker-compose.override.yml so Nest, the nightly backup and the status
// page's "Data" drive point at a chosen drive. The file is the admin's own (it
// may already hold the Backup drive and time zone), so only the three mount
// lines this needs are touched and everything else is kept as it is.
//
// No YAML library: the file is small and simple, and the updater checks the
// result with "docker compose config" before using it.

const MOUNTS = {
  roost: [
    { target: '/nest', line: (d) => `${d.nest}:/nest` },
    { target: '/hostfs/data', line: (d) => `${d.drive}:/hostfs/data:ro` },
  ],
  'roost-backup': [
    { target: '/source/nest', line: (d) => `${d.nest}:/source/nest:ro` },
  ],
};

const indentOf = (line) => line.length - line.trimStart().length;
const blank = (line) => !line.trim() || line.trim().startsWith('#');

// The container side of a short-form mount line ("- /a:/b:ro" → "/b"), or null.
function targetOf(line) {
  const m = line.trim().match(/^-\s*["']?([^"'\s]+?)["']?\s*(?:#.*)?$/);
  if (!m) return null;
  const parts = m[1].split(':');
  return parts.length >= 2 ? parts[1] : null;
}

// Finds a key at exactly `indent` inside lines[from..to). → index or -1.
function findKey(lines, key, indent, from, to) {
  for (let i = from; i < to; i++) {
    if (!blank(lines[i]) && indentOf(lines[i]) === indent && lines[i].trim().replace(/\s*#.*$/, '') === `${key}:`) return i;
  }
  return -1;
}

// The end of the block that starts at `start` (first later non-blank line that
// is not indented deeper).
function blockEnd(lines, start) {
  const base = indentOf(lines[start]);
  for (let i = start + 1; i < lines.length; i++) {
    if (!blank(lines[i]) && indentOf(lines[i]) <= base) return i;
  }
  return lines.length;
}

// drive: host folder of the drive (e.g. /media/roosthdd); nest: the Nest folder on it.
function mergeOverride(text, drive, nest) {
  const lines = (text || '').replace(/\r\n/g, '\n').split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (!lines.length) lines.push('services:');
  let sIdx = findKey(lines, 'services', 0, 0, lines.length);
  if (sIdx < 0) throw new Error('The override file has no "services:" section, so it was left alone.');
  const d = { drive, nest };

  for (const [service, mounts] of Object.entries(MOUNTS)) {
    const sEnd = blockEnd(lines, sIdx);
    let svc = findKey(lines, service, 2, sIdx + 1, sEnd);
    if (svc < 0) {
      lines.splice(sEnd, 0, `  ${service}:`, '    volumes:', ...mounts.map((m) => `      - ${m.line(d)}`));
      continue;
    }
    const svcEnd = blockEnd(lines, svc);
    const vol = findKey(lines, 'volumes', 4, svc + 1, svcEnd);
    if (vol < 0) {
      lines.splice(svc + 1, 0, '    volumes:', ...mounts.map((m) => `      - ${m.line(d)}`));
      continue;
    }
    const volEnd = blockEnd(lines, vol);
    const targets = new Set(mounts.map((m) => m.target));
    // Drop the old lines for these mounts, keep the rest.
    for (let i = volEnd - 1; i > vol; i--) {
      if (targets.has(targetOf(lines[i]))) lines.splice(i, 1);
    }
    lines.splice(vol + 1, 0, ...mounts.map((m) => `      - ${m.line(d)}`));
  }
  return `${lines.join('\n')}\n`;
}

module.exports = { mergeOverride, targetOf };
