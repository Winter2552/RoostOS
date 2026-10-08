'use strict';

// The upload meter on the status page: how much Roost and Nest send out of the
// house each day. Home upload is the scarce thing (about 18 Mb/s), so this is
// the number that says whether anything more (like a cache in front) is worth it.
// Counts what this server sends; Jellyfin and other apps aren't counted.

const fs = require('fs');
const path = require('path');

const KEEP_DAYS = 31;

// Addresses on the home network. Everything else is "away", including
// Tailscale's 100.64.0.0/10 range: a phone on Tailscale is still out of the house.
function isHome(ip) {
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(ip);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  const v6 = ip.toLowerCase();
  return v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

// Local date, so "today" matches the clock on the wall.
function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

class TrafficMeter {
  constructor(dataDir, { saveDelayMs = 60 * 1000 } = {}) {
    this.file = path.join(dataDir, 'traffic.json');
    this.saveDelayMs = saveDelayMs;
    this.timer = null;
    try {
      this.days = JSON.parse(fs.readFileSync(this.file, 'utf8')).days || {};
    } catch {
      this.days = {};
    }
  }

  // Counts the bytes the socket writes for this response. Keep-alive sockets
  // carry one response at a time, so the difference is this response's share.
  track(req, res, app, ip) {
    const socket = req.socket;
    const start = socket.bytesWritten;
    const where = isHome(ip) ? 'home' : 'away';
    let counted = false;
    const count = () => {
      if (counted) return;
      counted = true;
      this.add(app, where, socket.bytesWritten - start);
    };
    res.on('finish', count);
    res.on('close', count);
  }

  add(app, where, bytes, day = dayKey()) {
    if (!(bytes > 0)) return;
    const d = (this.days[day] ||= {});
    const a = (d[app] ||= { home: 0, away: 0 });
    a[where] += bytes;
    this.saveSoon();
  }

  // Bytes sent away from home today and over the last 7 days, per app.
  summary(now = new Date()) {
    const week = new Set();
    for (let i = 0; i < 7; i++) week.add(dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)));
    const today = dayKey(now);
    const apps = {};
    for (const [day, perApp] of Object.entries(this.days)) {
      if (!week.has(day)) continue;
      for (const [app, v] of Object.entries(perApp)) {
        const s = (apps[app] ||= { today: 0, week: 0 });
        s.week += v.away;
        if (day === today) s.today += v.away;
      }
    }
    return { apps, since: Object.keys(this.days).sort()[0] || null };
  }

  saveSoon() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.saveDelayMs);
    this.timer.unref();
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const keep = Object.keys(this.days).sort().slice(-KEEP_DAYS);
    this.days = Object.fromEntries(keep.map((k) => [k, this.days[k]]));
    try {
      fs.writeFileSync(this.file, JSON.stringify({ days: this.days }));
    } catch (err) {
      console.error('Saving the upload meter failed:', err.message);
    }
  }
}

module.exports = { TrafficMeter, isHome, dayKey };
