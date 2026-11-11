'use strict';

// Roost's Device finder helper (the roost-lan service in docker-compose.yml). It
// runs on the host's network so it can see the home network, and does one job:
// sweep it (src/lan-scan.js) and leave the result as lan.json in a shared folder
// for Roost to read. It has no web port and takes no instructions except a file
// named scan-now that Roost drops there. Between sweeps it does nothing.

const fs = require('fs');
const path = require('path');
const { scan } = require('./lan-scan');

const DIR = process.env.LAN_DIR || '/out';
const EVERY_MS = Math.max(5, Number(process.env.LAN_INTERVAL_MIN) || 30) * 60 * 1000;
const RESULT = path.join(DIR, 'lan.json');
const TRIGGER = path.join(DIR, 'scan-now');

let running = false;
let again = false;

async function sweep() {
  if (running) { again = true; return; }
  running = true;
  try { fs.unlinkSync(TRIGGER); } catch { /* none waiting */ }
  try {
    const result = await scan();
    result.every = EVERY_MS;
    const tmp = `${RESULT}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(result));
    fs.renameSync(tmp, RESULT);
  } catch (err) {
    console.error('Sweep failed:', err.message);
  } finally {
    running = false;
    if (again) { again = false; setTimeout(sweep, 1000); }
  }
}

fs.mkdirSync(DIR, { recursive: true });
sweep();
setInterval(sweep, EVERY_MS);
// Roost asks for a sweep by dropping a file; watching costs nothing while idle.
let debounce = null;
fs.watch(DIR, (event, name) => {
  if (name !== 'scan-now') return;
  clearTimeout(debounce);
  debounce = setTimeout(() => { if (fs.existsSync(TRIGGER)) sweep(); }, 300);
});
