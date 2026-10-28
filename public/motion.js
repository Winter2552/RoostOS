// Screen switch: when you move between apps (Roost, Nest, Glint, Nova) the
// app's mark builds itself in the middle of the screen for about a second.
// It only runs on a change of app, never loops, and is skipped for people
// who ask their device for less motion. Styles are in style.css (.switch).
(() => {
  'use strict';

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');

  const CHEV = '<path class="chev" d="M22 48 L42 68 L22 88" fill="none" stroke="currentColor" stroke-width="13"/>';
  const BODY = '<path class="body" d="M58 92 V44 H76 A26 26 0 0 1 102 70 V92 Z" fill="currentColor"/>';
  const EYE = '<circle class="eye" cx="86" cy="60" r="4.5" fill="var(--bg)"/>';
  const draw = (extra) => `<svg viewBox="0 8 120 120" aria-hidden="true">${extra.under || ''}${CHEV}<g class="mark">${BODY}${extra.eye === false ? '' : EYE}</g>${extra.over || ''}</svg>`;

  // Every app builds the same way (chevron, then the bird) and adds one detail of its own.
  const APPS = {
    roost: { name: 'Roost', svg: draw({}) },
    nest: { name: 'Nest', svg: draw({ under: '<path class="bowl" pathLength="1" d="M48 98 Q80 130 112 98 M60 108 Q80 124 100 108" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round"/>' }) },
    glint: { name: 'Glint', svg: draw({ eye: false, over: '<path class="star" d="M86 49 L88.8 57.2 L97 60 L88.8 62.8 L86 71 L83.2 62.8 L75 60 L83.2 57.2 Z" fill="var(--bg)"/><path class="star2" d="M110 30 L111.8 35.2 L117 37 L111.8 38.8 L110 44 L108.2 38.8 L103 37 L108.2 35.2 Z" fill="currentColor"/>' }) },
    nova: { name: 'Nova', svg: draw({ over: '<ellipse class="ringbg" pathLength="1" cx="80" cy="70" rx="44" ry="13" transform="rotate(-22 80 70)" fill="none" stroke="var(--bg)" stroke-width="9"/><ellipse class="ring" pathLength="1" cx="80" cy="70" rx="44" ry="13" transform="rotate(-22 80 70)" fill="none" stroke="currentColor" stroke-width="3"/><circle class="planet" cx="116" cy="54" r="5" fill="currentColor"/>' }) },
  };

  const appOf = () => {
    const first = location.hash.replace(/^#\/?/, '').split('/')[0];
    return first === 'nest' ? 'nest' : first === 'glint' ? 'glint' : first === 'galaxies' ? 'nova' : 'roost';
  };

  let overlay = null;
  let current = appOf();

  function play(key) {
    const app = APPS[key];
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'switch';
      overlay.setAttribute('aria-hidden', 'true');
      overlay.addEventListener('animationend', (e) => { if (e.target === overlay) overlay.classList.remove('on'); });
      document.body.append(overlay);
    }
    overlay.classList.remove('on');
    overlay.innerHTML = `${app.svg}<div class="switch-name mono"></div>`; // code-check: ok (Roost's own app marks)
    overlay.querySelector('.switch-name').textContent = app.name;
    void overlay.offsetWidth; // restart the animation if one is still showing
    overlay.classList.add('on');
  }

  // ---------- load-up screen ----------
  // The markup is in index.html so it shows while the page loads. app.js says
  // what to write once it knows who is here; text(null) just fades it out.
  // Tap to skip. If the page never calls text(), it fades on its own.
  const boot = document.getElementById('boot');
  if (boot) {
    const word = boot.querySelector('.boot-word');
    const span = document.getElementById('boot-text');
    const finish = () => boot.classList.add('done');
    boot.addEventListener('animationend', (e) => { if (e.target === boot) boot.remove(); });
    boot.addEventListener('click', () => boot.remove());
    window.roostBoot = {
      text(t) {
        if (!boot.isConnected || word.classList.contains('typing') || boot.classList.contains('done')) return;
        if (!t) { finish(); return; }
        span.textContent = t;
        // Typing waits for the mark to finish building, and starts at once if it already has.
        word.style.setProperty('--n', String(t.length));
        word.style.setProperty('--delay', `${Math.max(0, 800 - performance.now()) / 1000}s`);
        span.addEventListener('animationend', finish, { once: true });
        word.classList.add('typing');
      },
    };
    setTimeout(() => window.roostBoot.text(null), 3000);
  }

  window.addEventListener('hashchange', () => {
    const next = appOf();
    if (next === current) return;
    current = next;
    if (!reduce.matches && !document.hidden) play(next);
  });
})();
