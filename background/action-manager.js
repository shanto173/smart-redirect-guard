/*
 * background/action-manager.js
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE DOES
 *   This is the ONLY file allowed to DO things: close a tab, switch tabs,
 *   navigate a tab back, change the toolbar badge, and install network rules.
 *   The monitors only observe and the detection engine only judges. Keeping
 *   every side effect here means there is exactly one place to audit for
 *   "could this close a legitimate tab?".
 *
 * THE SAFETY NET FOR CLOSING TABS
 *   closeAdTab() never trusts the earlier decision. It waits a short delay (so
 *   the tab can finish redirecting), then looks at the tab AGAIN, re-runs the
 *   detection engine on the tab's CURRENT address, and only closes it if it is
 *   still high confidence. Any doubt -> do nothing (fail open).
 *
 * DNR (declarativeNetRequest) rule id ranges, see docs/RULES.md
 *   1-999 static file, 1000-1999 trusted-site allow rules, 2000-2999 custom rules.
 */
(function (root) {
  'use strict';

  const STATIC_RULESET_ID = 'srg-static';
  const TRUSTED_BASE = 1000;
  const TRUSTED_MAX = 999;
  const CUSTOM_BASE = 2000;
  const CUSTOM_MAX = 999;
  const BADGE_COLOR = '#dc2626';

  const pending = new Map(); // tabId -> timer handle, so a closed tab can cancel its timer

  function warn(where, e) {
    try { console.warn('[SRG action] ' + where + ':', e && e.message ? e.message : e); } catch (_) { /* ignore */ }
  }
  function validTabId(id) { return typeof id === 'number' && id >= 0; }
  function hostOf(url) {
    const p = SRGDetect.parseUrl(url);
    return p.ok ? p.host : '';
  }
  function isWebUrl(url) {
    const p = SRGDetect.parseUrl(url);
    return p.ok && (p.protocol === 'http:' || p.protocol === 'https:') && !!p.host;
  }

  // ------------------------------------------------------------------ badge
  // The badge text itself is the per-session counter: it survives a worker
  // restart and resets when Chrome restarts. Updates are queued so two events
  // at once cannot lose a count.
  let badgeChain = Promise.resolve();

  async function setBadge(text) {
    try {
      await chrome.action.setBadgeText({ text: text });
      if (text) await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
    } catch (e) { warn('badge', e); }
  }

  function bumpBadge() {
    badgeChain = badgeChain.then(async function () {
      try {
        const s = await SRGStorage.getSettings();
        if (!s.ui.showBadge) return;
        let n = 0;
        try { n = parseInt(await chrome.action.getBadgeText({}), 10) || 0; } catch (e) { /* start from 0 */ }
        n += 1;
        await setBadge(n > 99 ? '99+' : String(n));
      } catch (e) { warn('bumpBadge', e); }
    });
    return badgeChain;
  }

  // Re-applies the badge preference (clears the badge if the user turned it off).
  async function updateBadge() {
    try {
      const s = await SRGStorage.getSettings();
      if (!s.ui.showBadge) await setBadge('');
      else await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
    } catch (e) { warn('updateBadge', e); }
  }

  // -------------------------------------------------------------------- log
  // Maps an activity row to the statistic it should increase (if any).
  function statFor(row) {
    const k = row.layer + ':' + row.action;
    return {
      'tab:closed': 'tabsClosed', 'tab:allowed': 'tabsAllowed',
      'redirect:blocked': 'redirectsBlocked', 'redirect:logged': 'redirectsDetected',
      'element:hidden': 'elementsHidden', 'element:restored': 'elementsRestored'
    }[k] || null;
  }

  async function log(row) {
    try {
      if (!row || typeof row !== 'object') return null;
      const stat = statFor(row);
      if (stat) SRGStorage.bumpStat(stat, 1);
      if (row.action === 'closed' || row.action === 'blocked' || row.action === 'hidden') bumpBadge();
      return await SRGStorage.addActivity(row);
    } catch (e) { warn('log', e); return null; }
  }

  // ----------------------------------------------------------- tab closing
  function cancelPending(tabId) {
    const t = pending.get(tabId);
    if (t) { clearTimeout(t); pending.delete(tabId); }
  }

  async function closeAdTab(tabId, opts) {
    try {
      const o = opts || {};
      const verdict = o.verdict;
      // Guard 1: only an explicit HIGH verdict may ever lead to a close.
      if (!verdict || verdict.confidence !== 'high' || !validTabId(tabId) || pending.has(tabId)) return false;
      pending.set(tabId, null); // reserve the slot now so duplicate calls are ignored
      const settings = await SRGStorage.getSettings();
      if (!settings.masterEnabled || !settings.tab.enabled) { pending.delete(tabId); return false; }
      const rec0 = await SRGStorage.session.getTab(tabId);
      if (rec0 && rec0.srgOpened) { pending.delete(tabId); return false; } // never close SRG's own tabs

      const wanted = typeof o.delayMs === 'number' ? o.delayMs : settings.tab.closeDelayMs;
      const delay = Math.min(10000, Math.max(0, isFinite(wanted) ? wanted : 1000));
      // Short delay only (worker may sleep on long timers); detection already happened.
      const timer = setTimeout(function () {
        pending.delete(tabId);
        reverifyAndClose(tabId, o).catch(function (e) { warn('reverifyAndClose', e); });
      }, delay);
      pending.set(tabId, timer);
      return true;
    } catch (e) { pending.delete(tabId); warn('closeAdTab', e); return false; }
  }

  async function reverifyAndClose(tabId, o) {
    // Step 1: does the tab still exist? If not, there is nothing to do.
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch (e) { return; }
    if (!tab) return;

    const settings = await SRGStorage.getSettings();
    if (!settings.masterEnabled || !settings.tab.enabled) return;
    const rec = (await SRGStorage.session.getTab(tabId)) || {};
    if (rec.srgOpened) return;

    // Step 2: judge the tab's CURRENT address from scratch.
    const url = tab.url || tab.pendingUrl || '';
    if (!url || SRGDetect.isIgnorableUrl(url)) return;
    const openerUrl = rec.openerUrl || '';
    const history = Array.isArray(rec.urlHistory) ? rec.urlHistory.slice() : [];
    if (history[history.length - 1] !== url) history.push(url);

    const trusted = await SRGStorage.isTrusted(url, 'tab');
    const openerTrusted = openerUrl ? await SRGStorage.isTrusted(openerUrl, 'tab') : false;
    const veto = SRGDetect.hasVetoSignal(url);
    let verdict2 = null;
    if (!trusted && !openerTrusted && !veto.veto) {
      verdict2 = SRGDetect.classifyTab({
        url: url, openerUrl: openerUrl, urlHistory: history, createdAt: rec.createdAt, now: Date.now(),
        transitionQualifiers: [], srgOpened: false, trusted: false,
        userGesture: typeof rec.userGesture === 'boolean' ? rec.userGesture : undefined
      });
    }
    if (!verdict2 || verdict2.confidence !== 'high') {
      await log({
        domain: hostOf(url), layer: 'tab', type: 'ad-tab', action: 'allowed', confidence: 'low',
        detail: 'revalidation-cleared' + (veto.veto ? ' (' + veto.reason + ')' : '')
      });
      return;
    }

    // Step 3: still high confidence -> close it. This is the ONLY tabs.remove in SRG.
    try {
      await chrome.tabs.remove(tabId);
    } catch (e) { warn('tabs.remove', e); return; }
    await log({
      domain: hostOf(url), layer: 'tab', type: 'ad-tab', action: 'closed', confidence: 'high',
      detail: verdict2.reasons.join(', ') + (verdict2.matchedRule ? ' [' + verdict2.matchedRule + ']' : '')
    });
    if (settings.tab.reactivateOpener) {
      const openerId = validTabId(rec.openerTabId) ? rec.openerTabId : (validTabId(o.openerTabId) ? o.openerTabId : null);
      if (openerId !== null) await activateTab(openerId);
    }
  }

  async function allowTab(tabId, verdict, url) {
    return log({
      domain: hostOf(url), layer: 'tab', type: 'ad-tab', action: 'allowed',
      confidence: (verdict && verdict.confidence) || 'low',
      detail: verdict && verdict.reasons ? verdict.reasons.join(', ') : ''
    });
  }

  async function activateTab(tabId) {
    if (!validTabId(tabId)) return false;
    try { await chrome.tabs.update(tabId, { active: true }); return true; } catch (e) { return false; } // opener may be gone
  }

  // -------------------------------------------------------------- redirects
  // Called for suspicious navigations that already happened. Logs them and
  // remembers where the user was so the popup can offer "go back".
  async function noteRedirect(tabId, verdict, from, to) {
    try {
      const settings = await SRGStorage.getSettings();
      if (settings.redirect.offerRecovery && validTabId(tabId) && isWebUrl(from)) {
        await SRGStorage.session.setRecovery(tabId, { from: from, to: to, confidence: verdict.confidence });
      }
      const reasons = verdict.reasons || [];
      await log({
        domain: hostOf(to), layer: 'redirect',
        type: reasons.indexOf('client-redirect') !== -1 ? 'client-redirect' : 'suspicious-redirect',
        action: 'logged', confidence: verdict.confidence,
        detail: reasons.join(', ') + (verdict.matchedRule ? ' [' + verdict.matchedRule + ']' : '')
      });
    } catch (e) { warn('noteRedirect', e); }
  }

  // User-requested "go back": returns the URL navigated to, or null.
  async function navigateBack(tabId) {
    try {
      if (!validTabId(tabId)) return null;
      const rec = await SRGStorage.session.getRecovery(tabId);
      const url = (rec && rec.from) || (await SRGStorage.session.getSafeUrl(tabId));
      if (!url || !isWebUrl(url)) return null;
      await chrome.tabs.update(tabId, { url: url });
      await SRGStorage.session.clearRecovery(tabId);
      await log({
        domain: hostOf(url), layer: 'redirect', type: 'recovery', action: 'recovered',
        confidence: (rec && rec.confidence) || 'medium', detail: 'User returned to the last safe page'
      });
      return url;
    } catch (e) { warn('navigateBack', e); return null; }
  }

  // -------------------------------------------------------------- DNR rules
  const lastApplied = { trusted: null, custom: null, staticEnabled: null }; // skip redundant updates

  async function applyRange(base, max, rules) {
    const dnr = chrome.declarativeNetRequest;
    const existing = await dnr.getDynamicRules();
    const removeRuleIds = existing.filter(function (r) { return r.id >= base && r.id < base + max + 1; })
      .map(function (r) { return r.id; });
    try {
      await dnr.updateDynamicRules({ removeRuleIds: removeRuleIds, addRules: rules });
    } catch (e) {
      // One bad rule rejects the whole batch, so retry rule by rule and skip the bad ones.
      warn('updateDynamicRules batch failed, retrying individually', e);
      await dnr.updateDynamicRules({ removeRuleIds: removeRuleIds, addRules: [] });
      for (const rule of rules) {
        try { await dnr.updateDynamicRules({ addRules: [rule] }); } catch (err) { warn('skipped rule ' + rule.id, err); }
      }
    }
  }

  // Enable/disable the shipped static ruleset according to the settings.
  async function applyStaticRuleset() {
    try {
      const s = await SRGStorage.getSettings();
      const enable = s.masterEnabled && s.redirect.enabled && s.redirect.dnrBlocking;
      if (lastApplied.staticEnabled === enable) return;
      await chrome.declarativeNetRequest.updateEnabledRulesets(
        enable ? { enableRulesetIds: [STATIC_RULESET_ID] } : { disableRulesetIds: [STATIC_RULESET_ID] });
      lastApplied.staticEnabled = enable;
    } catch (e) { warn('applyStaticRuleset', e); }
  }

  async function applyTrustedDnrRules() {
    try {
      const now = Date.now();
      const trusted = await SRGStorage.getTrusted();
      const rules = [];
      trusted.forEach(function (t) {
        if (rules.length >= TRUSTED_MAX) return;
        if (!t.scope || t.scope.redirect !== true) return;
        if (typeof t.expiresAt === 'number' && t.expiresAt <= now) return;
        rules.push({
          id: TRUSTED_BASE + rules.length, priority: 100,
          action: { type: 'allowAllRequests' },
          condition: { requestDomains: [t.domain], resourceTypes: ['main_frame', 'sub_frame'] }
        });
      });
      const sig = JSON.stringify(rules);
      if (sig === lastApplied.trusted) return;
      await applyRange(TRUSTED_BASE, TRUSTED_MAX, rules);
      lastApplied.trusted = sig;
    } catch (e) { warn('applyTrustedDnrRules', e); }
  }

  function validDomain(d) {
    return typeof d === 'string' && d.length <= 253 && d.indexOf('.') > 0 && d.indexOf('..') === -1 &&
      /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(d);
  }
  // A urlFilter must be printable ASCII without spaces and have real content,
  // so a stray "*" can never block the whole web.
  function validPattern(p) {
    return typeof p === 'string' && p.length >= 3 && p.length <= 200 && /^[\x21-\x7e]+$/.test(p) &&
      p.replace(/[*|^]/g, '').length >= 3 && p.indexOf('||*') !== 0;
  }

  async function applyCustomDnrRules() {
    try {
      const s = await SRGStorage.getSettings();
      const custom = await SRGStorage.getCustomRules();
      const rules = [];
      if (s.masterEnabled && s.redirect.enabled && s.redirect.dnrBlocking) {
        const types = ['main_frame', 'sub_frame'];
        custom.adDomains.forEach(function (raw) {
          const d = raw.toLowerCase().replace(/^\*?\./, '').replace(/^www\./, '');
          if (!validDomain(d) || rules.length >= CUSTOM_MAX) return; // skip invalid, keep the rest
          rules.push({ id: CUSTOM_BASE + rules.length, priority: 1, action: { type: 'block' },
            condition: { requestDomains: [d], resourceTypes: types } });
        });
        custom.urlPatterns.forEach(function (p) {
          if (!validPattern(p) || rules.length >= CUSTOM_MAX) return;
          rules.push({ id: CUSTOM_BASE + rules.length, priority: 1, action: { type: 'block' },
            condition: { urlFilter: p, resourceTypes: types } });
        });
      }
      const sig = JSON.stringify(rules);
      if (sig === lastApplied.custom) return;
      await applyRange(CUSTOM_BASE, CUSTOM_MAX, rules);
      lastApplied.custom = sig;
    } catch (e) { warn('applyCustomDnrRules', e); }
  }

  // Convenience: everything DNR-related in one call (used by the service worker).
  async function applyAllDnr() {
    await applyStaticRuleset();
    await applyTrustedDnrRules();
    await applyCustomDnrRules();
  }

  root.SRGAction = {
    closeAdTab: closeAdTab,
    allowTab: allowTab,
    activateTab: activateTab,
    noteRedirect: noteRedirect,
    navigateBack: navigateBack,
    updateBadge: updateBadge,
    log: log,
    applyTrustedDnrRules: applyTrustedDnrRules,
    applyCustomDnrRules: applyCustomDnrRules,
    // additions beyond the frozen contract (additive only)
    cancelPending: cancelPending,
    applyStaticRuleset: applyStaticRuleset,
    applyAllDnr: applyAllDnr
  };
})(typeof self !== 'undefined' ? self : this);
