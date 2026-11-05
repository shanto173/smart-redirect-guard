/*
 * popup/popup.js
 * The toolbar popup. Talks to the service worker only through
 * chrome.runtime.sendMessage({type, payload}). Never touches chrome.storage.
 * Every dynamic node is built with createElement + textContent (no HTML parsing).
 */
(function () {
  'use strict';

  var HOUR_MS = 60 * 60 * 1000;
  var state = { settings: null, stats: null, tab: { id: null, url: '', domain: '' }, trusted: false, trustEntry: null };
  var statusTimer = null;

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  // ---- messaging ----------------------------------------------------------
  // Resolves to the reply or {ok:false,error}. Never rejects. One quick retry
  // covers a service worker that was asleep when the first message arrived.
  function sendOnce(type, payload) {
    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () { if (!done) { done = true; resolve({ ok: false, error: 'timeout' }); } }, 6000);
      function finish(r) { if (done) return; done = true; clearTimeout(timer); resolve(r); }
      try {
        var msg = payload === undefined ? { type: type } : { type: type, payload: payload };
        chrome.runtime.sendMessage(msg, function (reply) {
          var err = chrome.runtime.lastError;
          if (err) { finish({ ok: false, error: err.message || 'worker-unavailable', transient: true }); return; }
          if (reply === undefined || reply === null || typeof reply !== 'object') { finish({ ok: false, error: 'no-reply', transient: true }); return; }
          finish(reply);
        });
      } catch (e) { finish({ ok: false, error: String((e && e.message) || e) }); }
    });
  }
  function send(type, payload) {
    return sendOnce(type, payload).then(function (r) {
      if (r && r.ok === false && r.transient) {
        return new Promise(function (res) { setTimeout(res, 350); }).then(function () { return sendOnce(type, payload); });
      }
      return r;
    });
  }

  function errText(r) {
    var e = r && r.error;
    if (e === 'no-content-script') return 'This page cannot be inspected.';
    if (e === 'timeout' || e === 'no-reply') return 'The extension is not responding. Try again.';
    return 'Something went wrong' + (e ? ' (' + e + ')' : '') + '.';
  }

  function flash(msg, bad) {
    var s = $('status');
    s.textContent = msg;
    s.className = 'toast' + (bad ? ' bad' : '');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(function () { s.textContent = ''; }, 2200);
  }

  function showError(msg) {
    $('error-text').textContent = msg;
    $('error-banner').hidden = false;
  }
  function hideError() { $('error-banner').hidden = true; }

  // ---- helpers ------------------------------------------------------------
  function relTime(ts) {
    if (typeof ts !== 'number') return '';
    var s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    try { return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); } catch (e) { return ''; }
  }

  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
  }

  function isWebUrl(url) { return /^https?:\/\//i.test(url || ''); }

  var PHRASES = {
    tab: { closed: 'Ad tab closed', allowed: 'Tab allowed', logged: 'Suspicious tab noted', restored: 'Tab restored' },
    redirect: { blocked: 'Redirect blocked', logged: 'Redirect detected', allowed: 'Redirect allowed', recovered: 'Went back after a redirect', restored: 'Redirect undone' },
    element: { hidden: 'Ad element hidden', restored: 'Element restored', logged: 'Possible ad element noted', allowed: 'Element left alone' }
  };
  function phrase(row) {
    var l = PHRASES[row.layer];
    if (l && l[row.action]) return l[row.action];
    return (row.layer || 'Activity') + ' ' + (row.action || '');
  }

  function num(n) { return typeof n === 'number' && isFinite(n) ? n : 0; }
  function fmt(n) { try { return num(n).toLocaleString(); } catch (e) { return String(num(n)); } }

  // ---- rendering ----------------------------------------------------------
  function setSwitch(id, on) { $(id).setAttribute('aria-checked', on ? 'true' : 'false'); }

  function applyTheme(settings) {
    var t = settings && settings.ui && settings.ui.theme;
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
  }

  function renderPill() {
    var pill = $('status-pill');
    var s = state.settings;
    var cls = 'pill';
    var text = 'Protected';
    if (s && !s.masterEnabled) { cls += ' pill-paused'; text = 'Paused'; }
    else if (state.trusted) { cls += ' pill-trusted'; text = 'Trusted site'; }
    pill.className = cls;
    $('pill-text').textContent = text;
  }

  function renderSettings() {
    var s = state.settings;
    if (!s) return;
    applyTheme(s);
    setSwitch('sw-master', s.masterEnabled);
    setSwitch('sw-tab', s.tab.enabled);
    setSwitch('sw-redirect', s.redirect.enabled);
    setSwitch('sw-element', s.element.enabled);
    var off = !s.masterEnabled;
    $('layers').classList.toggle('dimmed', off);
    ['sw-tab', 'sw-redirect', 'sw-element'].forEach(function (id) {
      if (off) $(id).setAttribute('aria-disabled', 'true'); else $(id).removeAttribute('aria-disabled');
    });
    $('master-off-note').hidden = !off;
    renderPill();
  }

  function renderStats() {
    var st = state.stats || {};
    $('stat-tabs').textContent = fmt(st.tabsClosed);
    $('stat-redirects').textContent = fmt(num(st.redirectsBlocked) + num(st.redirectsDetected));
    $('stat-elements').textContent = fmt(st.elementsHidden);
  }

  function renderActivity(rows) {
    var list = $('activity-list');
    while (list.firstChild) list.removeChild(list.firstChild);
    $('activity-empty').hidden = rows.length > 0;
    rows.forEach(function (r) {
      var li = el('li', 'act');
      li.appendChild(el('span', 'act-domain', r.domain || '(unknown site)'));
      var conf = ['high', 'medium', 'low'].indexOf(r.confidence) !== -1 ? r.confidence : 'low';
      li.appendChild(el('span', 'chip chip-' + conf, conf));
      li.appendChild(el('span', 'act-what', phrase(r)));
      var t = el('span', 'act-time', relTime(r.ts));
      if (typeof r.ts === 'number') t.title = new Date(r.ts).toLocaleString();
      li.appendChild(t);
      list.appendChild(li);
    });
  }

  function trustSummary() {
    var parts = [];
    var kept = [];
    [['trust-tab', 'close new tabs it opens', 'closing ad tabs'],
     ['trust-redirect', 'block or flag its redirects', 'redirect protection'],
     ['trust-element', 'hide elements on its pages', 'element hiding']].forEach(function (x) {
      if ($(x[0]).checked) parts.push(x[1]); else kept.push(x[2]);
    });
    var d = state.tab.domain || 'this site';
    var msg;
    if (!parts.length) msg = 'Select at least one thing to leave alone.';
    else {
      msg = 'On ' + d + ', SRG will not ' + parts.join(', ').replace(/, ([^,]*)$/, ' or $1') + '.';
      msg += kept.length ? ' It keeps ' + kept.join(', ').replace(/, ([^,]*)$/, ' and $1') + ' active there.' : ' Nothing is protected there while this is on.';
      msg += $('trust-hour').checked ? ' This lasts 1 hour.' : ' This lasts until you remove it.';
    }
    $('trust-summary').textContent = msg;
    $('trust-confirm').disabled = !parts.length;
  }

  function closeTrustPanel() {
    $('trust-panel').hidden = true;
    $('trust-btn').setAttribute('aria-expanded', 'false');
  }

  function renderTrust() {
    var supported = !!state.tab.domain && isWebUrl(state.tab.url);
    $('trust-unsupported').hidden = supported;
    $('trust-main').hidden = !supported;
    if (!supported) return;
    $('trust-domain').textContent = state.tab.domain;
    var btn = $('trust-btn');
    if (state.trusted) {
      btn.textContent = 'Stop trusting this site';
      closeTrustPanel();
    } else {
      btn.textContent = 'Trust this site';
    }
  }

  function renderAll() {
    renderSettings();
    renderStats();
    renderTrust();
  }

  // ---- actions ------------------------------------------------------------
  function updateSettings(partial) {
    return send('SRG_UPDATE_SETTINGS', partial).then(function (r) {
      if (r && r.ok && r.settings) {
        state.settings = r.settings;
        renderSettings();
        flash('Saved');
      } else {
        flash(errText(r), true);
        renderSettings(); // snap back to the last known real state
      }
    });
  }

  function bindSwitch(id, build) {
    $(id).addEventListener('click', function () {
      var cur = this.getAttribute('aria-checked') === 'true';
      updateSettings(build(!cur));
    });
  }

  function onTrustToggle() {
    if (state.trusted) {
      var host = state.tab.domain;
      send('SRG_GET_TRUSTED').then(function (r) {
        var list = r && r.ok && Array.isArray(r.trusted) ? r.trusted : [];
        var hit = null;
        list.forEach(function (e) {
          if (e && typeof e.domain === 'string' && (host === e.domain || host.endsWith('.' + e.domain) || host.replace(/^www\./, '') === e.domain)) hit = e;
        });
        var target = hit ? hit.domain : host;
        return send('SRG_REMOVE_TRUSTED', { domain: target });
      }).then(function (r) {
        if (r && r.ok) { state.trusted = false; renderTrust(); renderPill(); flash('Site is no longer trusted'); }
        else flash(errText(r), true);
      });
      return;
    }
    var panel = $('trust-panel');
    var open = panel.hidden;
    panel.hidden = !open;
    $('trust-btn').setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) { trustSummary(); $('trust-tab').focus(); }
  }

  function onTrustConfirm() {
    var scope = { tab: $('trust-tab').checked, redirect: $('trust-redirect').checked, element: $('trust-element').checked };
    if (!scope.tab && !scope.redirect && !scope.element) { trustSummary(); return; }
    var payload = { domain: state.tab.domain, scope: scope };
    if ($('trust-hour').checked) payload.durationMs = HOUR_MS;
    send('SRG_ADD_TRUSTED', payload).then(function (r) {
      if (r && r.ok) {
        state.trusted = true;
        closeTrustPanel();
        renderTrust();
        renderPill();
        flash('Site trusted');
      } else flash(errText(r), true);
    });
  }

  function openDashboard() {
    try {
      chrome.runtime.openOptionsPage(function () {
        if (chrome.runtime.lastError) {
          try { chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') }); } catch (e) { flash('Could not open the dashboard', true); }
        }
      });
    } catch (e) {
      try { chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') }); } catch (e2) { flash('Could not open the dashboard', true); }
    }
  }

  function onRecover() {
    var btn = $('btn-recover');
    btn.disabled = true;
    send('SRG_RECOVER_TAB', { tabId: state.tab.id }).then(function (r) {
      btn.disabled = false;
      if (r && r.ok) { $('recovery').hidden = true; flash('Went back to the previous page'); }
      else flash('Could not go back. The previous page is no longer available.', true);
    });
  }

  // ---- loading ------------------------------------------------------------
  function queryActiveTab() {
    return new Promise(function (resolve) {
      try {
        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
          var e = chrome.runtime.lastError; // read to silence console noise
          resolve(!e && tabs && tabs[0] ? tabs[0] : null);
        });
      } catch (e) { resolve(null); }
    });
  }

  function loadSecondary() {
    var tabId = state.tab.id;
    var p = [];
    p.push(send('SRG_GET_ACTIVITY', { limit: 5 }).then(function (r) {
      renderActivity(r && r.ok && Array.isArray(r.activity) ? r.activity.slice(0, 5) : []);
    }));
    if (typeof tabId === 'number') {
      p.push(send('SRG_GET_RECOVERY', { tabId: tabId }).then(function (r) {
        var rec = r && r.ok ? r.recovery : null;
        if (rec) {
          var from = hostOf(rec.from) || rec.from || 'the previous page';
          $('recovery-text').textContent = 'Redirected away from ' + from;
          $('recovery').hidden = false;
        } else $('recovery').hidden = true;
      }));
      if (isWebUrl(state.tab.url)) {
        p.push(send('SRG_GET_HIDDEN_ELEMENTS', { tabId: tabId }).then(function (r) {
          var n = r && r.ok && Array.isArray(r.items) ? r.items.length : 0;
          $('hidden-info').hidden = n <= 0;
          if (n > 0) $('hidden-count').textContent = n + (n === 1 ? ' hidden element on this page' : ' hidden elements on this page');
        }));
      }
    }
    return Promise.all(p);
  }

  function load() {
    hideError();
    return queryActiveTab().then(function (tab) {
      if (tab) { state.tab.id = tab.id; state.tab.url = tab.url || ''; state.tab.domain = hostOf(tab.url || ''); }
      return send('SRG_GET_STATE');
    }).then(function (r) {
      $('app').setAttribute('aria-busy', 'false');
      if (!r || !r.ok || !r.settings) {
        $('pill-text').textContent = 'Unavailable';
        $('status-pill').className = 'pill pill-loading';
        showError(errText(r));
        return;
      }
      state.settings = r.settings;
      state.stats = r.stats;
      var at = r.activeTab || {};
      if (!state.tab.domain && at.domain) { state.tab.domain = at.domain; state.tab.url = at.url || state.tab.url; }
      if (typeof state.tab.id !== 'number' && typeof at.id === 'number') state.tab.id = at.id;
      state.trusted = !!at.trusted;
      renderAll();
      return loadSecondary();
    }).catch(function (e) {
      $('app').setAttribute('aria-busy', 'false');
      showError(errText({ error: String((e && e.message) || e) }));
    });
  }

  function init() {
    bindSwitch('sw-master', function (v) { return { masterEnabled: v }; });
    bindSwitch('sw-tab', function (v) { return { tab: { enabled: v } }; });
    bindSwitch('sw-redirect', function (v) { return { redirect: { enabled: v } }; });
    bindSwitch('sw-element', function (v) { return { element: { enabled: v } }; });
    $('trust-btn').addEventListener('click', onTrustToggle);
    $('trust-confirm').addEventListener('click', onTrustConfirm);
    $('trust-cancel').addEventListener('click', function () { closeTrustPanel(); $('trust-btn').focus(); });
    ['trust-tab', 'trust-redirect', 'trust-element', 'trust-hour'].forEach(function (id) { $(id).addEventListener('change', trustSummary); });
    $('btn-dashboard').addEventListener('click', openDashboard);
    $('btn-show-all').addEventListener('click', openDashboard);
    $('btn-recover').addEventListener('click', onRecover);
    $('btn-retry').addEventListener('click', load);
    load();
  }

  init();
})();
