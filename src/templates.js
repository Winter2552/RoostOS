'use strict';

// App templates for Admin → Apps → Add app. Two sources:
//   - a short built-in list: Roost's own apps plus a few common home-server
//     apps, each with its usual port, so a card is a tap away;
//   - the containers Docker is running that no card covers yet, filled in with
//     the port they are really published on (ZimaOS often changes the default).
// Kept short on purpose: a card is easy to edit after it is added.

const { DEFAULT_APPS } = require('./store');
const { containersFor } = require('./docker');

// port: the port the app listens on inside its container, which is also its
// usual published port. images: image names it ships as, without registry or tag.
const OWN = {
  jellyfin: { port: 8096, images: ['jellyfin/jellyfin', 'linuxserver/jellyfin'] },
};
const TEMPLATES = [
  ...DEFAULT_APPS.map((a) => ({ ...a, ...OWN[a.id] })),
  { id: 'home-assistant', name: 'Home Assistant', tagline: 'Home', description: 'Lights, sensors and automations.', icon: 'home', port: 8123, images: ['home-assistant/home-assistant', 'homeassistant/home-assistant', 'linuxserver/homeassistant'] },
  { id: 'navidrome', name: 'Navidrome', tagline: 'Music', description: 'Your music library, streamed.', icon: 'music', port: 4533, images: ['deluan/navidrome'] },
  { id: 'audiobookshelf', name: 'Audiobookshelf', tagline: 'Audiobooks', description: 'Audiobooks and podcasts.', icon: 'play', port: 13378, images: ['advplyr/audiobookshelf'] },
  { id: 'portainer', name: 'Portainer', tagline: 'Containers', description: 'Manage Docker containers.', icon: 'grid', port: 9443, https: true, images: ['portainer/portainer-ce', 'portainer/portainer-ee'] },
];

// "lscr.io/linuxserver/jellyfin:10.9" → "linuxserver/jellyfin"
function imageName(image) {
  let name = String(image || '').toLowerCase().replace(/@.*$/, '');
  const slash = name.lastIndexOf('/');
  const colon = name.lastIndexOf(':');
  if (colon > slash) name = name.slice(0, colon);
  const parts = name.split('/');
  // Drop a registry host (it has a dot or a port) and Docker Hub's "library/".
  if (parts.length > 1 && /[.:]/.test(parts[0])) parts.shift();
  if (parts[0] === 'library') parts.shift();
  return parts.join('/');
}

function templateFor(image) {
  const name = imageName(image);
  return TEMPLATES.find((t) => (t.images || []).includes(name)) || null;
}

function title(name) {
  return name.replace(/[-_]+/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase()).slice(0, 40);
}

// What a template turns into in the editor. No id: the server gives one, unless
// the template is one of Roost's own apps and that id is free.
function cardFrom(t, port = t.port) {
  const card = {
    name: t.name,
    tagline: t.tagline,
    description: t.description,
    icon: t.icon,
    url: port ? `${t.https ? 'https' : 'http'}://{host}:${port}` : t.url || '',
  };
  if (DEFAULT_APPS.some((a) => a.id === t.id)) card.id = t.id;
  return card;
}

// Running containers with no card yet. Helpers with no published port and no
// template (databases, caches) are left out: they are not something to open.
function suggestions(apps, containers, roostContainer) {
  const taken = new Set();
  for (const a of [...apps, { id: 'roost', container: roostContainer }]) {
    for (const c of containersFor(a, containers)) taken.add(c.id);
  }
  return containers
    .filter((c) => c.state === 'running' && !taken.has(c.id))
    .map((c) => {
      const t = templateFor(c.image);
      const ports = c.ports || [];
      const port = (t && ports.find((p) => p.private === t.port)) || ports[0];
      if (!t && !port) return null;
      const card = t ? cardFrom(t, port ? port.public : t.port) : {
        name: title(c.project || c.name),
        tagline: '',
        description: '',
        icon: 'grid',
        url: `http://{host}:${port.public}`,
      };
      return { ...card, key: t ? t.id : undefined, container: c.name, image: c.image };
    })
    .filter(Boolean)
    .sort((x, y) => x.name.localeCompare(y.name));
}

function templates() {
  return TEMPLATES.map((t) => ({ key: t.id, ...cardFrom(t) }));
}

module.exports = { suggestions, templates, imageName };
