/*
 * storage/storage-manager.js
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE DOES
 *   This is the ONLY file in the extension that reads or writes chrome.storage.
 *   Everything else (service worker, popup, dashboard) asks it for settings,
 *   trusted sites, statistics, the activity log and custom rules.
 *
 * WHY IT IS SHAPED THIS WAY
 *   - Chrome can kill the background service worker at any time, so anything
 *     important must live in storage, not in variables.
 *   - chrome.storage has write-rate limits, so counters and log rows are
 *     collected in memory and written in one go every ~2 seconds ("debounce").
 *   - It must load in the service worker (importScripts) AND on popup/dashboard
 *     pages (<script> tag), so it only attaches one global: SRGStorage.
 *   - No public method ever throws. On failure it logs a warning and returns a
 *     safe default, so a storage hiccup can never break browsing.
 *
 * NOTES FOR READERS
 *   - "local" storage persists on disk. "session" storage lives only in memory
 *     and is used for per-tab URLs (privacy). On old Chrome without
 *     chrome.storage.session we fall back to local keys prefixed "srg.sess."
 *     and wipe them at startup so they behave like session data.
 *   - session.getSafeUrl() returns the URL string (or null), not the record.
 *   - Two small additions beyond the frozen contract (additive only):
 *     SRGStorage.seedTrustedOnce(entries) and SRGStorage.SCHEMA_VERSION.
 */
