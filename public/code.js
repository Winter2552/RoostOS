// The phone's side of signing in a TV: enter or scan the code, check what is
// asking, approve it.
(function () {
  function $(id) { return document.getElementById(id); }
  function show(id) {
    var all = ['enter', 'confirm', 'done', 'signin'];
    for (var i = 0; i < all.length; i++) $(all[i]).className = all[i] === id ? '' : 'hide';
  }
  function say(id, text) { $(id).textContent = text; $(id).className = text ? 'err' : 'err hide'; }

  function post(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { status: r.status, data: d }; }); });
  }

  var seen = null;

  function lookup(code) {
    say('err', '');
    return post('/api/tv/lookup', { code: code }).then(function (r) {
      if (r.status === 401) return show('signin');
      if (r.status !== 200) return say('err', r.data.error || 'Something went wrong. Try again.');
      seen = r.data;
      $('c-name').textContent = seen.name;
      $('c-where').textContent = (seen.outside ? 'Outside your home network' : 'Home network') + ' · asked ' + (seen.ago < 60 ? seen.ago + ' s' : Math.round(seen.ago / 60) + ' min') + ' ago';
      $('c-code').textContent = seen.display;
      $('c-user').textContent = seen.username;
      show('confirm');
    }).catch(function () { say('err', 'Roost did not answer. Try again.'); });
  }

  function decide(approve) {
    say('err2', '');
    post('/api/tv/approve', { code: seen.code, approve: approve }).then(function (r) {
      if (r.status !== 200) return say('err2', r.data.error || 'Something went wrong. Try again.');
      $('d-title').textContent = approve ? 'Done' : 'Turned down';
      $('d-text').textContent = approve ? 'Your TV is signed in. You can close this page.' : 'The TV was not signed in.';
      show('done');
    }).catch(function () { say('err2', 'Roost did not answer. Try again.'); });
  }

  $('form').addEventListener('submit', function (e) { e.preventDefault(); lookup($('code').value); });
  $('yes').addEventListener('click', function () { decide(true); });
  $('no').addEventListener('click', function () { decide(false); });

  fetch('/api/state', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (s) {
    if (!s.user) return show('signin');
    $('who').textContent = 'Signed in as ' + s.user.username;
    var q = /[?&]code=([A-Za-z0-9-]+)/.exec(location.search);
    show('enter');
    if (q) { $('code').value = q[1]; lookup(q[1]); }
  }).catch(function () { show('enter'); });
})();
