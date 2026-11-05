/* Mock-site driver. Plain DOM wiring, no inline handlers, nothing loaded from the network.
   OTHER_ORIGIN is deliberately a different host from the page's own, because Chrome treats
   localhost and 127.0.0.1 as separate sites. That is what makes the cross-site tests genuine. */
(function () {
  'use strict';
  var here = location.hostname;
  var OTHER = (here === 'localhost' ? 'http://127.0.0.1' : 'http://localhost') + ':' + (location.port || '8080');

  var statusEl = document.getElementById('status');
  function say(msg) { if (statusEl) { statusEl.textContent = msg; } }

  function openTab(url, label) {
    say(label + ': opening ' + url);
    var w = window.open(url, '_blank');
    if (!w) { say('Popup blocked by Chrome. Allow popups for this site, then try again.'); }
  }

  function on(id, fn) { var el = document.getElementById(id); if (el) { el.addEventListener('click', fn); } }

  // Test 2 / 14: a path matching the */popunder* rule on the other origin.
  function adTab() { openTab(OTHER + '/popunder/ad-landing.html', 'Test 2'); }
  on('t2', adTab);
  on('t14', adTab);

  // Test 6: an ordinary page on the other origin with nothing ad-like about it.
  on('t6', function () { openTab(OTHER + '/unknown.html', 'Test 6'); });

  // Test 5: same-tab redirect to a path matching the */ad-redirect* blocking rule.
  on('t5', function () {
    say('Test 5: redirecting this tab...');
    setTimeout(function () { location.href = OTHER + '/ad-redirect/landing.html'; }, 400);
  });

  // Test 4: same-tab redirect to an authentication path (hard veto).
  on('t4', function () {
    say('Test 4: redirecting to a login URL...');
    setTimeout(function () { location.href = OTHER + '/login.html?next=/article.html'; }, 400);
  });
})();
