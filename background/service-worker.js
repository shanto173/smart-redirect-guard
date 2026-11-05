/*
 * background/service-worker.js
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE DOES
 *   The entry point ("main") of the extension's background brain. It:
 *     - loads the other background files,
 *     - sets everything up once (defaults, rules, network rules, timers),
 *     - routes messages from the content scripts and from the popup/dashboard,
 *     - runs a small maintenance job every minute.
 *
 * THE MANIFEST V3 SERVICE WORKER IN PLAIN WORDS
 *   Chrome starts this script when something happens (a tab opens, a message
 *   arrives) and stops it again after about 30 seconds of quiet. When it wakes
 *   up, all variables are gone, and the event that woke it can arrive BEFORE
 *   our setup finished. So:
 *     - listeners are registered right away, at the top level of this script
 *       (Chrome only delivers events to listeners it sees during startup);
 *     - every listener first awaits ensureReady(), a memoised promise that runs
 *       the setup exactly once per worker lifetime;
 *     - anything that matters is stored in chrome.storage, not in variables.
 */
importScripts(
  '../shared/element-scoring.js',
  '../storage/storage-manager.js',
  'detection-engine.js',
  'tab-monitor.js',
  'navigation-monitor.js',
  'action-manager.js'
);

(function () {
  'use strict';

  const ALARM_NAME = 'srg-maintenance';
  const EMPTY_SELECTORS = {
    high: { selectors: [], idClassTokens: [], iframeHosts: [] },
    medium: { selectors: [], idClassTokens: [] },
    allow: { selectors: [], textHints: [] },
    adDomains: [],
    urlPatterns: []
  };

  // Cached copy of rules/element-selectors.json. Lost when the worker sleeps,
  // so getSelectors() re-fetches it whenever it is missing.
  let selectorsCache = null;
  let readyPromise = null;

  function warn(where, e) {
    try { console.warn('[SRG worker] ' + where + ':', e && e.message ? e.message : e); } catch (_) { /* ignore */ }
  }

  // The worker can read its own packaged files without web_accessible_resources.
  async function fetchJson(path) {
    try {
      const res = await fetch(chrome.runtime.getURL(path));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) { warn('fetch ' + path, e); return null; }
  }

  function arr(v) { return Array.isArray(v) ? v.filter(function (x) { return typeof x === 'string'; }) : []; }
  function uniq(list) { return Array.from(new Set(list)); }

  async function getSelectors() {
    if (selectorsCache) return selectorsCache;
    const j = await fetchJson('rules/element-selectors.json');
    if (!j || typeof j !== 'object') return EMPTY_SELECTORS; // fail open: no rules, not cached so we retry
    const high = j.high || {};
    const medium = j.medium || {};
    const allow = j.allow || {};
    selectorsCache = {
      high: { selectors: arr(high.selectors), idClassTokens: arr(high.idClassTokens), iframeHosts: arr(high.iframeHosts) },
      medium: { selectors: arr(medium.selectors), idClassTokens: arr(medium.idClassTokens) },
      allow: { selectors: arr(allow.selectors), textHints: arr(allow.textHints) },
      adDomains: arr(j.adDomains),
      urlPatterns: arr(j.urlPatterns)
    };
    return selectorsCache;
  }

  // Push the current rule data into the detection engine and the network rules.
  async function refreshRules() {
    try {
      const sel = await getSelectors();
      const custom = await SRGStorage.getCustomRules();
      SRGDetect.setRules({
        adDomains: uniq(sel.adDomains.concat(custom.adDomains)),
        suspiciousDomains: custom.suspiciousDomains,
        urlPatterns: uniq(sel.urlPatterns.concat(custom.urlPatterns)),
        // Trust is scope-aware (tab/redirect/element), so it is passed per call
        // via ctx.trusted rather than as a blanket list here.
        trustedDomains: []
      });
      await SRGAction.applyAllDnr();
    } catch (e) { warn('refreshRules', e); }
  }

  async function bootstrap() {
    try {
      await SRGStorage.bootstrap();
      const shipped = await fetchJson('rules/trusted-sites.json');
      if (shipped && Array.isArray(shipped.sites)) await SRGStorage.seedTrustedOnce(shipped.sites); // first install only
      await refreshRules();
      try {
        const existing = await chrome.alarms.get(ALARM_NAME);
        if (!existing) chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
      } catch (e) { warn('alarm', e); }
      await SRGAction.updateBadge();
    } catch (e) { warn('bootstrap', e); }
  }

  function ensureReady() {
    if (!readyPromise) readyPromise = bootstrap();
    return readyPromise;
  }

  // ---- listeners that must exist at startup --------------------------------
  SRGTabMonitor.init({ ready: ensureReady });
  SRGNavMonitor.init({ ready: ensureReady });

  chrome.runtime.onInstalled.addListener(function () {
    // Re-run the setup on install/update so new rules and defaults apply.
    readyPromise = bootstrap();
  });
  chrome.runtime.onStartup.addListener(function () {
    ensureReady();
  });

  chrome.alarms.onAlarm.addListener(function (alarm) {
    if (!alarm || alarm.name !== ALARM_NAME) return;
    ensureReady().then(async function () {
      await SRGStorage.flush();
      await SRGTabMonitor.prune();
      await SRGAction.applyTrustedDnrRules(); // drops entries whose time-limited trust has expired
    }).catch(function (e) { warn('alarm', e); });
  });

  chrome.runtime.onSuspend.addListener(function () {
    SRGStorage.flush();
  });

  // onRuleMatchedDebug only exists for unpacked extensions. Main-frame blocks are
  // counted by navigation-monitor, so only sub-frames are counted here (no double count).
  try {
    if (chrome.declarativeNetRequest && chrome.declarativeNetRequest.onRuleMatchedDebug) {
      chrome.declarativeNetRequest.onRuleMatchedDebug.addListener(function (info) {
        try {
          const type = info && info.request && info.request.type;
          const rule = info && info.rule;
          if (!rule || (rule.rulesetId === '_dynamic' && rule.ruleId >= 1000 && rule.ruleId < 2000)) return; // allow rules are not blocks
          if (type === 'sub_frame') SRGStorage.bumpStat('redirectsBlocked', 1);
        } catch (e) { warn('onRuleMatchedDebug', e); }
      });
    }
  } catch (e) { warn('onRuleMatchedDebug setup', e); }

  // ---- helpers for the message handlers ------------------------------------
  async function elementEnabledFor(url, settings) {
    if (!settings.masterEnabled || !settings.element.enabled) return false;
    return !(await SRGStorage.isTrusted(url, 'element'));
  }

  // Tell every web page the settings changed so layer 3 can re-apply or stop.
  async function broadcastSettings() {
    try {
      const settings = await SRGStorage.getSettings();
      const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
      await Promise.all(tabs.map(async function (tab) {
        try {
          const trusted = await SRGStorage.isTrusted(tab.url, 'element');
          const enabled = settings.masterEnabled && settings.element.enabled && !trusted;
          await chrome.tabs.sendMessage(tab.id, {
            type: 'SRG_SETTINGS_CHANGED', payload: { enabled: enabled, settings: settings, trusted: trusted }
          });
        } catch (e) { /* "Receiving end does not exist" and friends are expected */ }
      }));
    } catch (e) { warn('broadcastSettings', e); }
  }

  async function afterChange() {
    await refreshRules();
    await SRGAction.updateBadge();
    await broadcastSettings();
  }

  // Forward a request to the content script of one tab and relay its reply.
  async function toContent(tabId, type, payload) {
    if (typeof tabId !== 'number' || tabId < 0) return { ok: false, error: 'bad-tab' };
    try {
      const reply = await chrome.tabs.sendMessage(tabId, payload === undefined ? { type: type } : { type: type, payload: payload });
      return reply && typeof reply === 'object' ? reply : { ok: false, error: 'no-content-script' };
    } catch (e) { // "Receiving end does not exist": chrome:// page, PDF viewer, not yet injected ...
      return { ok: false, error: 'no-content-script' };
    }
  }

  async function anyLayerTrusted(url) {
    const layers = ['tab', 'redirect', 'element'];
    for (const l of layers) if (await SRGStorage.isTrusted(url, l)) return true;
    return false;
  }

  async function buildConfig(p, sender) {
    const settings = await SRGStorage.getSettings();
    const url = (p && typeof p.url === 'string' && p.url) || (sender && sender.url) || '';
    const trusted = url ? await SRGStorage.isTrusted(url, 'element') : false;
    const enabled = settings.masterEnabled && settings.element.enabled && !trusted;
    const sel = await getSelectors();
    const custom = await SRGStorage.getCustomRules();
    // FLAT shape, exactly the argument SRG.detector.configure() consumes in the page.
    // (Keeping it flat here is deliberate: the content script never has to reshape rule data,
    // so there is only one place where the field names have to agree.)
    return {
      ok: true,
      enabled: enabled,
      settings: settings,
      trusted: trusted,
      selectors: uniq(sel.high.selectors.concat(custom.selectors)),
      highTokens: sel.high.idClassTokens,
      mediumSelectors: sel.medium.selectors,
      mediumTokens: sel.medium.idClassTokens,
      allowSelectors: uniq(sel.allow.selectors.concat(custom.allowSelectors)),
      textHints: sel.allow.textHints,
      adIframeHosts: uniq(sel.high.iframeHosts.concat(custom.adDomains)),
      adDomains: uniq(sel.adDomains.concat(custom.adDomains)),
      urlPatterns: uniq(sel.urlPatterns.concat(custom.urlPatterns))
    };
  }

  function str(v, max) { return typeof v === 'string' ? v.slice(0, max) : ''; }
  function oneOf(v, list, dflt) { return list.indexOf(v) !== -1 ? v : dflt; }

  // ---- message handlers: type -> async (payload, sender) => reply ----------
  const handlers = {
    // content script -> worker
    SRG_GET_CONFIG: buildConfig,

    SRG_REPORT_HIDDEN: async function (p) {
      const items = Array.isArray(p.items) ? p.items : [];
      const host = SRGDetect.parseUrl(p.url).ok ? SRGDetect.parseUrl(p.url).host : '';
      const logged = items.slice(0, 20); // cap activity rows per report
      for (const it of logged) {
        await SRGAction.log({
          domain: host, layer: 'element', type: 'ad-element', action: 'hidden',
          confidence: oneOf(it && it.confidence, ['high', 'medium', 'low'], 'high'),
          detail: str(it && it.label, 120) + (it && it.reason ? ' (' + str(it.reason, 120) + ')' : '')
        });
      }
      if (items.length > logged.length) SRGStorage.bumpStat('elementsHidden', items.length - logged.length);
      return { ok: true };
    },

    SRG_REPORT_ELEMENT_RESTORED: async function (p) {
      const parsed = SRGDetect.parseUrl(p.url);
      await SRGAction.log({
        domain: parsed.ok ? parsed.host : '', layer: 'element', type: 'ad-element', action: 'restored',
        confidence: 'high', detail: 'Element restored by user'
      });
      return { ok: true };
    },

    SRG_LOG_ACTIVITY: async function (p) {
      // Activity row only (no statistic), so it never double-counts REPORT_HIDDEN.
      await SRGStorage.addActivity({
        domain: str(p.domain, 253),
        layer: oneOf(p.layer, ['tab', 'redirect', 'element'], 'element'),
        type: str(p.type, 60),
        action: oneOf(p.action, ['closed', 'blocked', 'hidden', 'logged', 'allowed', 'restored', 'recovered'], 'logged'),
        confidence: oneOf(p.confidence, ['high', 'medium', 'low'], 'low'),
        detail: str(p.detail, 300)
      });
      return { ok: true };
    },

    // popup / dashboard -> worker
    SRG_GET_STATE: async function () {
      const settings = await SRGStorage.getSettings();
      const stats = await SRGStorage.getStats();
      let activeTab = { id: null, url: '', domain: '', trusted: false };
      try {
        const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        const t = tabs && tabs[0];
        if (t) {
          const parsed = SRGDetect.parseUrl(t.url);
          activeTab = {
            id: t.id, url: t.url || '', domain: parsed.ok ? parsed.host : '',
            trusted: t.url ? await anyLayerTrusted(t.url) : false
          };
        }
      } catch (e) { warn('active tab', e); }
      return {
        ok: true, settings: settings, stats: stats, activeTab: activeTab,
        status: {
          version: chrome.runtime.getManifest().version,
          masterEnabled: settings.masterEnabled,
          layers: { tab: settings.tab.enabled, redirect: settings.redirect.enabled, element: settings.element.enabled }
        }
      };
    },

    SRG_UPDATE_SETTINGS: async function (p) {
      const settings = await SRGStorage.updateSettings(p);
      await afterChange();
      return { ok: true, settings: settings };
    },

    SRG_GET_ACTIVITY: async function (p) {
      return { ok: true, activity: await SRGStorage.getActivity(typeof p.limit === 'number' ? p.limit : undefined) };
    },
    SRG_CLEAR_ACTIVITY: async function () { await SRGStorage.clearActivity(); return { ok: true }; },
    SRG_RESET_STATS: async function () { return { ok: true, stats: await SRGStorage.resetStats() }; },

    SRG_GET_TRUSTED: async function () { return { ok: true, trusted: await SRGStorage.getTrusted() }; },
    SRG_ADD_TRUSTED: async function (p) {
      if (typeof p.domain !== 'string' || !SRGDetect.parseUrl('http://' + p.domain.trim().replace(/^[a-z]+:\/\//i, '')).ok) {
        return { ok: false, error: 'invalid-domain' };
      }
      const trusted = await SRGStorage.addTrusted(p.domain, p.scope, p.durationMs);
      await afterChange();
      return { ok: true, trusted: trusted };
    },
    SRG_REMOVE_TRUSTED: async function (p) {
      const trusted = await SRGStorage.removeTrusted(p.domain);
      await afterChange();
      return { ok: true, trusted: trusted };
    },

    SRG_GET_CUSTOM_RULES: async function () { return { ok: true, customRules: await SRGStorage.getCustomRules() }; },
    SRG_UPDATE_CUSTOM_RULES: async function (p) {
      const customRules = await SRGStorage.updateCustomRules(p.customRules);
      await afterChange();
      return { ok: true, customRules: customRules };
    },

    SRG_GET_RECOVERY: async function (p) {
      if (typeof p.tabId !== 'number') return { ok: false, error: 'bad-tab' };
      const rec = await SRGNavMonitor.getRecovery(p.tabId);
      return { ok: true, recovery: rec ? { from: rec.from, to: rec.to, ts: rec.ts } : null };
    },
    SRG_RECOVER_TAB: async function (p) {
      if (typeof p.tabId !== 'number') return { ok: false, error: 'bad-tab' };
      const url = await SRGNavMonitor.recover(p.tabId);
      return { ok: !!url, url: url };
    },

    // popup -> worker -> content script
    SRG_GET_HIDDEN_ELEMENTS: async function (p) {
      const r = await toContent(p.tabId, 'SRG_LIST_HIDDEN');
      return r.ok ? { ok: true, items: Array.isArray(r.items) ? r.items : [] } : r;
    },
    SRG_RESTORE_ELEMENT: function (p) { return toContent(p.tabId, 'SRG_RESTORE', { sid: p.sid }); },
    SRG_RESTORE_ALL_ELEMENTS: function (p) { return toContent(p.tabId, 'SRG_RESTORE_ALL'); },
    SRG_RESCAN_TAB: function (p) { return toContent(p.tabId, 'SRG_RESCAN'); },

    SRG_EXPORT_CONFIG: async function () {
      const data = await SRGStorage.exportConfig();
      return data ? { ok: true, data: data } : { ok: false, error: 'export-failed' };
    },
    SRG_IMPORT_CONFIG: async function (p) {
      const result = await SRGStorage.importConfig(p.data);
      if (result && result.ok) await afterChange();
      return result;
    }
  };

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    // Only accept messages from this extension's own pages and content scripts.
    if (!msg || typeof msg.type !== 'string' || !sender || sender.id !== chrome.runtime.id) return false;
    const handler = handlers[msg.type];
    if (!handler) return false;
    let answered = false;
    function reply(r) { // exactly one response, ever
      if (answered) return;
      answered = true;
      try { sendResponse(r); } catch (e) { /* the sender went away */ }
    }
    const payload = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
    ensureReady()
      .then(function () { return handler(payload, sender); })
      .then(reply)
      .catch(function (e) { warn(msg.type, e); reply({ ok: false, error: String((e && e.message) || e) }); });
    return true; // keep the channel open for the async reply
  });
})();
