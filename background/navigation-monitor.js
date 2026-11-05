/*
 * background/navigation-monitor.js
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE DOES
 *   LAYER 2: watches what happens INSIDE a tab when the page navigates away
 *   (for example a script sets location.href to an ad site) and remembers the
 *   "last safe URL" so the user can go back with one click.
 *
 * WHAT IT CAN AND CANNOT DO (honest version)
 *   chrome.webNavigation events are notifications only. By the time we hear
 *   about a navigation it is already happening, and Chrome Manifest V3 has no
 *   way to cancel it from here. Real prevention comes from the DNR rules in
 *   rules/rules.json. This file therefore:
 *     - notices when a DNR rule blocked a navigation (net::ERR_BLOCKED_BY_CLIENT),
 *     - classifies navigations that went through, and for suspicious ones it
 *       stores "recovery" info so the popup can offer a "Go back" button,
 *     - NEVER navigates automatically. Cross-site redirects are normal for
 *       sign-in and payment flows.
 *
 * NOTES
 *   - Only the top frame (frameId 0) is looked at.
 *   - The short-lived timing info (chain length, time since last navigation)
 *     is kept in memory. If the worker restarts we simply lose it, which makes
 *     the scoring more cautious, never more aggressive. The durable data
 *     (safe URL, recovery) lives in chrome.storage.session.
 *   - Actual tab navigation (going back) is done by SRGAction.navigateBack so
 *     that action-manager stays the only file with side effects.
 */
