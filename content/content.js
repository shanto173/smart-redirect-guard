/*
 * SRG content.js  -  the coordinator of Layer 3 (in-page ad blocking).
 *
 * WHAT THIS FILE DOES (plain language)
 *   It runs inside every web page (and iframe) and wires the other three content files together:
 *     1. asks the background worker for the current settings and rules,
 *     2. does nothing at all if protection is off or the site is trusted,
 *     3. injects the early "cosmetic" stylesheet for known ad containers,
 *     4. scans the page when it has loaded (and once more shortly after),
 *     5. watches for ads inserted later (via SRG.observer),
 *     6. hides what the detector is confident about, according to the user's settings,
 *     7. reports hidden elements to the worker in batches so the dashboard can list/restore them,
 *     8. answers the worker's SRG_* messages (list, restore, rescan, settings changed).
 *
 * FRAMES
 *   This script also runs in iframes (all_frames). Every frame counts and reports its own hidden
 *   elements; the payload carries `frameId` (0 for the top frame, -1 for a sub frame; the worker
 *   can read the exact id from the message sender) and `isTopFrame`, so the worker decides how to
 *   aggregate. For worker->page messages only the top frame replies (first reply wins in Chrome),
 *   except RESTORE, which a sub frame answers when the element belongs to it.
 *
 * FAIL OPEN
 *   Everything is wrapped in try/catch: an error here must never break the host page.
 */
