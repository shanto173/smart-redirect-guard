/*
 * background/tab-monitor.js
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE DOES
 *   LAYER 1: watches for NEW TABS that a page opened (pop-ups / "click opens
 *   an ad tab") and decides whether the new tab looks like an ad.
 *
 * HOW IT WORKS (simple version)
 *   1. When Chrome tells us "tab 42 opened tab 77", we write a small record
 *      for tab 77 (who opened it, which URLs it visited).
 *   2. Every time tab 77 changes URL we add it to the record and ask the
 *      detection engine "is this an ad?".
 *   3. HIGH confidence  -> ask action-manager to close it (after a re-check).
 *      MEDIUM confidence -> only write a log line. Never close.
 *      LOW               -> do nothing.
 *
 * WHY THE RECORDS LIVE IN STORAGE.SESSION
 *   Chrome can stop the service worker at any time. Records are therefore kept
 *   in chrome.storage.session (memory only, never written to disk) and rebuilt
 *   from chrome.tabs.get() if they are missing after a restart.
 *
 * IMPORTANT FOR BEGINNERS
 *   Chrome only delivers events to listeners that were registered while the
 *   worker script was first running. So init() only registers listeners
 *   (synchronously). Each handler then waits for the `ready` function that
 *   the service worker passes in, which finishes setting up storage and rules.
 */