(function (root) {
  'use strict';

  const SCHEMA_VERSION = 1;
  const DEBOUNCE_MS = 2000;
  const MAX_TRUSTED = 500;
  const MAX_RULES_PER_LIST = 1000;
  const MAX_RULE_LEN = 253;
  const MAX_TAB_RECORDS = 500;

  const K = {
    version: 'srg.version',
    settings: 'srg.settings',
    trusted: 'srg.trusted',
    stats: 'srg.stats',
    activity: 'srg.activity',
    customRules: 'srg.customRules',
    seeded: 'srg.trustedSeeded',
    tabs: 'srg.tabs',
    safeUrl: 'srg.safeUrl',
    recovery: 'srg.recovery'
  };
  const SESSION_PREFIX = 'srg.sess.';

  // ---------------------------------------------------------------- defaults
  function makeDefaults() {
    return {
      settings: {
        masterEnabled: true,
        tab: { enabled: true, closeDelayMs: 1000, mediumAction: 'log', reactivateOpener: true },
        redirect: { enabled: true, dnrBlocking: true, offerRecovery: true, rememberSafeUrl: true },
        element: {
          enabled: true,
          hideHighConfidence: true,
          mediumAction: 'log',
          floatingDetection: true,
          overlayDetection: true,
          stickyDetection: true,
          iframeDetection: true,
          cosmeticCss: true
        },
        logging: { activityEnabled: true, maxEntries: 200 },
        ui: { theme: 'auto', showBadge: true }
      },
      stats: {
        tabsClosed: 0, tabsAllowed: 0,
        redirectsBlocked: 0, redirectsDetected: 0,
        elementsHidden: 0, elementsRestored: 0,
        lastReset: 0
      },
      customRules: {
        adDomains: [], suspiciousDomains: [], urlPatterns: [],
        selectors: [], allowSelectors: []
      }
    };
  }

  function deepFreeze(o) {
    Object.keys(o).forEach(function (k) {
      if (o[k] && typeof o[k] === 'object') deepFreeze(o[k]);
    });
    return Object.freeze(o);
  }
  const DEFAULTS = deepFreeze(makeDefaults());

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function isPlain(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function warn(where, e) {
    try { console.warn('[SRG storage] ' + where + ':', e && e.message ? e.message : e); } catch (_) { /* ignore */ }
  }

  // Enumerated settings and their allowed values (used by normalizeSettings).
  const ENUMS = [
    [['tab', 'mediumAction'], ['log', 'ignore']],
    [['element', 'mediumAction'], ['log', 'hide', 'ignore']],
    [['ui', 'theme'], ['auto', 'light', 'dark']]
  ];

  // Keep only known keys with the right type; fill gaps from the template.
  // This is our "deep merge": nested objects are merged, never replaced.
  function mergeKnown(template, patch) {
    const out = {};
    Object.keys(template).forEach(function (k) {
      const t = template[k];
      const has = isPlain(patch) && Object.prototype.hasOwnProperty.call(patch, k);
      const p = has ? patch[k] : undefined;
      if (isPlain(t)) out[k] = mergeKnown(t, isPlain(p) ? p : {});
      else if (p !== undefined && typeof p === typeof t && (typeof p !== 'number' || isFinite(p))) out[k] = p;
      else out[k] = t;
    });
    return out;
  }

  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

  function normalizeSettings(s) {
    s.tab.closeDelayMs = Math.round(clamp(s.tab.closeDelayMs, 0, 10000));
    s.logging.maxEntries = Math.round(clamp(s.logging.maxEntries, 10, 1000));
    ENUMS.forEach(function (e) {
      const path = e[0];
      const val = s[path[0]][path[1]];
      if (e[1].indexOf(val) === -1) s[path[0]][path[1]] = DEFAULTS.settings[path[0]][path[1]];
    });
    return s;
  }

  // ----------------------------------------------------------- low-level I/O
  function hasLocal() {
    return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  }

  // Returns the stored object, or null when the read failed (callers must then
  // avoid writing, otherwise a failed read could overwrite good data).
  async function localGet(keys) {
    try {
      if (!hasLocal()) return null;
      return (await chrome.storage.local.get(keys)) || {};
    } catch (e) { warn('local.get', e); return null; }
  }
  async function localSet(obj) {
    try {
      if (!hasLocal()) return false;
      await chrome.storage.local.set(obj);
      return true;
    } catch (e) { warn('local.set', e); return false; }
  }

  // Tiny per-name mutex: read-modify-write sequences on the same key must not
  // interleave, or one caller's change would silently erase another's.
  const locks = {};
  function withLock(name, fn) {
    const prev = locks[name] || Promise.resolve();
    const next = prev.then(fn, fn);
    locks[name] = next.catch(function () { /* keep the chain alive */ });
    return next;
  }

  // Session storage with a fallback for old Chrome.
  function sessionArea() {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session) {
        return { area: chrome.storage.session, prefix: '', fallback: false };
      }
      if (hasLocal()) return { area: chrome.storage.local, prefix: SESSION_PREFIX, fallback: true };
    } catch (e) { /* fall through */ }
    return null;
  }
  async function sessGet(key) {
    const s = sessionArea();
    if (!s) return null;
    try {
      const r = await s.area.get(s.prefix + key);
      return isPlain(r[s.prefix + key]) ? r[s.prefix + key] : {};
    } catch (e) { warn('session.get', e); return null; }
  }
  async function sessSet(key, value) {
    const s = sessionArea();
    if (!s) return false;
    try {
      const o = {}; o[s.prefix + key] = value;
      await s.area.set(o);
      return true;
    } catch (e) { warn('session.set', e); return false; }
  }

  // ----------------------------------------------------------------- helpers
  function uuid() {
    try {
      if (root.crypto && typeof root.crypto.randomUUID === 'function') return root.crypto.randomUUID();
    } catch (e) { /* fall back */ }
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  // Accepts "example.com", "www.Example.com", or a full URL. Returns a clean
  // lowercase host or null if it does not look like a host name.
  function normalizeDomain(input) {
    if (typeof input !== 'string') return null;
    let d = input.trim().toLowerCase();
    if (!d) return null;
    if (/[/:?#]/.test(d)) {
      try { d = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(d) ? d : 'http://' + d).hostname; } catch (e) { return null; }
    }
    d = d.replace(/\.$/, '').replace(/^www\./, '');
    if (d.length > MAX_RULE_LEN || !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(d) || d.indexOf('..') !== -1) return null;
    return d;
  }

  function normalizeScope(scope) {
    const base = { tab: true, redirect: true, element: true };
    if (isPlain(scope)) {
      Object.keys(base).forEach(function (k) { if (typeof scope[k] === 'boolean') base[k] = scope[k]; });
    }
    return base;
  }

  function sanitizeTrusted(list) {
    const out = [];
    const seen = {};
    (Array.isArray(list) ? list : []).forEach(function (e) {
      if (!isPlain(e) || out.length >= MAX_TRUSTED) return;
      const d = normalizeDomain(e.domain);
      if (!d || seen[d]) return;
      seen[d] = true;
      out.push({
        domain: d,
        scope: normalizeScope(e.scope),
        expiresAt: typeof e.expiresAt === 'number' && isFinite(e.expiresAt) ? e.expiresAt : null,
        addedAt: typeof e.addedAt === 'number' && isFinite(e.addedAt) ? e.addedAt : Date.now()
      });
    });
    return out;
  }

  // Custom rules: arrays of short, trimmed, de-duplicated strings.
  function sanitizeCustomRules(rules) {
    const out = clone(DEFAULTS.customRules);
    Object.keys(out).forEach(function (k) {
      const src = isPlain(rules) && Array.isArray(rules[k]) ? rules[k] : [];
      const seen = {};
      src.forEach(function (v) {
        if (typeof v !== 'string' || out[k].length >= MAX_RULES_PER_LIST) return;
        const t = v.trim();
        if (!t || t.length > MAX_RULE_LEN || seen[t]) return;
        seen[t] = true;
        out[k].push(t);
      });
    });
    return out;
  }

  // Minimal registrable-domain helper kept local so this file stays standalone.
  const TWO_PART = ['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'co.jp', 'com.br',
    'co.in', 'co.nz', 'com.mx', 'co.za', 'com.tr', 'com.sg', 'com.hk'];
  function registrable(host) {
    if (!host || host === 'localhost' || /^[\d.]+$/.test(host) || host.indexOf(':') !== -1) return host;
    const p = host.split('.');
    if (p.length <= 2) return host;
    const last2 = p.slice(-2).join('.');
    return TWO_PART.indexOf(last2) !== -1 ? p.slice(-3).join('.') : last2;
  }

  // ---------------------------------------------------------------- settings
  async function getSettings() {
    const r = await localGet(K.settings);
    const stored = r && r[K.settings];
    return normalizeSettings(mergeKnown(clone(DEFAULTS.settings), stored));
  }

  async function updateSettings(partial) {
    return withLock('settings', async function () {
      const r = await localGet(K.settings);
      if (r === null) return getSettings();
      const current = normalizeSettings(mergeKnown(clone(DEFAULTS.settings), r[K.settings]));
      const merged = normalizeSettings(mergeKnown(current, isPlain(partial) ? partial : {}));
      await localSet({ [K.settings]: merged });
      return merged;
    });
  }

  async function resetSettings() {
    return withLock('settings', async function () {
      const fresh = clone(DEFAULTS.settings);
      await localSet({ [K.settings]: fresh });
      return fresh;
    });
  }

  // ----------------------------------------------------------------- trusted
  async function getTrusted() {
    const r = await localGet(K.trusted);
    return sanitizeTrusted(r && r[K.trusted]);
  }

  async function addTrusted(domain, scope, durationMs) {
    return withLock('trusted', async function () {
      const d = normalizeDomain(domain);
      const r = await localGet(K.trusted);
      if (!d || r === null) return sanitizeTrusted(r && r[K.trusted]);
      const list = sanitizeTrusted(r[K.trusted]).filter(function (e) { return e.domain !== d; });
      const now = Date.now();
      list.push({
        domain: d,
        scope: normalizeScope(scope),
        expiresAt: typeof durationMs === 'number' && durationMs > 0 ? now + durationMs : null,
        addedAt: now
      });
      await localSet({ [K.trusted]: list });
      return list;
    });
  }

  async function removeTrusted(domain) {
    return withLock('trusted', async function () {
      const d = normalizeDomain(domain);
      const r = await localGet(K.trusted);
      if (r === null) return [];
      const list = sanitizeTrusted(r[K.trusted]).filter(function (e) { return e.domain !== d; });
      await localSet({ [K.trusted]: list });
      return list;
    });
  }

  // Seeds the shipped defaults exactly once (first install). A flag key makes
  // sure that a user who later deletes a default site does not get it back.
  async function seedTrustedOnce(entries) {
    return withLock('trusted', async function () {
      const r = await localGet([K.seeded, K.trusted]);
      if (r === null || r[K.seeded]) return false;
      const existing = sanitizeTrusted(r[K.trusted]);
      const have = {};
      existing.forEach(function (e) { have[e.domain] = true; });
      const now = Date.now();
      sanitizeTrusted((entries || []).map(function (e) { return Object.assign({}, e, { addedAt: now, expiresAt: null }); }))
        .forEach(function (e) { if (!have[e.domain]) existing.push(e); });
      return localSet({ [K.trusted]: existing, [K.seeded]: true });
    });
  }

  // True when `url` belongs to a trusted domain whose scope covers `layer`.
  async function isTrusted(url, layer) {
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      const host = u.hostname.toLowerCase().replace(/\.$/, '');
      const reg = registrable(host);
      const r = await localGet(K.trusted);
      if (!r) return false;
      const raw = Array.isArray(r[K.trusted]) ? r[K.trusted] : [];
      const now = Date.now();
      let expired = false;
      let hit = false;
      raw.forEach(function (e) {
        if (!isPlain(e) || typeof e.domain !== 'string') return;
        if (typeof e.expiresAt === 'number' && e.expiresAt <= now) { expired = true; return; }
        const d = e.domain.toLowerCase();
        // exact domain, or a subdomain of the trusted domain, or the trusted
        // entry is itself the registrable domain of this host
        const match = host === d || host.endsWith('.' + d) || reg === d;
        if (match && isPlain(e.scope) && e.scope[layer] === true) hit = true;
      });
      if (expired) pruneExpiredTrusted(); // lazy cleanup, not awaited
      return hit;
    } catch (e) { return false; }
  }

  function pruneExpiredTrusted() {
    withLock('trusted', async function () {
      const r = await localGet(K.trusted);
      if (!r || !Array.isArray(r[K.trusted])) return;
      const now = Date.now();
      const kept = r[K.trusted].filter(function (e) {
        return !(isPlain(e) && typeof e.expiresAt === 'number' && e.expiresAt <= now);
      });
      if (kept.length !== r[K.trusted].length) await localSet({ [K.trusted]: kept });
    }).catch(function () { /* already logged */ });
  }

  // ------------------------------------------------------------------- stats
  const STAT_KEYS = Object.keys(DEFAULTS.stats).filter(function (k) { return k !== 'lastReset'; });
  let pendingStats = {};
  let statsTimer = null;

  function readStatsFrom(r) {
    const base = clone(DEFAULTS.stats);
    const s = r && isPlain(r[K.stats]) ? r[K.stats] : {};
    STAT_KEYS.forEach(function (k) { base[k] = typeof s[k] === 'number' && isFinite(s[k]) ? s[k] : 0; });
    base.lastReset = typeof s.lastReset === 'number' ? s.lastReset : Date.now();
    return base;
  }

  async function getStats() {
    const r = await localGet(K.stats);
    const s = readStatsFrom(r);
    Object.keys(pendingStats).forEach(function (k) { s[k] += pendingStats[k]; }); // include unflushed counts
    return s;
  }

  async function bumpStat(key, n) {
    try {
      if (STAT_KEYS.indexOf(key) === -1) return;
      const inc = typeof n === 'number' && isFinite(n) ? n : 1;
      pendingStats[key] = (pendingStats[key] || 0) + inc;
      if (!statsTimer) statsTimer = setTimeout(function () { flushStats().catch(function () { /* logged */ }); }, DEBOUNCE_MS);
    } catch (e) { warn('bumpStat', e); }
  }

  // Serialised through the lock, so two flushes can never run at once.
  function flushStats() {
    if (statsTimer) { clearTimeout(statsTimer); statsTimer = null; }
    return withLock('stats', async function () {
      const delta = pendingStats;
      if (!Object.keys(delta).length) return;
      pendingStats = {};
      const r = await localGet(K.stats);
      const ok = r !== null && await (async function () {
        const s = readStatsFrom(r);
        Object.keys(delta).forEach(function (k) { s[k] += delta[k]; });
        return localSet({ [K.stats]: s });
      })();
      if (!ok) { // put the counts back so they are retried next time
        Object.keys(delta).forEach(function (k) { pendingStats[k] = (pendingStats[k] || 0) + delta[k]; });
      }
    });
  }

  async function resetStats() {
    if (statsTimer) { clearTimeout(statsTimer); statsTimer = null; }
    return withLock('stats', async function () {
      pendingStats = {};
      const s = clone(DEFAULTS.stats);
      s.lastReset = Date.now();
      await localSet({ [K.stats]: s });
      return s;
    });
  }

  // ---------------------------------------------------------------- activity
  let pendingActivity = []; // newest first
  let activityTimer = null;

  async function addActivity(row) {
    try {
      const settings = await getSettings();
      if (!settings.logging.activityEnabled || !isPlain(row)) return null;
      const full = Object.assign({}, row, { id: uuid(), ts: Date.now() });
      pendingActivity.unshift(full);
      if (pendingActivity.length > settings.logging.maxEntries) pendingActivity.length = settings.logging.maxEntries;
      if (!activityTimer) activityTimer = setTimeout(function () { flushActivity().catch(function () { /* logged */ }); }, DEBOUNCE_MS);
      return full;
    } catch (e) { warn('addActivity', e); return null; }
  }

  function flushActivity() {
    if (activityTimer) { clearTimeout(activityTimer); activityTimer = null; }
    return withLock('activity', async function () {
      if (!pendingActivity.length) return;
      const batch = pendingActivity;
      pendingActivity = [];
      const settings = await getSettings();
      const r = await localGet(K.activity);
      if (r === null) { pendingActivity = batch.concat(pendingActivity); return; }
      const old = Array.isArray(r[K.activity]) ? r[K.activity] : [];
      const merged = batch.concat(old).slice(0, settings.logging.maxEntries);
      const ok = await localSet({ [K.activity]: merged });
      if (!ok) pendingActivity = batch.concat(pendingActivity);
    });
  }

  async function getActivity(limit) {
    try {
      await flushActivity();
      const r = await localGet(K.activity);
      const list = r && Array.isArray(r[K.activity]) ? r[K.activity] : [];
      return typeof limit === 'number' && limit > 0 ? list.slice(0, limit) : list;
    } catch (e) { warn('getActivity', e); return []; }
  }

  async function clearActivity() {
    if (activityTimer) { clearTimeout(activityTimer); activityTimer = null; }
    return withLock('activity', async function () {
      pendingActivity = [];
      await localSet({ [K.activity]: [] });
      return true;
    });
  }

  async function flush() {
    try { await Promise.all([flushStats(), flushActivity()]); } catch (e) { warn('flush', e); }
  }

  // ------------------------------------------------------------ custom rules
  async function getCustomRules() {
    const r = await localGet(K.customRules);
    return sanitizeCustomRules(r && r[K.customRules]);
  }

  async function updateCustomRules(rules) {
    return withLock('customRules', async function () {
      const clean = sanitizeCustomRules(rules);
      await localSet({ [K.customRules]: clean });
      return clean;
    });
  }

  // ----------------------------------------------------------------- session
  function tabKey(id) { return String(id); }

  // Generic accessors for the three per-tab maps.
  function mapGet(storeKey, tabId) {
    return sessGet(storeKey).then(function (m) { return m && m[tabKey(tabId)] !== undefined ? m[tabKey(tabId)] : null; });
  }
  function mapSet(storeKey, tabId, value) {
    return withLock('sess:' + storeKey, async function () {
      const m = await sessGet(storeKey);
      if (m === null) return false;
      m[tabKey(tabId)] = value;
      // Safety cap so a long session can never grow the map without bound.
      const keys = Object.keys(m);
      if (keys.length > MAX_TAB_RECORDS) {
        keys.sort(function (a, b) { return (m[a] && m[a].ts || m[a] && m[a].createdAt || 0) - (m[b] && m[b].ts || m[b] && m[b].createdAt || 0); });
        keys.slice(0, keys.length - MAX_TAB_RECORDS).forEach(function (k) { delete m[k]; });
      }
      return sessSet(storeKey, m);
    });
  }
  function mapDelete(storeKey, tabId) {
    return withLock('sess:' + storeKey, async function () {
      const m = await sessGet(storeKey);
      if (m === null || m[tabKey(tabId)] === undefined) return false;
      delete m[tabKey(tabId)];
      return sessSet(storeKey, m);
    });
  }

  const session = {
    getTab: function (tabId) { return mapGet(K.tabs, tabId); },
    setTab: function (tabId, rec) { return mapSet(K.tabs, tabId, rec); },
    deleteTab: function (tabId) { return mapDelete(K.tabs, tabId); },
    pruneTabs: async function (liveIds) {
      const live = {};
      (Array.isArray(liveIds) ? liveIds : []).forEach(function (id) { live[tabKey(id)] = true; });
      for (const key of [K.tabs, K.safeUrl, K.recovery]) {
        await withLock('sess:' + key, async function () {
          const m = await sessGet(key);
          if (m === null) return;
          let changed = false;
          Object.keys(m).forEach(function (id) { if (!live[id]) { delete m[id]; changed = true; } });
          if (changed) await sessSet(key, m);
        });
      }
      return true;
    },
    getSafeUrl: function (tabId) { return mapGet(K.safeUrl, tabId).then(function (r) { return r && r.url ? r.url : null; }); },
    setSafeUrl: function (tabId, url) { return mapSet(K.safeUrl, tabId, { url: url, ts: Date.now() }); },
    getRecovery: function (tabId) { return mapGet(K.recovery, tabId); },
    setRecovery: function (tabId, rec) { return mapSet(K.recovery, tabId, Object.assign({}, rec, { ts: Date.now() })); },
    clearRecovery: function (tabId) { return mapDelete(K.recovery, tabId); }
  };

  // ----------------------------------------------------------- export/import
  async function exportConfig() {
    // Only configuration. Never activity or statistics history.
    return {
      app: 'smart-redirect-guard',
      schema: SCHEMA_VERSION,
      exportedAt: Date.now(),
      settings: await getSettings(),
      trusted: await getTrusted(),
      customRules: await getCustomRules()
    };
  }

  async function importConfig(data) {
    try {
      if (!isPlain(data) || data.app !== 'smart-redirect-guard') return { ok: false, error: 'not-an-srg-export' };
      if (typeof data.schema !== 'number' || data.schema > SCHEMA_VERSION || data.schema < 1) return { ok: false, error: 'unsupported-schema' };
      if (!isPlain(data.settings)) return { ok: false, error: 'invalid-settings' };
      if (!Array.isArray(data.trusted)) return { ok: false, error: 'invalid-trusted' };
      if (!isPlain(data.customRules)) return { ok: false, error: 'invalid-custom-rules' };
      const settings = normalizeSettings(mergeKnown(clone(DEFAULTS.settings), data.settings));
      const trusted = sanitizeTrusted(data.trusted);
      const rules = sanitizeCustomRules(data.customRules);
      const ok = await localSet({ [K.settings]: settings, [K.trusted]: trusted, [K.customRules]: rules, [K.seeded]: true });
      return ok ? { ok: true, settings: settings } : { ok: false, error: 'write-failed' };
    } catch (e) { warn('importConfig', e); return { ok: false, error: 'import-failed' }; }
  }

  function onChanged(cb) {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.onChanged) return function () {};
      const listener = function (changes, area) {
        if (area !== 'local') return;
        const mine = {};
        let any = false;
        Object.keys(changes).forEach(function (k) {
          if (k.indexOf('srg.') === 0 && k.indexOf(SESSION_PREFIX) !== 0) { mine[k] = changes[k]; any = true; }
        });
        if (any) { try { cb(mine); } catch (e) { warn('onChanged callback', e); } }
      };
      chrome.storage.onChanged.addListener(listener);
      return function () { try { chrome.storage.onChanged.removeListener(listener); } catch (e) { /* ignore */ } };
    } catch (e) { warn('onChanged', e); return function () {}; }
  }

  // --------------------------------------------------------------- bootstrap
  // MIGRATIONS[n] upgrades stored data from version n-1 to n. Add one entry per
  // future schema bump; they run in order for installs that are behind.
  const MIGRATIONS = {
    1: async function () { /* first schema: defaults are installed below */ }
  };

  async function bootstrap() {
    try {
      const s = sessionArea();
      if (s && s.fallback) { // old Chrome: emulate session storage by wiping the fallback keys
        try { await chrome.storage.local.remove([K.tabs, K.safeUrl, K.recovery].map(function (k) { return SESSION_PREFIX + k; })); } catch (e) { warn('fallback wipe', e); }
      }
      const r = await localGet(null);
      if (r === null) return clone(DEFAULTS.settings);
      let from = typeof r[K.version] === 'number' ? r[K.version] : 0;
      while (from < SCHEMA_VERSION) {
        from += 1;
        if (MIGRATIONS[from]) { try { await MIGRATIONS[from](r); } catch (e) { warn('migration ' + from, e); } }
      }
      const settings = normalizeSettings(mergeKnown(clone(DEFAULTS.settings), r[K.settings]));
      const writes = {};
      writes[K.version] = SCHEMA_VERSION;
      writes[K.settings] = settings;
      if (!Array.isArray(r[K.trusted])) writes[K.trusted] = [];
      if (!isPlain(r[K.stats])) { const st = clone(DEFAULTS.stats); st.lastReset = Date.now(); writes[K.stats] = st; }
      if (!Array.isArray(r[K.activity])) writes[K.activity] = [];
      writes[K.customRules] = sanitizeCustomRules(r[K.customRules]);
      await localSet(writes);
      return settings;
    } catch (e) { warn('bootstrap', e); return clone(DEFAULTS.settings); }
  }

  // Wrap every public async method so nothing can throw out to a caller.
  function safe(fn, fallback, name) {
    return async function () {
      try { return await fn.apply(null, arguments); } catch (e) { warn(name, e); return typeof fallback === 'function' ? fallback() : fallback; }
    };
  }

  const api = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    DEFAULTS: DEFAULTS,
    bootstrap: safe(bootstrap, function () { return clone(DEFAULTS.settings); }, 'bootstrap'),
    getSettings: safe(getSettings, function () { return clone(DEFAULTS.settings); }, 'getSettings'),
    updateSettings: safe(updateSettings, function () { return clone(DEFAULTS.settings); }, 'updateSettings'),
    resetSettings: safe(resetSettings, function () { return clone(DEFAULTS.settings); }, 'resetSettings'),
    getTrusted: safe(getTrusted, [], 'getTrusted'),
    addTrusted: safe(addTrusted, [], 'addTrusted'),
    removeTrusted: safe(removeTrusted, [], 'removeTrusted'),
    seedTrustedOnce: safe(seedTrustedOnce, false, 'seedTrustedOnce'),
    isTrusted: safe(isTrusted, false, 'isTrusted'),
    getStats: safe(getStats, function () { return clone(DEFAULTS.stats); }, 'getStats'),
    bumpStat: bumpStat,
    flush: flush,
    resetStats: safe(resetStats, function () { return clone(DEFAULTS.stats); }, 'resetStats'),
    getActivity: getActivity,
    addActivity: addActivity,
    clearActivity: safe(clearActivity, false, 'clearActivity'),
    getCustomRules: safe(getCustomRules, function () { return clone(DEFAULTS.customRules); }, 'getCustomRules'),
    updateCustomRules: safe(updateCustomRules, function () { return clone(DEFAULTS.customRules); }, 'updateCustomRules'),
    session: {
      getTab: safe(session.getTab, null, 'session.getTab'),
      setTab: safe(session.setTab, false, 'session.setTab'),
      deleteTab: safe(session.deleteTab, false, 'session.deleteTab'),
      pruneTabs: safe(session.pruneTabs, false, 'session.pruneTabs'),
      getSafeUrl: safe(session.getSafeUrl, null, 'session.getSafeUrl'),
      setSafeUrl: safe(session.setSafeUrl, false, 'session.setSafeUrl'),
      getRecovery: safe(session.getRecovery, null, 'session.getRecovery'),
      setRecovery: safe(session.setRecovery, false, 'session.setRecovery'),
      clearRecovery: safe(session.clearRecovery, false, 'session.clearRecovery')
    },
    exportConfig: safe(exportConfig, null, 'exportConfig'),
    importConfig: safe(importConfig, { ok: false, error: 'import-failed' }, 'importConfig'),
    onChanged: onChanged
  };

  root.SRGStorage = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof self !== 'undefined' ? self : this);
