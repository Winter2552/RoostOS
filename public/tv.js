// The TV's code screen. Plain, old-browser-friendly JavaScript: ask for a code,
// then hold one request open until a phone approves it (no timer polling).
(function () {
  var secret = '';
  var expiresAt = 0;
  var done = false;
  function $(id) { return document.getElementById(id); }

  function post(url, body, cb) {
    var x = new XMLHttpRequest();
    x.open('POST', url);
    x.setRequestHeader('Content-Type', 'application/json');
    x.timeout = 40000;
    x.onload = function () {
      var data = null;
      try { data = JSON.parse(x.responseText); } catch (e) { /* not JSON */ }
      cb(x.status, data);
    };
    x.onerror = x.ontimeout = function () { cb(0, null); };
    x.send(JSON.stringify(body));
  }

  function end(title, text) {
    done = true;
    $('wait').className = 'hide';
    $('end').className = '';
    $('end-title').textContent = title;
    $('end-text').textContent = text;
  }

  function tick() {
    if (done) return;
    var s = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
    $('left').textContent = 'Waiting… the code works for ' + Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + (s % 60);
    if (s === 0) return end('That code ran out', 'Get a new one and try again.');
    setTimeout(tick, 1000);
  }

  function wait() {
    if (done) return;
    post('/api/tv/wait', { secret: secret }, function (status, data) {
      if (done) return;
      if (status === 200 && data && data.state === 'approved') {
        done = true;
        $('wait').className = 'hide';
        $('end').className = '';
        $('end-title').textContent = 'Signed in';
        $('end-text').textContent = 'Opening Roostflix…';
        $('again').className = 'hide';
        location.replace('/jellyfin/');
      } else if (status === 200 && data && data.state === 'denied') {
        end('Not approved', 'The sign-in was turned down on the phone.');
      } else if (status === 200 && data && data.state === 'expired') {
        end('That code ran out', 'Get a new one and try again.');
      } else {
        // Still waiting, or the connection blinked: ask again, calmly.
        setTimeout(wait, status === 200 ? 0 : 3000);
      }
    });
  }

  post('/api/tv/start', {}, function (status, data) {
    if (status !== 200 || !data) {
      var msg = data && data.error ? data.error : 'Roost did not answer. Check the TV is on your network.';
      return end("Can't sign in right now", msg);
    }
    secret = data.secret;
    expiresAt = Date.now() + data.expiresIn;
    $('code').textContent = data.code;
    $('addr').textContent = data.address;
    if (data.qr) { $('qr').innerHTML = data.qr; $('qr').className = 'qr'; } // Roost drew this SVG itself. code-check: ok
    tick();
    wait();
  });
})();