(function (root) {
  'use strict';

  const MAX_HISTORY = 10;
  let initialised = false;
  let readyFn = function () { return Promise.resolve(); };

  // One promise chain per tab so that events for the same tab are handled one
  // at a time (several events often arrive within a few milliseconds).
  const chains = new Map();
  function serial(tabId, fn) {
    const prev = chains.get(tabId) || Promise.resolve();
    const next = prev.then(fn).catch(function (e) { warn('tab ' + tabId, e); });
    chains.set(tabId, next);
    next.then(function () { if (chains.get(tabId) === next) chains.delete(tabId); });
    return next;
  }

  function warn(where, e) {
    try { console.warn('[SRG tab-monitor] ' + where + ':', e && e.message ? e.message : e); } catch (_) { /* ignore */ }
  }

  function validTabId(id) { return typeof id === 'number' && id >= 0; }

  async function lookupUrl(tabId) {
    if (!validTabId(tabId)) return '';
    try {
      const t = await chrome.tabs.get(tabId);
      return (t && (t.url || t.pendingUrl)) || '';
    } catch (e) { return ''; } // opener already closed: tolerated
  }

  function pushUrl(rec, url) {
    if (typeof url !== 'string' || !url) return;
    const h = rec.urlHistory;
    if (h[h.length - 1] === url) return; // ignore consecutive duplicates
    h.push(url);
    if (h.length > MAX_HISTORY) h.splice(0, h.length - MAX_HISTORY);
  }

  function newRecord(openerTabId, openerUrl, url) {
    const rec = {
      openerTabId: validTabId(openerTabId) ? openerTabId : null,
      openerUrl: openerUrl || '',
      createdAt: Date.now(),
      urlHistory: [],
      decided: false,
      srgOpened: false
    };
    pushUrl(rec, url);
    return rec;
  }

  // Get the stored record, or rebuild one after a service-worker restart.
  async function getOrRebuild(tabId) {
    const stored = await SRGStorage.session.getTab(tabId);
    if (stored && Array.isArray(stored.urlHistory)) return stored;
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!tab || !validTabId(tab.openerTabId)) return null; // user-opened tab: not our business
      const rec = newRecord(tab.openerTabId, await lookupUrl(tab.openerTabId), tab.pendingUrl || tab.url);
      await SRGStorage.session.setTab(tabId, rec);
      return rec;
    } catch (e) { return null; }
  }

  function domainOf(url) {
    const p = SRGDetect.parseUrl(url);
    return p.ok ? p.host : '';
  }

  // Ask the engine and act on the verdict. Fails open on every doubt.
  async function evaluate(tabId, rec) {
    if (!rec || rec.decided) return;
    const settings = await SRGStorage.getSettings();
    if (!settings.masterEnabled || !settings.tab.enabled) return;

    const url = rec.urlHistory[rec.urlHistory.length - 1];
    if (!url || SRGDetect.isIgnorableUrl(url)) return;

    // Trusted destination, or a tab opened by a trusted site -> leave alone.
    const destTrusted = await SRGStorage.isTrusted(url, 'tab');
    const openerTrusted = rec.openerUrl ? await SRGStorage.isTrusted(rec.openerUrl, 'tab') : false;
    if (destTrusted || openerTrusted) return;

    const ctx = {
      url: url,
      openerUrl: rec.openerUrl,
      urlHistory: rec.urlHistory,
      createdAt: rec.createdAt,
      now: Date.now(),
      transitionQualifiers: [],
      srgOpened: rec.srgOpened === true,
      trusted: false,
      userGesture: typeof rec.userGesture === 'boolean' ? rec.userGesture : undefined // Chrome does not report it
    };
    const verdict = SRGDetect.classifyTab(ctx);

    if (verdict.confidence === 'high') {
      rec.decided = true;
      await SRGStorage.session.setTab(tabId, rec);
      await SRGAction.closeAdTab(tabId, {
        delayMs: settings.tab.closeDelayMs,
        openerTabId: rec.openerTabId,
        verdict: verdict,
        url: url
      });
    } else if (verdict.confidence === 'medium') {
      rec.decided = true; // do not re-fire on every later URL change
      await SRGStorage.session.setTab(tabId, rec);
      if (settings.tab.mediumAction === 'log') {
        // Medium NEVER closes a tab: it is only written to the activity log.
        await SRGAction.log({
          domain: domainOf(url), layer: 'tab', type: 'ad-tab', action: 'logged',
          confidence: 'medium', detail: verdict.reasons.join(', ')
        });
      }
    }
    // low: nothing to do; the tab may still change URL and be re-evaluated.
  }

  // ---- public handlers ----------------------------------------------------

  function handleCreatedTarget(details) {
    if (!details || !validTabId(details.tabId)) return Promise.resolve();
    return serial(details.tabId, async function () {
      const openerUrl = await lookupUrl(details.sourceTabId);
      let rec = await SRGStorage.session.getTab(details.tabId);
      if (rec && Array.isArray(rec.urlHistory)) {
        if (!rec.openerUrl) rec.openerUrl = openerUrl;
        if (rec.openerTabId === null && validTabId(details.sourceTabId)) rec.openerTabId = details.sourceTabId;
        pushUrl(rec, details.url);
      } else {
        rec = newRecord(details.sourceTabId, openerUrl, details.url);
      }
      await SRGStorage.session.setTab(details.tabId, rec);
      await evaluate(details.tabId, rec);
    });
  }

  function handleTabCreated(tab) {
    if (!tab || !validTabId(tab.id)) return Promise.resolve();
    return serial(tab.id, async function () {
      const existing = await SRGStorage.session.getTab(tab.id);
      if (existing) return; // onCreatedNavigationTarget already recorded it
      if (!validTabId(tab.openerTabId)) return; // not opened by a page
      const rec = newRecord(tab.openerTabId, await lookupUrl(tab.openerTabId), tab.pendingUrl || tab.url);
      await SRGStorage.session.setTab(tab.id, rec);
      await evaluate(tab.id, rec);
    });
  }

  function handleTabUpdated(tabId, changeInfo) {
    if (!validTabId(tabId) || !changeInfo || !changeInfo.url) return Promise.resolve();
    return serial(tabId, async function () {
      const rec = await getOrRebuild(tabId);
      if (!rec) return;
      pushUrl(rec, changeInfo.url);
      await SRGStorage.session.setTab(tabId, rec);
      await evaluate(tabId, rec);
    });
  }

  function handleTabRemoved(tabId) {
    if (!validTabId(tabId)) return Promise.resolve();
    return serial(tabId, async function () {
      try { if (root.SRGAction && SRGAction.cancelPending) SRGAction.cancelPending(tabId); } catch (e) { warn('cancelPending', e); }
      const rec = await SRGStorage.session.getTab(tabId);
      if (rec && !rec.decided && rec.urlHistory && rec.urlHistory.length) SRGStorage.bumpStat('tabsAllowed', 1); // lived and never judged an ad
      await SRGStorage.session.deleteTab(tabId);
    });
  }

  function markSrgOpened(tabId) {
    if (!validTabId(tabId)) return Promise.resolve();
    return serial(tabId, async function () {
      const rec = (await SRGStorage.session.getTab(tabId)) || newRecord(null, '', '');
      rec.srgOpened = true;
      await SRGStorage.session.setTab(tabId, rec);
    });
  }

  async function prune() {
    try {
      const tabs = await chrome.tabs.query({});
      await SRGStorage.session.pruneTabs(tabs.map(function (t) { return t.id; }));
    } catch (e) { warn('prune', e); }
  }

  // Wrap a handler so it waits for setup and can never throw into Chrome.
  function guarded(fn) {
    return function () {
      const args = arguments;
      Promise.resolve().then(readyFn).then(function () { return fn.apply(null, args); }).catch(function (e) { warn('listener', e); });
    };
  }

  function init(opts) {
    if (opts && typeof opts.ready === 'function') readyFn = opts.ready;
    if (initialised) return;
    initialised = true;
    try {
      if (chrome.webNavigation && chrome.webNavigation.onCreatedNavigationTarget) {
        chrome.webNavigation.onCreatedNavigationTarget.addListener(guarded(handleCreatedTarget));
      }
      chrome.tabs.onCreated.addListener(guarded(handleTabCreated));
      chrome.tabs.onUpdated.addListener(guarded(handleTabUpdated));
      chrome.tabs.onRemoved.addListener(guarded(handleTabRemoved));
    } catch (e) { warn('init', e); }
  }

  root.SRGTabMonitor = {
    init: init,
    markSrgOpened: markSrgOpened,
    handleCreatedTarget: handleCreatedTarget,
    handleTabCreated: handleTabCreated,
    handleTabUpdated: handleTabUpdated,
    handleTabRemoved: handleTabRemoved,
    prune: prune
  };
})(typeof self !== 'undefined' ? self : this);
