'use strict';

// One search box across Roost's apps.
//
// Each app that can be searched is a source. Roost asks every source the user
// can open at the same time and returns the results grouped by app. Nothing is
// copied into a shared index, so results are always current and nothing runs
// while nobody is searching. A slow app is cut off, so it can't hold up the rest.
//
// A source is { app, search(user, q, limit) }, where search returns (or
// resolves to) { items: [{ id, name, kind, mime, detail, href }], more }.
// Built-in apps search their own database (Nest now, Glint next); an outside
// app such as Jellyfin can be added as a source that calls its own API.

const MIN_CHARS = 2;
const MAX_CHARS = 100;
const PER_APP = 8;
const TIMEOUT_MS = 1500;

function cleanQuery(raw) {
  return String(raw || '').normalize('NFC').replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);
}

function withTimeout(promise, ms) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('Took too long'), { timeout: true })), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

// sources: [{ app, search }]. visibleApps(user): the apps this user can open.
function createSearch({ sources, visibleApps, timeoutMs = TIMEOUT_MS }) {
  const forUser = (user) => {
    const apps = visibleApps(user);
    return sources
      .map((s) => ({ source: s, app: apps.find((a) => a.id === s.app) }))
      .filter((x) => x.app);
  };

  return {
    // Ids of the apps this user can search; the dashboard shows the box only if there are any.
    apps: (user) => forUser(user).map((x) => x.app.id),

    async run(user, raw) {
      const q = cleanQuery(raw);
      if (q.length < MIN_CHARS) return { q, groups: [] };
      const groups = await Promise.all(forUser(user).map(async ({ source, app }) => {
        const group = { app: app.id, name: app.name, icon: app.icon, items: [], more: false };
        try {
          const found = await withTimeout(Promise.resolve().then(() => source.search(user, q, PER_APP)), timeoutMs);
          return { ...group, items: found.items, more: Boolean(found.more) };
        } catch (err) {
          if (!err.timeout) console.error(`Search in ${app.name} failed:`, err);
          return { ...group, error: err.timeout ? `${app.name} took too long to answer` : `Couldn’t search ${app.name}` };
        }
      }));
      return { q, groups };
    },
  };
}

// Nest: names of files and folders. Results open the folder, with the file picked out.
function nestSource(nest) {
  return {
    app: 'nest',
    search(user, q, limit) {
      const { items, more } = nest.search(user, q, limit);
      return {
        more,
        items: items.map((it) => ({
          id: it.id,
          name: it.name,
          kind: it.kind,
          mime: it.mime,
          detail: it.where,
          href: it.kind === 'folder' ? `#/nest/f/${it.id}` : `#/nest/f/${it.parent}/${it.id}`,
        })),
      };
    },
  };
}

module.exports = { createSearch, nestSource, cleanQuery, MIN_CHARS };