(function () {
  'use strict';
  try {
    if (window.__srgContentLoaded) { return; }
    window.__srgContentLoaded = true;

    // 1. Only ordinary web pages. This also excludes chrome-extension://, file://, about:, etc.
    if (location.protocol !== 'http:' && location.protocol !== 'https:') { return; }
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) { return; }

    var SRG = window.SRG;
    if (!SRG || !SRG.detector || !SRG.blocker || !SRG.observer) { return; }

    var IS_TOP = (function () { try { return window === window.top; } catch (e) { return false; } })();
    var FRAME_ID = IS_TOP ? 0 : -1;
    var MAX_BATCH_EVAL = 600;
    var MAX_LOGS = 20;

    var cfg = null;              // latest config reply from the worker
    var settingsEl = null;       // settings.element
    var active = false;          // layer 3 currently running
    var domReadyBound = false;
    var followUpTimer = null;
    var reportTimer = null;
    var reportQueue = [];
    var logged = new WeakSet();
    var logCount = 0;

    /* ------------------------ messaging helpers ----------------------- */

    function send(message) {
      try {
        chrome.runtime.sendMessage(message, function () { void chrome.runtime.lastError; });
      } catch (e) { /* worker unavailable: swallow */ }
    }

    function reportRestored(sid) { send({ type: 'SRG_REPORT_ELEMENT_RESTORED', payload: { url: location.href, sid: sid } }); }

    function flushReports() {
      if (reportTimer !== null) { clearTimeout(reportTimer); reportTimer = null; }
      if (!reportQueue.length) { return; }
      var items = reportQueue;
      reportQueue = [];
      send({ type: 'SRG_REPORT_HIDDEN', payload: { url: location.href, frameId: FRAME_ID, isTopFrame: IS_TOP, items: items } });
    }

    function queueReport(item) {
      reportQueue.push(item);
      if (reportTimer === null) { reportTimer = setTimeout(flushReports, 500); }   // one message per ~500 ms
    }

    function logMedium(el, verdict) {
      if (logged.has(el) || logCount >= MAX_LOGS) { return; }
      logged.add(el);
      logCount++;
      send({ type: 'SRG_LOG_ACTIVITY', payload: { domain: location.hostname, layer: 'element', type: 'floating-element',
        action: 'logged', confidence: 'medium', detail: verdict.reasons.join(', ').slice(0, 200) } });
    }

    /* --------------------------- evaluation --------------------------- */

    function evaluate(el, appearedAfterLoad) {
      try {
        if (!active || !el || !el.isConnected || SRG.blocker.wasRestored(el)) { return; }
        var verdict = SRG.detector.score(el, { appearedAfterLoad: appearedAfterLoad });
        var hide = false;
        if (verdict.confidence === 'high') {
          hide = settingsEl.hideHighConfidence !== false;
        } else if (verdict.confidence === 'medium') {
          if (settingsEl.mediumAction === 'hide') { hide = true; }
          else if (settingsEl.mediumAction === 'log') { logMedium(el, verdict); }
        }
        if (!hide) { return; }
        var sid = SRG.blocker.hide(el, verdict);
        if (sid) {
          var info = SRG.blocker.info(sid);
          if (info) { queueReport(info); }
        }
      } catch (e) { /* leave the element alone */ }
    }

    function scan(appearedAfterLoad) {
      if (!active) { return; }
      try {
        var list = SRG.detector.candidates(document);
        for (var i = 0; i < list.length; i++) { evaluate(list[i], appearedAfterLoad); }
      } catch (e) { /* ignore */ }
    }

    /* Observer callback: judge each queued node plus plausible candidates inside it. */
    function handleBatch(nodes) {
      if (!active) { return; }
      var seen = new Set(), todo = [];
      function add(el) { if (!seen.has(el) && todo.length < MAX_BATCH_EVAL) { seen.add(el); todo.push(el); } }
      for (var i = 0; i < nodes.length; i++) {
        add(nodes[i]);
        try {
          if (nodes[i].querySelector) {
            var inner = SRG.detector.candidates(nodes[i]);
            for (var j = 0; j < inner.length; j++) { add(inner[j]); }
          }
        } catch (e) { /* ignore */ }
      }
      for (var k = 0; k < todo.length; k++) { evaluate(todo[k], true); }
    }

    /* ----------------------------- lifecycle -------------------------- */

    function shouldRun() {
      return !!cfg && cfg.enabled !== false && !cfg.trusted && !!settingsEl && settingsEl.enabled !== false;
    }

    function start() {
      if (active) { teardown(false); }
      if (!shouldRun()) { return; }
      active = true;
      SRG.detector.configure({
        selectors: cfg.selectors, allowSelectors: cfg.allowSelectors, adIframeHosts: cfg.adIframeHosts,
        settings: cfg.settings, textHints: cfg.textHints, mediumSelectors: cfg.mediumSelectors,
        highTokens: cfg.highTokens, mediumTokens: cfg.mediumTokens, urlPatterns: cfg.urlPatterns, adDomains: cfg.adDomains
      });
      if (settingsEl.cosmeticCss !== false) {
        SRG.blocker.injectCosmeticCss(SRG.detector.getSelectors().high);   // before first paint
      }
      var onReady = function () {
        if (!active) { return; }
        scan(false);
        SRG.observer.start(handleBatch);
        followUpTimer = setTimeout(function () { followUpTimer = null; scan(true); }, 1500);
      };
      if (document.readyState === 'loading') {
        if (!domReadyBound) {
          domReadyBound = true;
          document.addEventListener('DOMContentLoaded', function () { domReadyBound = false; onReady(); }, { once: true });
        }
      } else {
        onReady();
      }
    }

    /* Stop everything. restoreHidden: also bring back elements we hid (protection switched off). */
    function teardown(restoreHidden) {
      active = false;
      try { SRG.observer.stop(); } catch (e) { /* ignore */ }
      if (followUpTimer !== null) { clearTimeout(followUpTimer); followUpTimer = null; }
      try { SRG.blocker.removeCosmeticCss(); } catch (e) { /* ignore */ }
      if (restoreHidden) {
        var sids = SRG.blocker.list().map(function (r) { return r.sid; });
        SRG.blocker.restoreAll();
        for (var i = 0; i < sids.length; i++) { reportRestored(sids[i]); }
      }
      flushReports();
    }

    function applyConfig(reply) {
      cfg = reply;
      settingsEl = reply && reply.settings && reply.settings.element ? reply.settings.element : null;
      start();
    }

    function requestConfig(attempt) {
      var retry = function () { if (attempt < 1) { setTimeout(function () { requestConfig(attempt + 1); }, 300); } };
      try {
        chrome.runtime.sendMessage({ type: 'SRG_GET_CONFIG', payload: { url: location.href, frameId: FRAME_ID } }, function (reply) {
          var err = chrome.runtime.lastError;   // reading it silences the console warning
          if (err || !reply || reply.ok === false) { retry(); return; }
          try { applyConfig(reply); } catch (e) { /* ignore */ }
        });
      } catch (e) { retry(); }
    }

    /* ----------------------- worker -> page messages ------------------- */

    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      try {
        if (!msg || typeof msg.type !== 'string' || msg.type.indexOf('SRG_') !== 0) { return false; }
        var p = msg.payload || {};
        switch (msg.type) {
          case 'SRG_SETTINGS_CHANGED':
            cfg = cfg || {};
            if (p.enabled !== undefined) { cfg.enabled = p.enabled; }
            if (p.trusted !== undefined) { cfg.trusted = p.trusted; }
            if (p.settings) { cfg.settings = p.settings; }
            settingsEl = cfg.settings && cfg.settings.element ? cfg.settings.element : null;
            if (shouldRun()) { start(); } else { teardown(true); }
            if (IS_TOP) { sendResponse({ ok: true }); return true; }
            return false;
          case 'SRG_LIST_HIDDEN':
            if (IS_TOP) { sendResponse({ ok: true, items: SRG.blocker.list() }); return true; }
            return false;
          case 'SRG_RESTORE': {
            var owns = SRG.blocker.list().some(function (r) { return r.sid === p.sid; });
            if (!owns && !IS_TOP) { return false; }
            var ok = owns && SRG.blocker.restore(p.sid);
            if (ok) { reportRestored(p.sid); }
            sendResponse({ ok: !!ok });
            return true;
          }
          case 'SRG_RESTORE_ALL': {
            var sids = SRG.blocker.list().map(function (r) { return r.sid; });
            var count = SRG.blocker.restoreAll();
            for (var i = 0; i < sids.length; i++) { reportRestored(sids[i]); }
            if (IS_TOP) { sendResponse({ ok: true, count: count }); return true; }
            return false;
          }
          case 'SRG_RESCAN':
            if (active) { scan(true); }
            if (IS_TOP) { sendResponse({ ok: true, hidden: SRG.blocker.hiddenCount() }); return true; }
            return false;
          default:
            return false;
        }
      } catch (e) {
        try { sendResponse({ ok: false }); } catch (e2) { /* ignore */ }
        return false;
      }
    });

    window.addEventListener('pagehide', function () {
      try { SRG.observer.stop(); } catch (e) { /* ignore */ }
      if (followUpTimer !== null) { clearTimeout(followUpTimer); followUpTimer = null; }
      flushReports();
    });

    // Page restored from the back/forward cache: the observer was stopped on pagehide.
    window.addEventListener('pageshow', function (ev) {
      try { if (ev.persisted && active && !SRG.observer.isRunning()) { SRG.observer.start(handleBatch); } } catch (e) { /* ignore */ }
    });

    requestConfig(0);
  } catch (err) {
    /* a content script must never break the host page */
  }
})();
