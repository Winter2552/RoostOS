'use strict';

// Tiny JSON-file store. Everything Roost keeps (users, apps, settings) lives
// in one file under DATA_DIR so it survives container restarts via a volume.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_APPS = [
  {
    id: 'jellyfin',
    name: 'Jellyfin',
    tagline: 'Media',
    description: 'Films, shows and music, streamed from home.',
    url: 'http://{host}:8096',
    icon: 'play',
  },
  {
    id: 'nova',
    name: 'Nova',
    tagline: 'Galaxies',
    description: 'Coffee Galaxy and the other galaxies.',
    url: '',
    icon: 'orbit',
  },
  {
    id: 'nest',
    name: 'Nest',
    tagline: 'Files',
    description: 'Your files, stored on the Roost drive.',
    // Built into Roost: the link opens the Files page.
    url: '#/nest',
    icon: 'folder',
  },
  {
    id: 'glint',
    name: 'Glint',
    tagline: 'Photos',
    description: 'Your photos and videos, on the Roost drive.',
    // Built into Roost too: the link opens the Photos page.
    url: '#/glint',
    icon: 'spark',
  },
];

function emptyDb() {
  return {
    version: 1,
    settings: { serverName: 'Roost' },
    users: [],
    apps: DEFAULT_APPS.map((a) => ({ ...a })),
  };
}

class Store {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'roost.json');
    fs.mkdirSync(dataDir, { recursive: true });
    if (fs.existsSync(this.file)) {
      this.db = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } else {
      this.db = emptyDb();
      this.save();
    }
  }

  save() {
    // Write to a temp file and rename so a crash never leaves half a file.
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.db, null, 2));
    fs.renameSync(tmp, this.file);
  }

  // For frequent small changes (like storage usage after each upload): one
  // write a moment later instead of one per change.
  saveSoon() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.save();
    }, 2000);
    this.timer.unref();
  }

  flush() {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.save();
  }

  newId() {
    return crypto.randomBytes(8).toString('hex');
  }
}

module.exports = { Store, DEFAULT_APPS };
