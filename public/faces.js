'use strict';

// Finds the faces in a person's photos, in their own browser, for Glint's People.
//
// The pictures never leave the device for this: the browser opens each photo,
// finds the faces and turns each into 128 numbers, and sends only those and
// where the face sits. The finder (about 12 MB, vendored in /vendor/) is
// fetched the first time someone presses Start, and not before.
//
// It works only while the People page is showing and Start has been pressed
// (Pause or leaving the page stops it), a few photos at a time, so a phone
// isn't drained and the server isn't polled.
//
//   api(method, url, body)   -> Glint's server
//   mediaUrl(photo, convert) -> the picture to read (convert asks for a copy the browser can open)
//   onChange(state)          -> called as progress moves
window.createFaceScanner = function createFaceScanner({ api, mediaUrl, onChange }) {
  const BASE = '/vendor/face-1.7.15';
  const LONG_EDGE = 1024; // photos are looked at this big: small enough to be quick, big enough for faces in a group
  const MIN_SCORE = 0.7;
  const MIN_FACE = 0.045; // a face narrower than this share of the picture's width is too small to tell apart
  const S = { running: false, loading: false, total: 0, scanned: 0, error: '' };
  let lib = null;

  const emit = () => onChange(S);

  function script(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('The face finder couldn’t be loaded'));
      document.head.append(s);
    });
  }

  async function load() {
    if (lib) return lib;
    S.loading = true;
    emit();
    try {
      await script(`${BASE}/face-api.js`);
      const f = window.faceapi;
      await f.tf.setBackend('webgl').catch(() => f.tf.setBackend('cpu'));
      await f.tf.ready();
      await Promise.all([
        f.nets.ssdMobilenetv1.loadFromUri(`${BASE}/model`),
        f.nets.faceLandmark68TinyNet.loadFromUri(`${BASE}/model`),
        f.nets.faceRecognitionNet.loadFromUri(`${BASE}/model`),
      ]);
      lib = f;
    } finally {
      S.loading = false;
    }
    return lib;
  }

  function open(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('unreadable'));
      img.src = url;
    });
  }

  // The photo drawn at LONG_EDGE, or null when the browser can't open it (even converted).
  async function draw(photo) {
    let img;
    try { img = await open(mediaUrl(photo)); } catch {
      try { img = await open(mediaUrl(photo, true)); } catch { return null; }
    }
    const k = Math.min(1, LONG_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * k));
    c.height = Math.max(1, Math.round(img.naturalHeight * k));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c;
  }

  async function scanOne(photo) {
    const c = await draw(photo);
    if (!c) { await api('POST', '/api/glint/faces', { photo: photo.id, failed: true }); return; }
    const found = await lib.detectAllFaces(c, new lib.SsdMobilenetv1Options({ minConfidence: MIN_SCORE })).withFaceLandmarks(true).withFaceDescriptors();
    const faces = found
      .filter((f) => f.detection.box.width / c.width >= MIN_FACE)
      .map((f) => {
        const b = f.detection.box;
        const clamp = (v) => Math.max(0, Math.min(1000, Math.round(v)));
        return {
          box: [clamp((b.x / c.width) * 1000), clamp((b.y / c.height) * 1000), clamp((b.width / c.width) * 1000), clamp((b.height / c.height) * 1000)],
          score: f.detection.score,
          vec: Array.from(f.descriptor, (n) => Math.round(n * 1e5) / 1e5),
        };
      });
    await api('POST', '/api/glint/faces', { photo: photo.id, faces });
  }

  async function start() {
    if (S.running) return;
    S.running = true;
    S.error = '';
    emit();
    try {
      await load();
      while (S.running) {
        const t = await api('GET', '/api/glint/faces/todo?limit=8');
        S.total = t.total;
        S.scanned = t.scanned;
        emit();
        if (!t.photos.length) break;
        for (const p of t.photos) {
          if (!S.running) break;
          await scanOne(p);
          S.scanned++;
          emit();
          await new Promise((r) => setTimeout(r, 0)); // let the page breathe between photos
        }
      }
    } catch (err) {
      S.error = err.message;
    } finally {
      S.running = false;
      emit();
    }
  }

  return {
    state: S,
    start,
    pause() { if (S.running) { S.running = false; emit(); } },
    // Progress without scanning, for the page to show.
    set(total, scanned) { S.total = total; S.scanned = scanned; },
  };
};
