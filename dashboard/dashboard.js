/*
 * dashboard/dashboard.js
 * The full dashboard (also the extension's options page).
 * Talks to the service worker only through chrome.runtime.sendMessage({type, payload}).
 * Every dynamic node is built with createElement + textContent (no HTML parsing),
 * because domains and activity details come from untrusted web pages.
 */
(function () {
  'use strict';

  var state = { settings: null, stats: null, activity: [], trusted: [], tabsLoaded: false };
  var controls = {};      // settings path -> { kind, inputs, readout, row }
  var pending = {};       // settings path -> debounce timer
  var loaded = {};        // panel name -> has been loaded once
  var statusTimer = null;
  var tickTimer = null;

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  // ---- messaging ----------------------------------------------------------
  // Resolves to the reply or {ok:false,error}. Never rejects. One quick retry
  // covers a service worker that was asleep when the first message arrived.
  function sendOnce(type, payload) {
    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () { if (!done) { done = true; resolve({ ok: false, error: 'timeout' }); } }, 8000);
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

  var ERRORS = {
    'no-content-script': 'This page cannot be inspected. The extension does not run on Chrome system pages.',
    'bad-tab': 'That tab is no longer available.',
    'timeout': 'The extension is not responding. Please try again.',
    'no-reply': 'The extension is not responding. Please try again.',
    'invalid-domain': 'That does not look like a valid domain.',
    'not-an-srg-export': 'That file is not a Smart Redirect Guard export.',
    'unsupported-schema': 'That export was made by a different version and cannot be imported.',
    'invalid-settings': 'The file has no valid settings section.',
    'invalid-trusted': 'The file has no valid trusted-sites section.',
    'invalid-custom-rules': 'The file has no valid custom-rules section.',
    'write-failed': 'The settings could not be saved. Please try again.',
    'export-failed': 'The settings could not be exported.'
  };
  function errText(r) {
    var e = r && r.error;
    if (e && ERRORS[e]) return ERRORS[e];
    return 'Something went wrong' + (e ? ' (' + e + ')' : '') + '.';
  }

  function flash(msg, bad) {
    var s = $('status');
    s.textContent = msg;
    s.className = 'toast' + (bad ? ' bad' : '');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(function () { s.textContent = ''; }, 2500);
  }
  function setMsg(id, msg, bad) {
    var n = $(id);
    n.textContent = msg;
    n.style.color = bad ? 'var(--bad)' : '';
  }

  // ---- small helpers ------------------------------------------------------
  function relTime(ts) {
    if (typeof ts !== 'number') return '';
    var s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    try { return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); } catch (e) { return ''; }
  }
  function fullTime(ts) { try { return new Date(ts).toLocaleString(); } catch (e) { return ''; } }
  function num(n) { return typeof n === 'number' && isFinite(n) ? n : 0; }
  function fmt(n) { try { return num(n).toLocaleString(); } catch (e) { return String(num(n)); } }
  function getPath(obj, path) {
    return path.split('.').reduce(function (o, k) { return o && typeof o === 'object' ? o[k] : undefined; }, obj);
  }
  function nest(path, value) {
    var parts = path.split('.');
    var root = {};
    var cur = root;
    parts.forEach(function (k, i) {
      if (i === parts.length - 1) cur[k] = value;
      else { cur[k] = {}; cur = cur[k]; }
    });
    return root;
  }
  function applyTheme(settings) {
    var t = settings && settings.ui && settings.ui.theme;
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
  }
  function pageError(msg) {
    if (msg) { $('page-error-text').textContent = msg; $('page-error').hidden = false; }
    else $('page-error').hidden = true;
  }
  function queryTabs(filter) {
    return new Promise(function (resolve) {
      try {
        chrome.tabs.query(filter, function (tabs) {
          var e = chrome.runtime.lastError; // read to silence console noise
          resolve(!e && Array.isArray(tabs) ? tabs : []);
        });
      } catch (e) { resolve([]); }
    });
  }
  function confidenceChip(c) {
    var conf = ['high', 'medium', 'low'].indexOf(c) !== -1 ? c : 'low';
    return el('span', 'chip chip-' + conf, conf);
  }
  function td(row, label, content) {
    var c = el('td');
    c.setAttribute('data-label', label);
    if (content && content.nodeType) c.appendChild(content);
    else if (content !== undefined && content !== null) c.textContent = content;
    row.appendChild(c);
    return c;
  }

  // Inline "Are you sure?" pattern (never window.confirm).
  function bindConfirm(btnId, boxId, yesId, noId, action) {
    var btn = $(btnId), box = $(boxId), yes = $(yesId), no = $(noId);
    function close() { box.hidden = true; btn.hidden = false; btn.focus(); }
    btn.addEventListener('click', function () { btn.hidden = true; box.hidden = false; no.focus(); });
    no.addEventListener('click', close);
    box.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
    yes.addEventListener('click', function () {
      yes.disabled = true;
      Promise.resolve(action()).then(function () { yes.disabled = false; box.hidden = true; btn.hidden = false; btn.focus(); });
    });
  }

  // ---- tabs ---------------------------------------------------------------
  function activate(name, focus) {
    var tabs = document.querySelectorAll('.tab');
    Array.prototype.forEach.call(tabs, function (t) {
      var on = t.getAttribute('data-panel') === name;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
      $('panel-' + t.getAttribute('data-panel')).hidden = !on;
      if (on && focus) t.focus();
    });
    if (name === 'overview') loadOverview();
    if (name === 'activity') loadActivity();
    if (name === 'trusted') loadTrusted();
    if (name === 'hidden') loadTabs();
    if (name === 'rules') loadRules();
  }
  function initTabs() {
    var tabs = Array.prototype.slice.call(document.querySelectorAll('.tab'));
    tabs.forEach(function (t, i) {
      t.addEventListener('click', function () { activate(t.getAttribute('data-panel')); });
      t.addEventListener('keydown', function (e) {
        var j = -1;
        if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
        else if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
        else if (e.key === 'Home') j = 0;
        else if (e.key === 'End') j = tabs.length - 1;
        if (j >= 0) { e.preventDefault(); activate(tabs[j].getAttribute('data-panel'), true); }
      });
    });
  }

  // ---- overview -----------------------------------------------------------
  function renderOverview() {
    var st = state.stats || {};
    $('stat-tabsClosed').textContent = fmt(st.tabsClosed);
    $('stat-redirectsBlocked').textContent = fmt(st.redirectsBlocked);
    $('stat-redirectsDetected').textContent = fmt(st.redirectsDetected);
    $('stat-elementsHidden').textContent = fmt(st.elementsHidden);
    var since = '';
    if (st.lastReset) { try { since = 'Counting since ' + new Date(st.lastReset).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) + '.'; } catch (e) { since = ''; } }
    $('stat-since').textContent = since;

    var s = state.settings;
    var box = $('status-summary');
    clear(box);
    if (!s) { box.textContent = 'Status unavailable.'; return; }
    var head = el('strong', null, s.masterEnabled ? 'Protection is on.' : 'Protection is paused.');
    box.appendChild(head);
    var ul = el('ul');
    [['New-tab protection', s.tab.enabled], ['Redirect protection', s.redirect.enabled], ['Element blocking', s.element.enabled]].forEach(function (x) {
      ul.appendChild(el('li', null, x[0] + ': ' + (x[1] ? 'on' : 'off') + (!s.masterEnabled && x[1] ? ' (but paused by the master switch)' : '')));
    });
    box.appendChild(ul);
  }
  function loadOverview() {
    return send('SRG_GET_STATE').then(function (r) {
      if (!r || !r.ok || !r.settings) { pageError(errText(r)); return; }
      pageError('');
      state.settings = r.settings;
      state.stats = r.stats;
      applyTheme(r.settings);
      applySettings();
      renderOverview();
    });
  }

  // ---- settings (built from a table so every control follows one pattern) --
  var SECTIONS = [
    { title: 'Protection', items: [
      { path: 'masterEnabled', kind: 'switch', label: 'Protection', help: 'The master switch. When off, SRG does nothing at all.' }
    ] },
    { title: 'Protection layers', dim: true, items: [
      { path: 'tab.enabled', kind: 'switch', label: 'New-tab protection', help: 'Closes confirmed advertising tabs.' },
      { path: 'redirect.enabled', kind: 'switch', label: 'Redirect protection', help: 'Blocks known ad redirects and offers an undo.' },
      { path: 'element.enabled', kind: 'switch', label: 'Element blocking', help: 'Hides ads inside the page.' }
    ] },
    { title: 'New-tab protection', dim: true, items: [
      { kind: 'delay', path: 'tab.closeDelayMs', label: 'Closing delay', min: 0, max: 10000, step: 100,
        help: 'The delay is not the detection. It gives a new tab a moment for its redirect chain to settle, and the tab is checked again just before it is closed.' },
      { kind: 'check', path: 'tab.reactivateOpener', label: 'Return to the original tab', help: 'After closing an ad tab, switch back to the tab that opened it.' },
      { kind: 'select', path: 'tab.mediumAction', label: 'Uncertain tabs', options: [['log', 'Only note them in the activity list'], ['ignore', 'Ignore them']],
        help: 'Tabs that are only a medium-confidence match are never closed.' }
    ] },
    { title: 'Redirect protection', dim: true, items: [
      { kind: 'note', text: 'Good to know: in Manifest V3 a navigation that has already completed cannot be cancelled. A redirect can only be blocked in advance by a rule, or undone afterwards by you with the Go back button.' },
      { kind: 'check', path: 'redirect.dnrBlocking', label: 'Block known redirects in advance', help: 'Uses network rules to stop listed redirect destinations before the page loads.' },
      { kind: 'check', path: 'redirect.offerRecovery', label: 'Offer to go back', help: 'Shows a Go back button in the popup after a suspicious redirect.' },
      { kind: 'check', path: 'redirect.rememberSafeUrl', label: 'Remember the last safe page', help: 'Keeps the previous address of each tab (in memory only) so Go back knows where to return.' }
    ] },
    { title: 'Element blocking', dim: true, items: [
      { kind: 'check', path: 'element.hideHighConfidence', label: 'Hide high-confidence ads', help: 'Hides elements that clearly match known ad patterns.' },
      { kind: 'check', path: 'element.cosmeticCss', label: 'Hide known ads early', help: 'Injects a style rule as the page starts loading so known ads never flash on screen.' },
      { kind: 'check', path: 'element.floatingDetection', label: 'Floating ads', help: 'Looks for fixed-position boxes that float over the page.' },
      { kind: 'check', path: 'element.overlayDetection', label: 'Overlays', help: 'Looks for large layers that cover most of the page.' },
      { kind: 'check', path: 'element.stickyDetection', label: 'Sticky banners', help: 'Looks for banners stuck to the top or bottom of the screen.' },
      { kind: 'check', path: 'element.iframeDetection', label: 'Ad frames', help: 'Looks for embedded frames that come from known ad hosts.' },
      { kind: 'select', path: 'element.mediumAction', label: 'Medium-confidence elements', options: [['log', 'Only note them (safest)'], ['hide', 'Hide them'], ['ignore', 'Ignore them']],
        help: 'What to do when SRG is only fairly sure something is an ad.' },
      { kind: 'warn', text: 'Warning: Hide is more aggressive and may hide legitimate content, such as a cookie banner you need or part of a login form. That is exactly why every hidden element can be restored from the Hidden elements tab.' }
    ] },
    { title: 'Activity log', items: [
      { kind: 'check', path: 'logging.activityEnabled', label: 'Keep an activity list', help: 'Saves a short list of what SRG did, on this computer only.' },
      { kind: 'number', path: 'logging.maxEntries', label: 'Most entries to keep', min: 10, max: 1000, step: 10, help: 'Older entries are dropped first (10 to 1000).' }
    ] },
    { title: 'Appearance', items: [
      { kind: 'select', path: 'ui.theme', label: 'Theme', options: [['auto', 'Match my system'], ['light', 'Light'], ['dark', 'Dark']], help: 'Choose a light or dark look.' },
      { kind: 'check', path: 'ui.showBadge', label: 'Show the toolbar badge', help: 'Shows a small counter on the extension icon.' }
    ] }
  ];

  var uid = 0;
  function buildSettings() {
    var root = $('settings-root');
    clear(root);
    SECTIONS.forEach(function (sec) {
      var box = el('div', 'box');
      if (sec.dim) box.setAttribute('data-dim', '1');
      box.appendChild(el('h3', null, sec.title));
      sec.items.forEach(function (it) {
        if (it.kind === 'note') { box.appendChild(el('div', 'set-note', it.text)); return; }
        if (it.kind === 'warn') { box.appendChild(el('div', 'set-warn', it.text)); return; }
        uid += 1;
        var id = 'set-' + uid;
        var row = el('div', 'set-row');
        var text = el('div', 'set-text');
        var label = el('label', 'set-label', it.label);
        label.setAttribute('for', id);
        var help = el('div', 'set-help', it.help);
        help.id = id + '-help';
        text.appendChild(label);
        text.appendChild(help);
        var ctl = el('div', 'set-control');
        var c = { kind: it.kind, inputs: [], row: it, readout: null };

        if (it.kind === 'switch' || it.kind === 'check') {
          var cb = el('input', it.kind === 'switch' ? 'sw' : null);
          cb.type = 'checkbox';
          cb.id = id;
          if (it.kind === 'switch') cb.setAttribute('role', 'switch');
          cb.setAttribute('aria-describedby', help.id);
          cb.addEventListener('change', function () { cb.setAttribute('aria-checked', cb.checked ? 'true' : 'false'); saveSetting(it.path, cb.checked); });
          ctl.appendChild(cb);
          c.inputs.push(cb);
        } else if (it.kind === 'select') {
          var sel = el('select');
          sel.id = id;
          sel.setAttribute('aria-describedby', help.id);
          it.options.forEach(function (o) { var op = el('option', null, o[1]); op.value = o[0]; sel.appendChild(op); });
          sel.addEventListener('change', function () { saveSetting(it.path, sel.value); });
          ctl.appendChild(sel);
          c.inputs.push(sel);
        } else if (it.kind === 'number' || it.kind === 'delay') {
          var n = el('input');
          n.type = 'number'; n.id = id; n.min = it.min; n.max = it.max; n.step = it.step;
          n.setAttribute('aria-describedby', help.id);
          c.inputs.push(n);
          var inputs = [n];
          if (it.kind === 'delay') {
            var rng = el('input');
            rng.type = 'range'; rng.min = it.min; rng.max = it.max; rng.step = it.step;
            rng.setAttribute('aria-label', it.label + ' slider');
            c.readout = el('span', 'readout');
            c.readout.setAttribute('aria-hidden', 'true');
            ctl.appendChild(rng);
            ctl.appendChild(n);
            ctl.appendChild(c.readout);
            c.inputs.push(rng);
            inputs.push(rng);
            n.setAttribute('aria-label', it.label + ' in milliseconds');
          } else ctl.appendChild(n);
          inputs.forEach(function (inp) {
            inp.addEventListener('input', function () {
              var v = Number(inp.value);
              if (inp.value === '' || !isFinite(v)) return;
              v = Math.min(it.max, Math.max(it.min, v));
              c.inputs.forEach(function (o) { if (o !== inp) o.value = String(v); });
              if (c.readout) c.readout.textContent = (v / 1000).toFixed(1) + ' s';
              clearTimeout(pending[it.path]);
              pending[it.path] = setTimeout(function () { delete pending[it.path]; saveSetting(it.path, v); }, 300);
            });
            inp.addEventListener('change', function () {
              // Leaving the field: send right away and snap to the clamped value.
              var v = Number(inp.value);
              if (inp.value === '' || !isFinite(v)) { delete pending[it.path]; applySettings(); return; }
              v = Math.min(it.max, Math.max(it.min, v));
              clearTimeout(pending[it.path]);
              delete pending[it.path];
              saveSetting(it.path, v);
            });
          });
        }
        row.appendChild(text);
        row.appendChild(ctl);
        box.appendChild(row);
        controls[it.path] = c;
      });
      root.appendChild(box);
    });
  }

  function applySettings() {
    var s = state.settings;
    if (!s) return;
    applyTheme(s);
    Object.keys(controls).forEach(function (path) {
      var c = controls[path];
      var v = getPath(s, path);
      if (pending[path] !== undefined) return; // the user is still typing in this one
      c.inputs.forEach(function (inp) {
        if (inp.type === 'checkbox') { inp.checked = !!v; inp.setAttribute('aria-checked', v ? 'true' : 'false'); }
        else inp.value = String(v);
      });
      if (c.readout) c.readout.textContent = (num(v) / 1000).toFixed(1) + ' s';
    });
    var off = !s.masterEnabled;
    Array.prototype.forEach.call(document.querySelectorAll('#settings-root .box[data-dim]'), function (b) {
      b.classList.toggle('dimmed', off);
      if (off) b.setAttribute('aria-disabled', 'true'); else b.removeAttribute('aria-disabled');
    });
  }

  function saveSetting(path, value) {
    return send('SRG_UPDATE_SETTINGS', nest(path, value)).then(function (r) {
      if (r && r.ok && r.settings) {
        state.settings = r.settings; // always re-render from the worker's merged copy
        applySettings();
        renderOverview();
        flash('Saved');
      } else {
        flash(errText(r), true);
        applySettings();
      }
    });
  }

  function exportSettings() {
    send('SRG_EXPORT_CONFIG').then(function (r) {
      if (!r || !r.ok || !r.data) { setMsg('import-result', errText(r), true); return; }
      try {
        var blob = new Blob([JSON.stringify(r.data, null, 2)], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'srg-settings-' + new Date().toISOString().slice(0, 10) + '.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        setMsg('import-result', 'Settings exported.', false);
      } catch (e) { setMsg('import-result', 'The file could not be created.', true); }
    });
  }

  function importSettings(file) {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { setMsg('import-result', 'That file is too large to be an SRG export.', true); return; }
    var reader = new FileReader();
    reader.onerror = function () { setMsg('import-result', 'The file could not be read.', true); };
    reader.onload = function () {
      var data;
      try { data = JSON.parse(String(reader.result)); } catch (e) { setMsg('import-result', 'That file is not valid JSON.', true); return; }
      send('SRG_IMPORT_CONFIG', { data: data }).then(function (r) {
        if (r && r.ok) {
          if (r.settings) state.settings = r.settings;
          applySettings();
          renderOverview();
          loaded.trusted = false; loaded.rules = false;
          loadTrusted(); loadRules();
          setMsg('import-result', 'Settings imported.', false);
          flash('Imported');
        } else setMsg('import-result', 'Import failed: ' + errText(r), true);
      });
    };
    reader.readAsText(file);
  }

  // ---- activity -----------------------------------------------------------
  var LAYER_NAMES = { tab: 'New tab', redirect: 'Redirect', element: 'Element' };
  function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }

  function renderActivity() {
    var all = state.activity;
    var q = $('f-domain').value.trim().toLowerCase();
    var layer = $('f-layer').value;
    var conf = $('f-conf').value;
    var rows = all.filter(function (r) {
      return (!q || String(r.domain || '').toLowerCase().indexOf(q) !== -1) && (!layer || r.layer === layer) && (!conf || r.confidence === conf);
    });
    var body = $('activity-body');
    clear(body);
    var empty = $('activity-empty');
    if (!rows.length) {
      empty.textContent = all.length ? 'No activity matches these filters.' : 'Nothing blocked yet on this browser.';
      empty.hidden = false;
      $('activity-table').hidden = true;
    } else {
      empty.hidden = true;
      $('activity-table').hidden = false;
      rows.forEach(function (r) {
        var tr = el('tr');
        var t = el('time', null, relTime(r.ts));
        if (typeof r.ts === 'number') { t.title = fullTime(r.ts); t.dateTime = new Date(r.ts).toISOString(); }
        td(tr, 'Time', t);
        td(tr, 'Domain', r.domain || '(unknown)');
        td(tr, 'Layer', LAYER_NAMES[r.layer] || cap(r.layer));
        var typeCell = td(tr, 'Type', cap(String(r.type || '').replace(/-/g, ' ')));
        if (r.detail) typeCell.title = String(r.detail);
        td(tr, 'Action', cap(r.action));
        td(tr, 'Confidence', confidenceChip(r.confidence));
        body.appendChild(tr);
      });
    }
    $('activity-count').textContent = all.length ? 'Showing ' + rows.length + ' of ' + all.length : '';
  }

  function loadActivity() {
    return send('SRG_GET_ACTIVITY', { limit: 200 }).then(function (r) {
      if (!r || !r.ok || !Array.isArray(r.activity)) { flash(errText(r), true); return; }
      state.activity = r.activity;
      renderActivity();
    });
  }

  // ---- trusted sites ------------------------------------------------------
  var SCOPE_NAMES = { tab: 'New tabs', redirect: 'Redirects', element: 'Element blocking' };

  function remaining(ms) {
    if (ms <= 0) return 'expired';
    var m = Math.ceil(ms / 60000);
    if (m < 60) return m + ' min left';
    var h = Math.floor(m / 60);
    if (h < 24) return h + ' h ' + (m % 60) + ' min left';
    return Math.floor(h / 24) + ' d ' + (h % 24) + ' h left';
  }

  function buildTrustActions(cell, domain) {
    clear(cell);
    var rm = el('button', 'btn btn-small', 'Remove');
    rm.type = 'button';
    rm.setAttribute('aria-label', 'Remove ' + domain + ' from trusted sites');
    rm.addEventListener('click', function () {
      clear(cell);
      var wrap = el('span', 'confirm');
      wrap.setAttribute('role', 'group');
      wrap.appendChild(el('span', null, 'Remove? '));
      var yes = el('button', 'btn btn-danger btn-small', 'Yes');
      yes.type = 'button';
      var no = el('button', 'btn btn-small', 'Cancel');
      no.type = 'button';
      wrap.appendChild(yes); wrap.appendChild(no);
      cell.appendChild(wrap);
      no.focus();
      no.addEventListener('click', function () { buildTrustActions(cell, domain); });
      yes.addEventListener('click', function () {
        yes.disabled = true;
        send('SRG_REMOVE_TRUSTED', { domain: domain }).then(function (r) {
          if (r && r.ok) { state.trusted = Array.isArray(r.trusted) ? r.trusted : state.trusted.filter(function (e) { return e.domain !== domain; }); renderTrusted(); flash('Removed ' + domain); }
          else { flash(errText(r), true); buildTrustActions(cell, domain); }
        });
      });
    });
    cell.appendChild(rm);
  }

  function renderTrusted() {
    var list = state.trusted;
    var body = $('trusted-body');
    clear(body);
    $('trusted-empty').hidden = list.length > 0;
    $('trusted-table').hidden = list.length === 0;
    list.forEach(function (e) {
      var tr = el('tr');
      td(tr, 'Domain', e.domain);
      var chips = el('span');
      var any = false;
      ['tab', 'redirect', 'element'].forEach(function (k) {
        if (e.scope && e.scope[k]) { chips.appendChild(el('span', 'chip chip-scope', SCOPE_NAMES[k])); any = true; }
      });
      if (!any) chips.textContent = 'Nothing (no layer exempted)';
      td(tr, 'Left alone', chips);
      var added = td(tr, 'Added', typeof e.addedAt === 'number' ? relTime(e.addedAt) : '');
      if (typeof e.addedAt === 'number') added.title = fullTime(e.addedAt);
      var exp = td(tr, 'Expires', typeof e.expiresAt === 'number' ? remaining(e.expiresAt - Date.now()) : 'Permanent');
      if (typeof e.expiresAt === 'number') exp.setAttribute('data-expires', String(e.expiresAt));
      var actions = td(tr, 'Actions', null);
      buildTrustActions(actions, e.domain);
      body.appendChild(tr);
    });
  }

  function tickTrusted() {
    var expired = false;
    Array.prototype.forEach.call(document.querySelectorAll('#trusted-body td[data-expires]'), function (cell) {
      var left = Number(cell.getAttribute('data-expires')) - Date.now();
      cell.textContent = remaining(left);
      if (left <= 0) expired = true;
    });
    if (expired) loadTrusted();
  }

  function loadTrusted() {
    return send('SRG_GET_TRUSTED').then(function (r) {
      if (!r || !r.ok || !Array.isArray(r.trusted)) { flash(errText(r), true); return; }
      state.trusted = r.trusted;
      renderTrusted();
    });
  }

  // Returns {domain} or {error}. Helpfully strips a scheme, credentials, port and path.
  function parseDomain(raw) {
    var d = String(raw || '').trim();
    if (!d) return { error: 'Please type a domain, for example example.com.' };
    if (/\s/.test(d)) return { error: 'A domain cannot contain spaces.' };
    d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    if (/^[a-z][a-z0-9+.-]*:/i.test(d) && !/^[^/]*:\d+/.test(d)) return { error: 'Please type just the domain, without a scheme like mailto:.' };
    d = d.split(/[/?#]/)[0];
    d = d.replace(/^[^@]*@/, '').replace(/:\d+$/, '').toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
    if (!d) return { error: 'Please type a domain, for example example.com.' };
    if (d.length > 253 || !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(d) || d.indexOf('..') !== -1) return { error: 'That does not look like a valid domain.' };
    if (d.indexOf('.') === -1 && d !== 'localhost') return { error: 'A domain needs a dot, for example example.com.' };
    return { domain: d };
  }

  function onAddTrusted(ev) {
    ev.preventDefault();
    var p = parseDomain($('add-domain').value);
    if (p.error) { setMsg('add-msg', p.error, true); return; }
    var scope = { tab: $('add-tab').checked, redirect: $('add-redirect').checked, element: $('add-element').checked };
    if (!scope.tab && !scope.redirect && !scope.element) { setMsg('add-msg', 'Choose at least one thing for SRG to leave alone.', true); return; }
    var payload = { domain: p.domain, scope: scope };
    var dur = Number($('add-duration').value);
    if (dur > 0) payload.durationMs = dur;
    $('btn-add-trusted').disabled = true;
    send('SRG_ADD_TRUSTED', payload).then(function (r) {
      $('btn-add-trusted').disabled = false;
      if (r && r.ok) {
        if (Array.isArray(r.trusted)) { state.trusted = r.trusted; renderTrusted(); } else loadTrusted();
        $('add-domain').value = '';
        setMsg('add-msg', 'Added ' + p.domain + '.', false);
        flash('Saved');
      } else setMsg('add-msg', errText(r), true);
    });
  }

  // ---- hidden elements ----------------------------------------------------
  function selectedTabId() {
    var v = $('hidden-tab-select').value;
    return v === '' ? null : Number(v);
  }
  function setHiddenButtons(on) {
    ['btn-rescan', 'btn-restore-all'].forEach(function (id) { $(id).disabled = !on; });
  }
  function renderHidden(items) {
    var body = $('hidden-body');
    clear(body);
    $('hidden-table').hidden = items.length === 0;
    items.forEach(function (it) {
      var tr = el('tr');
      td(tr, 'Element', it.label || '(unnamed element)');
      td(tr, 'Confidence', confidenceChip(it.confidence));
      td(tr, 'Reason', it.reason || '');
      var cell = td(tr, 'Actions', null);
      var b = el('button', 'btn btn-small', 'Restore');
      b.type = 'button';
      b.setAttribute('aria-label', 'Restore ' + (it.label || 'element'));
      b.addEventListener('click', function () {
        b.disabled = true;
        send('SRG_RESTORE_ELEMENT', { tabId: selectedTabId(), sid: it.sid }).then(function (r) {
          if (r && r.ok) { setMsg('hidden-msg', 'Element restored.', false); loadHidden(); }
          else { b.disabled = false; setMsg('hidden-msg', errText(r), true); }
        });
      });
      cell.appendChild(b);
      body.appendChild(tr);
    });
  }
  function loadHidden() {
    var id = selectedTabId();
    if (id === null) { renderHidden([]); setHiddenButtons(false); return Promise.resolve(); }
    return send('SRG_GET_HIDDEN_ELEMENTS', { tabId: id }).then(function (r) {
      if (r && r.ok && Array.isArray(r.items)) {
        setHiddenButtons(true);
        renderHidden(r.items);
        if (!r.items.length) setMsg('hidden-msg', 'Nothing is hidden on this page.', false);
        else if ($('hidden-msg').style.color) setMsg('hidden-msg', '', false);
      } else {
        renderHidden([]);
        setHiddenButtons(false);
        setMsg('hidden-msg', r && r.error === 'no-content-script' ? ERRORS['no-content-script'] : errText(r), true);
      }
    });
  }
  function loadTabs() {
    var sel = $('hidden-tab-select');
    var prev = sel.value;
    return queryTabs({ url: ['http://*/*', 'https://*/*'] }).then(function (tabs) {
      clear(sel);
      if (!tabs.length) {
        var none = el('option', null, 'No open web pages');
        none.value = '';
        sel.appendChild(none);
        renderHidden([]);
        setHiddenButtons(false);
        setMsg('hidden-msg', 'Open a website in another tab, then press Refresh tabs.', false);
        return;
      }
      tabs.forEach(function (t) {
        var host = '';
        try { host = new URL(t.url).hostname; } catch (e) { host = ''; }
        var title = String(t.title || host || 'Untitled');
        if (title.length > 60) title = title.slice(0, 57) + '...';
        var o = el('option', null, title + (host ? ' (' + host + ')' : ''));
        o.value = String(t.id);
        sel.appendChild(o);
      });
      if (prev && Array.prototype.some.call(sel.options, function (o) { return o.value === prev; })) sel.value = prev;
      setMsg('hidden-msg', '', false);
      return loadHidden();
    });
  }

  // ---- custom rules -------------------------------------------------------
  var RULES = [
    { key: 'adDomains', kind: 'domain', label: 'Ad domains', help: 'Sites that only serve ads. Requests to them are treated as ads. One domain per line, no https:// and no path.', ph: 'ads.example.test\ntracker.example.test' },
    { key: 'suspiciousDomains', kind: 'domain', label: 'Suspicious domains', help: 'Sites that make a redirect or new tab look suspicious (not an automatic block). One domain per line.', ph: 'offers.example.test' },
    { key: 'urlPatterns', kind: 'pattern', label: 'URL patterns', help: 'Parts of an address that mark it as an ad, such as a path word. One per line, no spaces.', ph: '/click-track/\nutm_ad=' },
    { key: 'selectors', kind: 'selector', label: 'Hide these elements', help: 'CSS selectors for page elements to hide. One per line. The characters { } and @ are not allowed.', ph: '.promo-popup\n#sponsored-banner\ndiv[data-ad="true"]' },
    { key: 'allowSelectors', kind: 'selector', label: 'Never hide these elements', help: 'CSS selectors SRG must always leave alone, even if they look like ads. One per line.', ph: '.site-header\n#cookie-settings' }
  ];

  function buildRules() {
    var root = $('rules-root');
    clear(root);
    RULES.forEach(function (d) {
      var block = el('div', 'box rule-block');
      var lab = el('label', 'set-label', d.label);
      lab.setAttribute('for', 'rule-' + d.key);
      var help = el('div', 'set-help', d.help);
      help.id = 'rule-' + d.key + '-help';
      var ta = el('textarea');
      ta.id = 'rule-' + d.key;
      ta.rows = 5;
      ta.placeholder = d.ph;
      ta.spellcheck = false;
      ta.setAttribute('aria-describedby', help.id);
      block.appendChild(lab); block.appendChild(help); block.appendChild(ta);
      root.appendChild(block);
    });
  }

  function loadRules() {
    return send('SRG_GET_CUSTOM_RULES').then(function (r) {
      if (!r || !r.ok || !r.customRules) { setMsg('rules-msg', errText(r), true); return; }
      fillRules(r.customRules);
    });
  }
  function fillRules(rules) {
    RULES.forEach(function (d) {
      var list = Array.isArray(rules[d.key]) ? rules[d.key] : [];
      $('rule-' + d.key).value = list.join('\n');
    });
  }

  function checkLine(kind, line) {
    if (line.length > 253) return 'is longer than 253 characters';
    if (kind === 'domain') {
      if (/^[a-z][a-z0-9+.-]*:/i.test(line)) return 'contains a scheme (remove "https://" or similar)';
      if (line.indexOf('/') !== -1) return 'contains a slash (use only the domain, no path)';
      if (/\s/.test(line)) return 'contains a space';
      return null;
    }
    if (kind === 'selector') {
      if (/[\r\n]/.test(line)) return 'contains a line break';
      if (/[{}@]/.test(line)) return 'contains { } or @, which are not allowed in a selector';
      try { document.createDocumentFragment().querySelector(line); } catch (e) { return 'is not a valid CSS selector'; }
      return null;
    }
    if (/\s/.test(line)) return 'contains a space';
    return null;
  }

  function saveRules() {
    var out = {};
    var errors = [];
    var dupes = 0;
    RULES.forEach(function (d) {
      var seen = {};
      var list = [];
      $('rule-' + d.key).value.split('\n').forEach(function (raw, i) {
        var line = raw.trim();
        if (!line) return;
        if (d.kind === 'domain') line = line.toLowerCase();
        var why = checkLine(d.kind, line);
        if (why) { errors.push({ list: d.label, n: i + 1, text: line, why: why }); return; }
        if (seen[line]) { dupes += 1; return; }
        seen[line] = true;
        list.push(line);
      });
      out[d.key] = list;
    });
    var box = $('rules-errors');
    clear(box);
    if (errors.length) {
      box.appendChild(el('strong', null, 'Nothing was saved. ' + errors.length + (errors.length === 1 ? ' line was' : ' lines were') + ' rejected:'));
      var ul = el('ul');
      errors.forEach(function (e) { ul.appendChild(el('li', null, e.list + ', line ' + e.n + ': "' + e.text + '" ' + e.why + '.')); });
      box.appendChild(ul);
      box.appendChild(el('span', null, 'Fix these lines and press Save rules again.'));
      box.hidden = false;
      setMsg('rules-msg', '', false);
      return;
    }
    box.hidden = true;
    $('btn-save-rules').disabled = true;
    send('SRG_UPDATE_CUSTOM_RULES', { customRules: out }).then(function (r) {
      $('btn-save-rules').disabled = false;
      if (r && r.ok && r.customRules) {
        fillRules(r.customRules);
        setMsg('rules-msg', 'Rules saved.' + (dupes ? ' ' + dupes + ' duplicate ' + (dupes === 1 ? 'line was' : 'lines were') + ' merged.' : ''), false);
        flash('Saved');
      } else setMsg('rules-msg', errText(r), true);
    });
  }

  // ---- init ---------------------------------------------------------------
  function init() {
    initTabs();
    buildSettings();
    buildRules();

    bindConfirm('btn-reset', 'reset-confirm', 'reset-yes', 'reset-no', function () {
      return send('SRG_RESET_STATS').then(function (r) {
        if (r && r.ok) { if (r.stats) state.stats = r.stats; renderOverview(); flash('Statistics reset'); }
        else flash(errText(r), true);
      });
    });
    bindConfirm('btn-clear', 'clear-confirm', 'clear-yes', 'clear-no', function () {
      return send('SRG_CLEAR_ACTIVITY').then(function (r) {
        if (r && r.ok) { state.activity = []; renderActivity(); flash('History cleared'); }
        else flash(errText(r), true);
      });
    });

    $('f-domain').addEventListener('input', renderActivity);
    $('f-layer').addEventListener('change', renderActivity);
    $('f-conf').addEventListener('change', renderActivity);
    $('btn-activity-refresh').addEventListener('click', loadActivity);

    $('btn-export').addEventListener('click', exportSettings);
    $('btn-import').addEventListener('click', function () { $('import-file').click(); });
    $('import-file').addEventListener('change', function () {
      var f = this.files && this.files[0];
      importSettings(f);
      this.value = '';
    });

    $('trust-form').addEventListener('submit', onAddTrusted);

    $('hidden-tab-select').addEventListener('change', loadHidden);
    $('btn-refresh-tabs').addEventListener('click', loadTabs);
    $('btn-rescan').addEventListener('click', function () {
      var id = selectedTabId();
      if (id === null) return;
      send('SRG_RESCAN_TAB', { tabId: id }).then(function (r) {
        if (r && r.ok) { setMsg('hidden-msg', 'Page re-scanned.', false); loadHidden(); }
        else setMsg('hidden-msg', errText(r), true);
      });
    });
    $('btn-restore-all').addEventListener('click', function () {
      var id = selectedTabId();
      if (id === null) return;
      send('SRG_RESTORE_ALL_ELEMENTS', { tabId: id }).then(function (r) {
        if (r && r.ok) { setMsg('hidden-msg', 'Restored ' + num(r.count) + (num(r.count) === 1 ? ' element.' : ' elements.'), false); loadHidden(); }
        else setMsg('hidden-msg', errText(r), true);
      });
    });

    $('btn-save-rules').addEventListener('click', saveRules);
    $('btn-retry').addEventListener('click', function () { loadOverview(); });

    tickTimer = setInterval(tickTrusted, 30000);
    setHiddenButtons(false);
    loadOverview();
  }

  init();
})();
