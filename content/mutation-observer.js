/*
 * SRG mutation-observer.js  -  "Notice ads that appear AFTER the page has loaded."
 *
 * WHAT THIS FILE DOES (plain language)
 *   Many sites show their real content first and inject advertisements seconds later. This file
 *   watches the page for newly added or changed elements and hands them, in small batches, to a
 *   callback (set up by content.js) that judges and hides them.
 *
 * WHY IT IS WRITTEN SO CAREFULLY
 *   A badly written observer can freeze a page: it can react to its own changes forever, or be
 *   flooded by a site that adds thousands of nodes. Every numbered "LOOP SAFETY" comment below
 *   is one protection against that.
 */
(function () {
  'use strict';

  window.SRG = window.SRG || {};
  var SRG = window.SRG;

  var OBSERVE_OPTIONS = { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'id'] };
  var NORMAL_DEBOUNCE_MS = 150;
  var BACKOFF_DEBOUNCE_MS = 1000;
  var FORCE_FLUSH_SIZE = 300;
  var BUDGET_NODES = 1500;
  var BUDGET_WINDOW_MS = 10000;
  var ATTR_REEVAL_MS = 2000;
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, LINK: 1, META: 1, HEAD: 1, TEMPLATE: 1, BR: 1, NOSCRIPT: 1 };

  var mo = null;
  var running = false;
  var onBatch = null;
  var pending = null;           // Set of elements waiting for the next flush
  var processed = new WeakSet();// elements already handled (childList path)
  var attrSeen = new WeakMap(); // element -> last time an attribute change re-queued it
  var timer = null;
  var idleHandle = null;
  var idleIsTimeout = false;
  var debounceMs = NORMAL_DEBOUNCE_MS;
  var history = [];             // [{t, n}] nodes processed recently, for the budget
  var loggedBackoff = false;
  var pagehideBound = false;
  var counts = { processed: 0, batches: 0, backoff: false };

  function enqueue(node, fromAttribute) {
    // LOOP SAFETY 3: only real elements; skip tags that can never be ads.
    if (!node || node.nodeType !== 1 || SKIP_TAGS[node.tagName]) { return; }
    // LOOP SAFETY 4: ignore our own stylesheet and anything we hid (or inside something we hid).
    if (node.id === 'srg-cosmetic' || node.hasAttribute('data-srg-hidden')) { return; }
    try { if (node.closest('#srg-cosmetic, [data-srg-hidden]')) { return; } } catch (e) { return; }
    if (fromAttribute) {
      // A class/style change can turn a harmless div into a floating overlay, so a changed
      // element may be looked at again, but at most once per ATTR_REEVAL_MS (stops page
      // animations that toggle classes constantly from causing endless work).
      var now = Date.now(), last = attrSeen.get(node) || 0;
      if (now - last < ATTR_REEVAL_MS) { return; }
      attrSeen.set(node, now);
    } else if (processed.has(node)) {
      // LOOP SAFETY 2: never queue the same newly added element twice.
      return;
    }
    pending.add(node);
  }

  function onMutations(records) {
    // LOOP SAFETY 1: changes made by SRG itself are ignored.
    if (!running || (SRG.blocker && SRG.blocker.isSuppressed())) { return; }
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      if (r.type === 'attributes') {
        enqueue(r.target, true);      // attribute mutations queue ONLY the target element
      } else if (r.type === 'childList') {
        for (var j = 0; j < r.addedNodes.length; j++) { enqueue(r.addedNodes[j], false); }
      }
    }
    schedule();
  }

  function schedule() {
    if (!running || !pending || pending.size === 0) { return; }
    clearTimer();
    // LOOP SAFETY 5: debounce (wait for quiet) but force a flush if the burst is huge.
    var wait = pending.size >= FORCE_FLUSH_SIZE ? 0 : debounceMs;
    timer = setTimeout(function () { timer = null; flush(); }, wait);
  }

  function clearTimer() { if (timer !== null) { clearTimeout(timer); timer = null; } }

  function clearIdle() {
    if (idleHandle !== null) {
      if (idleIsTimeout) { clearTimeout(idleHandle); }
      else if (typeof cancelIdleCallback === 'function') { cancelIdleCallback(idleHandle); }
      idleHandle = null;
    }
  }

  function flush() {
    // Nothing to do, or a run is already scheduled.
    if (!running || !pending || pending.size === 0 || idleHandle !== null) { return; }
    // LOOP SAFETY 6: do the real work when the browser is idle so scrolling stays smooth.
    var run = function () {
      idleHandle = null;
      if (!running || !pending) { return; }
      var nodes = Array.from(pending);
      pending.clear();
      for (var i = 0; i < nodes.length; i++) { processed.add(nodes[i]); }
      accountBudget(nodes.length);
      counts.processed += nodes.length;
      counts.batches++;
      try { if (onBatch) { onBatch(nodes); } } catch (e) { /* never break the page */ }
      if (running && pending && pending.size > 0) { schedule(); }
    };
    if (typeof requestIdleCallback === 'function') {
      idleIsTimeout = false;
      idleHandle = requestIdleCallback(run, { timeout: 1000 });
    } else {
      idleIsTimeout = true;
      idleHandle = setTimeout(run, 50);
    }
  }

  /* LOOP SAFETY 7: hard budget. Too many nodes in 10 s means a pathological page, so slow down. */
  function accountBudget(n) {
    var now = Date.now(), total = n;
    history.push({ t: now, n: n });
    while (history.length && now - history[0].t > BUDGET_WINDOW_MS) { history.shift(); }
    for (var i = 0; i < history.length - 1; i++) { total += history[i].n; }
    if (total > BUDGET_NODES) {
      debounceMs = BACKOFF_DEBOUNCE_MS;
      counts.backoff = true;
      if (!loggedBackoff) {
        loggedBackoff = true;
        try { console.debug('[SRG] very busy page: element scanning slowed down'); } catch (e) { /* ignore */ }
      }
    } else if (counts.backoff && total < BUDGET_NODES / 3) {
      debounceMs = NORMAL_DEBOUNCE_MS;
      counts.backoff = false;
    }
  }

  function onPageHide() { stop(); }

  function start(callback) {
    if (running) { return true; }
    if (typeof MutationObserver !== 'function' || !document.documentElement) { return false; }
    onBatch = typeof callback === 'function' ? callback : null;
    pending = new Set();
    processed = new WeakSet();
    attrSeen = new WeakMap();
    history = [];
    debounceMs = NORMAL_DEBOUNCE_MS;
    counts = { processed: 0, batches: 0, backoff: false };
    loggedBackoff = false;
    mo = new MutationObserver(onMutations);
    mo.observe(document.documentElement, OBSERVE_OPTIONS);
    running = true;
    if (!pagehideBound) {
      // LOOP SAFETY 8: disconnect when the page is going away.
      window.addEventListener('pagehide', onPageHide);
      pagehideBound = true;
    }
    return true;
  }

  function stop() {
    running = false;
    if (mo) { try { mo.disconnect(); } catch (e) { /* ignore */ } mo = null; }
    clearTimer();
    clearIdle();
    if (pending) { pending.clear(); }
    pending = null;
    onBatch = null;
  }

  function isRunning() { return running; }

  /* Called by SRG.blocker.suppress() so our own DOM writes never reach onMutations. */
  function discardPending() {
    if (mo) { try { mo.takeRecords(); } catch (e) { /* ignore */ } }
  }

  /* Called just BEFORE we write to the DOM: handle genuine page mutations that are still
     waiting, so the discard that follows our write cannot throw them away. */
  function drainPending() {
    if (mo && running) {
      var recs = [];
      try { recs = mo.takeRecords(); } catch (e) { /* ignore */ }
      if (recs.length) { onMutations(recs); }
    }
  }

  function stats() {
    return { processed: counts.processed, batches: counts.batches, queued: pending ? pending.size : 0, backoff: counts.backoff };
  }

  SRG.observer = { start: start, stop: stop, isRunning: isRunning, stats: stats, discardPending: discardPending, drainPending: drainPending };
})();