(function (root) {
  'use strict';

  const CHAIN_WINDOW_MS = 5000; // navigations closer together than this count as one chain
  let initialised = false;
  let readyFn = function () { return Promise.resolve(); };

  // tabId -> { chainLength, lastTs, timeSinceLastNav, previousUrl }
  const navState = new Map();
  const chains = new Map();

  function warn(where, e) {
    try { console.warn('[SRG nav-monitor] ' + where + ':', e && e.message ? e.message : e); } catch (_) { /* ignore */ }
  }

  function serial(tabId, fn) {
    const prev = chains.get(tabId) || Promise.resolve();
    const next = prev.then(fn).catch(function (e) { warn('tab ' + tabId, e); });
    chains.set(tabId, next);
    next.then(function () { if (chains.get(tabId) === next) chains.delete(tabId); });
    return next;
  }

  function isTopFrame(d) {
    return d && d.frameId === 0 && typeof d.tabId === 'number' && d.tabId >= 0;
  }

  function isWebUrl(url) {
    const p = SRGDetect.parseUrl(url);
    return p.ok && (p.protocol === 'http:' || p.protocol === 'https:') && !!p.host;
  }

  // Transitions the user started themselves (typing, bookmarks, reload ...).
  const USER_TRANSITIONS = ['typed', 'auto_bookmark', 'generated', 'keyword', 'keyword_generated', 'start_page', 'reload'];
  function isUserInitiated(d) {
    const q = Array.isArray(d.transitionQualifiers) ? d.transitionQualifiers : [];
    return USER_TRANSITIONS.indexOf(d.transitionType) !== -1 || q.indexOf('from_address_bar') !== -1;
  }

  async function currentSafeUrl(tabId) {
    const safe = await SRGStorage.session.getSafeUrl(tabId);
    if (safe) return safe;
    try { // nothing remembered yet (e.g. worker restarted): use what the tab shows now
      const t = await chrome.tabs.get(tabId);
      if (t && isWebUrl(t.url)) return t.url;
    } catch (e) { /* tab gone */ }
    return '';
  }

  async function protectionActive() {
    const s = await SRGStorage.getSettings();
    return s.masterEnabled && s.redirect.enabled ? s : null;
  }

  // ---- public handlers ----------------------------------------------------

  function handleBeforeNavigate(d) {
    if (!isTopFrame(d) || SRGDetect.isIgnorableUrl(d.url)) return Promise.resolve();
    return serial(d.tabId, async function () {
      const now = Date.now();
      const prev = navState.get(d.tabId);
      const gap = prev ? now - prev.lastTs : undefined;
      const chaining = prev && gap < CHAIN_WINDOW_MS;
      // Keep the page the user was last safely on, even across a redirect chain.
      const previousUrl = chaining && prev.previousUrl ? prev.previousUrl : await currentSafeUrl(d.tabId);
      navState.set(d.tabId, {
        chainLength: chaining ? prev.chainLength + 1 : 1,
        lastTs: now,
        timeSinceLastNav: gap,
        previousUrl: previousUrl
      });
      if (navState.size > 200) navState.delete(navState.keys().next().value); // bounded memory
    });
  }

  function handleCommitted(d) {
    if (!isTopFrame(d) || SRGDetect.isIgnorableUrl(d.url)) return Promise.resolve();
    return serial(d.tabId, async function () {
      const settings = await protectionActive();
      if (!settings) return;
      const st = navState.get(d.tabId) || { chainLength: 1, previousUrl: await currentSafeUrl(d.tabId), timeSinceLastNav: undefined };
      const trusted = await SRGStorage.isTrusted(d.url, 'redirect');

      let verdict;
      if (isUserInitiated(d)) {
        verdict = { confidence: 'low', score: 0, reasons: ['user-initiated'], matchedRule: null };
      } else {
        verdict = SRGDetect.classifyNavigation({
          url: d.url,
          previousUrl: st.previousUrl,
          transitionType: d.transitionType,
          transitionQualifiers: d.transitionQualifiers || [],
          frameId: d.frameId,
          trusted: trusted,
          chainLength: st.chainLength,
          timeSinceLastNav: st.timeSinceLastNav
        });
      }

      if (verdict.confidence === 'high' || verdict.confidence === 'medium') {
        // Detect and offer recovery. We never navigate on our own.
        await SRGAction.noteRedirect(d.tabId, verdict, st.previousUrl, d.url);
      } else if (settings.redirect.rememberSafeUrl && isWebUrl(d.url)) {
        await SRGStorage.session.setSafeUrl(d.tabId, d.url);
      }
    });
  }

  function handleErrorOccurred(d) {
    if (!isTopFrame(d)) return Promise.resolve();
    // DNR blocks surface as this error. (Other blockers produce it too.)
    if (d.error !== 'net::ERR_BLOCKED_BY_CLIENT') return Promise.resolve();
    return serial(d.tabId, async function () {
      const settings = await protectionActive();
      if (!settings) return;
      const st = navState.get(d.tabId);
      const from = (st && st.previousUrl) || await currentSafeUrl(d.tabId);
      const p = SRGDetect.parseUrl(d.url);
      if (settings.redirect.offerRecovery && from) {
        await SRGStorage.session.setRecovery(d.tabId, { from: from, to: d.url, confidence: 'high' });
      }
      // log() also bumps redirectsBlocked for action "blocked".
      await SRGAction.log({
        domain: p.ok ? p.host : '', layer: 'redirect', type: 'blocked-navigation', action: 'blocked',
        confidence: 'high', detail: 'Navigation blocked by a network rule'
      });
      SRGAction.updateBadge(d.tabId);
    });
  }

  async function getRecovery(tabId) {
    return SRGStorage.session.getRecovery(tabId);
  }

  // Go back to the remembered safe page. Returns the URL, or null.
  async function recover(tabId) {
    try { return await SRGAction.navigateBack(tabId); } catch (e) { warn('recover', e); return null; }
  }

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
      chrome.webNavigation.onBeforeNavigate.addListener(guarded(handleBeforeNavigate));
      chrome.webNavigation.onCommitted.addListener(guarded(handleCommitted));
      chrome.webNavigation.onErrorOccurred.addListener(guarded(handleErrorOccurred));
      chrome.tabs.onRemoved.addListener(function (tabId) { navState.delete(tabId); chains.delete(tabId); });
    } catch (e) { warn('init', e); }
  }

  root.SRGNavMonitor = {
    init: init,
    handleBeforeNavigate: handleBeforeNavigate,
    handleCommitted: handleCommitted,
    handleErrorOccurred: handleErrorOccurred,
    getRecovery: getRecovery,
    recover: recover
  };
})(typeof self !== 'undefined' ? self : this);
