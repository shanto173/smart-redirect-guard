/*
 * background/detection-engine.js
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE DOES
 *   The "judge" of Smart Redirect Guard. Other files collect facts (a tab was
 *   opened, a page redirected, an element looks like an ad). This file takes
 *   those facts and returns a verdict: "high", "medium" or "low" confidence
 *   that something is an advertisement, plus the reasons why.
 *
 * WHY IT IS WRITTEN THIS WAY
 *   - It is PURE: no chrome.* calls, no storage, no async, no network. The same
 *     input always gives the same output, so it can be unit-tested in plain
 *     Node (see the bottom of the file) and is easy to audit for false
 *     positives.
 *   - Scoring is additive. Each clue has a weight in the WEIGHTS table below.
 *     Strong "this is fine" clues (login pages, trusted sites, SRG's own tabs)
 *     act as a VETO and return "low" immediately.
 *   - A "high" verdict ALWAYS needs a real rule match (a listed ad domain, an
 *     ad URL pattern, or for elements an ad selector / ad iframe host).
 *     Behaviour alone (no gesture, redirects ...) can never reach "high".
 *     That is the main protection against closing legitimate tabs.
 *   - Never assume an unfamiliar domain is malicious: unknown domains score low.
 */
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ tables
  // The element table is duplicated in content/element-detector.js (content
  // scripts cannot import this file). A test checks the two copies match.
  const WEIGHTS = Object.freeze({
    thresholds: Object.freeze({ high: 70, medium: 40 }),
    tab: Object.freeze({
      adDomain: 55, suspiciousDomain: 30, urlPattern: 30,
      chain3: 20, chain2: 10,
      crossSite: 10, sameSite: -25, noOpener: -20,
      noGesture: 15, rapid: 5, rapidMs: 300
    }),
    nav: Object.freeze({
      adDomain: 55, suspiciousDomain: 30, urlPattern: 30,
      clientRedirect: 25, serverRedirect: 10, userClick: -20,
      chain3: 15, instantBounce: 10, instantBounceMs: 1500,
      crossSite: 5, sameSite: -30
    }),
    // Element weights live in shared/element-scoring.js (ELEMENT_WEIGHTS) so the
    // page-side detector and this engine use one single table. Exposed below.
  });

  // Words that mean "this is probably sign-in, payment or a download". Written
  // with '-' between words that are separate tokens (sign-in = "sign" "in").
  const VETO_PATH_TOKENS = Object.freeze([
    'login', 'logon', 'signin', 'signon', 'sign-in', 'sign-on', 'log-in', 'log-on',
    'oauth', 'oauth2', 'auth', 'authorize', 'authenticate', 'authentication',
    'sso', 'saml', 'checkout', 'payment', 'payments', 'billing', '3ds',
    'download', 'downloads', 'captcha', 'verify', 'verification', '2fa', 'mfa',
    'account-recovery'
  ]);

  // Two-part public suffixes (the "co.uk" problem: example.co.uk, not co.uk).
  const TWO_PART_SUFFIXES = Object.freeze(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'co.jp',
    'com.br', 'co.in', 'co.nz', 'com.mx', 'co.za', 'com.tr', 'com.sg', 'com.hk']);

  // ------------------------------------------------------------- rule state
  let rules = { adDomains: [], suspiciousDomains: [], urlPatterns: [], trustedDomains: [] };
  let compiledPatterns = [];

  function cleanList(list) {
    const out = [];
    (Array.isArray(list) ? list : []).forEach(function (v) {
      if (typeof v === 'string') {
        const t = v.trim().toLowerCase();
        if (t && out.indexOf(t) === -1) out.push(t);
      }
    });
    return out;
  }

  function escapeRegex(s) { return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'); }

  // A pattern with '*' is a wildcard match; otherwise it is a plain substring.
  function compilePattern(p) {
    try {
      if (p.indexOf('*') === -1) return { raw: p, test: function (u) { return u.indexOf(p) !== -1; } };
      const re = new RegExp(p.split('*').map(escapeRegex).join('.*'));
      return { raw: p, test: function (u) { return re.test(u); } };
    } catch (e) { return null; }
  }

  function setRules(r) {
    const src = r && typeof r === 'object' ? r : {};
    rules = {
      adDomains: cleanList(src.adDomains).map(stripDomain).filter(Boolean),
      suspiciousDomains: cleanList(src.suspiciousDomains).map(stripDomain).filter(Boolean),
      urlPatterns: cleanList(src.urlPatterns),
      trustedDomains: cleanList(src.trustedDomains).map(stripDomain).filter(Boolean)
    };
    compiledPatterns = rules.urlPatterns.map(compilePattern).filter(Boolean);
    return true;
  }

  function stripDomain(d) { return d.replace(/^\*?\.?/, '').replace(/^www\./, '').replace(/\.$/, ''); }

  // ------------------------------------------------------------- URL helpers
  function registrableDomain(host) {
    if (typeof host !== 'string' || !host) return '';
    const h = host.toLowerCase().replace(/\.$/, '');
    if (h === 'localhost' || h.indexOf(':') !== -1 || /^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return h; // IPs, localhost
    const parts = h.split('.');
    if (parts.length <= 2) return h;
    const last2 = parts.slice(-2).join('.');
    if (TWO_PART_SUFFIXES.indexOf(last2) !== -1) return parts.slice(-3).join('.');
    return last2; // generic fallback: last two labels
  }

  function parseUrl(url) {
    try {
      if (typeof url !== 'string' || !url) return { ok: false };
      const u = new URL(url);
      const host = u.hostname.toLowerCase();
      return {
        ok: true, href: u.href, host: host, registrable: registrableDomain(host),
        path: u.pathname, query: u.search, protocol: u.protocol
      };
    } catch (e) { return { ok: false }; }
  }

  function isIgnorableUrl(url) {
    const p = parseUrl(url);
    return !p.ok || (p.protocol !== 'http:' && p.protocol !== 'https:') || !p.host;
  }

  function isSameSite(a, b) {
    const pa = parseUrl(a);
    const pb = parseUrl(b);
    return pa.ok && pb.ok && !!pa.registrable && pa.registrable === pb.registrable;
  }

  function safeDecode(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }

  // Split on anything that is not a letter/digit (covers . / _ - ? = & etc.),
  // so "logindexing" is ONE token and does not match "login", while
  // "/user/login?x=1" gives [user, login, x, 1] and does.
  function tokenize(s) {
    return safeDecode(s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  }

  function hasVetoSignal(url) {
    const p = parseUrl(url);
    if (!p.ok) return { veto: false, reason: '' };
    const stream = '.' + tokenize(p.host + ' ' + p.path + ' ' + p.query).join('.') + '.';
    for (let i = 0; i < VETO_PATH_TOKENS.length; i++) {
      const t = VETO_PATH_TOKENS[i];
      if (stream.indexOf('.' + t.replace(/-/g, '.') + '.') !== -1) return { veto: true, reason: 'veto-token:' + t };
    }
    return { veto: false, reason: '' };
  }

  function hostMatches(host, reg, entry) {
    return host === entry || host.endsWith('.' + entry) || reg === entry;
  }

  function findDomain(list, p) {
    for (let i = 0; i < list.length; i++) if (hostMatches(p.host, p.registrable, list[i])) return list[i];
    return null;
  }

  function findPattern(p) {
    const href = p.href.toLowerCase();
    for (let i = 0; i < compiledPatterns.length; i++) if (compiledPatterns[i].test(href)) return compiledPatterns[i].raw;
    return null;
  }

  function isTrustedByRules(p) { return !!findDomain(rules.trustedDomains, p); }

  // ----------------------------------------------------------------- verdict
  // `ruleHit` says whether a real rule matched. Without it, "high" is refused.
  function makeVerdict(score, reasons, matchedRule, ruleHit) {
    let s = Math.max(0, Math.min(100, Math.round(score)));
    let confidence = s >= WEIGHTS.thresholds.high ? 'high' : s >= WEIGHTS.thresholds.medium ? 'medium' : 'low';
    if (confidence === 'high' && !ruleHit) {
      confidence = 'medium';
      s = WEIGHTS.thresholds.high - 1;
      reasons.push('high-requires-rule-match');
    }
    return { confidence: confidence, score: s, reasons: reasons, matchedRule: matchedRule || null };
  }

  function lowVerdict(reason) { return { confidence: 'low', score: 0, reasons: [reason], matchedRule: null }; }

  // Shared by tab and navigation scoring: adds the three rule-based clues.
  function scoreRules(p, w, st) {
    const ad = findDomain(rules.adDomains, p);
    if (ad) { st.score += w.adDomain; st.reasons.push('ad-domain-match'); st.matched = st.matched || 'adDomains:' + ad; st.ruleHit = true; }
    const sus = findDomain(rules.suspiciousDomains, p);
    if (sus) { st.score += w.suspiciousDomain; st.reasons.push('suspicious-domain-match'); st.matched = st.matched || 'suspiciousDomains:' + sus; }
    const pat = findPattern(p);
    if (pat) { st.score += w.urlPattern; st.reasons.push('ad-url-pattern'); st.matched = st.matched || 'urlPatterns:' + pat; st.ruleHit = true; }
  }

  // Common early exits. Returns a low verdict, or null to keep scoring.
  function earlyExit(ctx, p) {
    if (!p.ok || isIgnorableUrl(ctx.url)) return lowVerdict('ignorable-url');
    const veto = hasVetoSignal(ctx.url);
    if (veto.veto) return lowVerdict(veto.reason);
    if (ctx.trusted === true || isTrustedByRules(p)) return lowVerdict('trusted');
    return null;
  }

  // ------------------------------------------------------------ classifyTab
  function classifyTab(ctx) {
    try {
      if (!ctx || typeof ctx !== 'object') return lowVerdict('no-context');
      const p = parseUrl(ctx.url);
      const early = earlyExit(ctx, p);
      if (early) return early;
      if (ctx.srgOpened === true) return lowVerdict('srg-opened');

      const w = WEIGHTS.tab;
      const st = { score: 0, reasons: [], matched: null, ruleHit: false };
      scoreRules(p, w, st);

      const hist = Array.isArray(ctx.urlHistory) ? ctx.urlHistory.length : 0;
      if (hist >= 3) { st.score += w.chain3; st.reasons.push('redirect-chain'); }
      else if (hist === 2) { st.score += w.chain2; st.reasons.push('short-redirect'); }

      if (!ctx.openerUrl) { st.score += w.noOpener; st.reasons.push('no-opener'); }
      else if (!isIgnorableUrl(ctx.openerUrl)) {
        if (isSameSite(ctx.url, ctx.openerUrl)) { st.score += w.sameSite; st.reasons.push('same-site-as-opener'); }
        else { st.score += w.crossSite; st.reasons.push('cross-site-from-opener'); }
      }

      if (ctx.userGesture === false) { st.score += w.noGesture; st.reasons.push('no-user-gesture'); }

      if (typeof ctx.createdAt === 'number' && typeof ctx.now === 'number' &&
          ctx.now - ctx.createdAt >= 0 && ctx.now - ctx.createdAt < w.rapidMs) {
        st.score += w.rapid; st.reasons.push('rapid-navigation');
      }
      return makeVerdict(st.score, st.reasons, st.matched, st.ruleHit);
    } catch (e) { return lowVerdict('error'); }
  }

  // ------------------------------------------------------- classifyNavigation
  function classifyNavigation(ctx) {
    try {
      if (!ctx || typeof ctx !== 'object') return lowVerdict('no-context');
      const p = parseUrl(ctx.url);
      const early = earlyExit(ctx, p);
      if (early) return early;

      const w = WEIGHTS.nav;
      const st = { score: 0, reasons: [], matched: null, ruleHit: false };
      scoreRules(p, w, st);

      const q = Array.isArray(ctx.transitionQualifiers) ? ctx.transitionQualifiers : [];
      if (q.indexOf('client_redirect') !== -1) { st.score += w.clientRedirect; st.reasons.push('client-redirect'); }
      if (q.indexOf('server_redirect') !== -1) { st.score += w.serverRedirect; st.reasons.push('server-redirect'); }
      if (ctx.transitionType === 'link') { st.score += w.userClick; st.reasons.push('user-click'); }
      if (typeof ctx.chainLength === 'number' && ctx.chainLength >= 3) { st.score += w.chain3; st.reasons.push('long-chain'); }
      if (typeof ctx.timeSinceLastNav === 'number' && ctx.timeSinceLastNav >= 0 && ctx.timeSinceLastNav < w.instantBounceMs) {
        st.score += w.instantBounce; st.reasons.push('instant-bounce');
      }
      if (ctx.previousUrl && !isIgnorableUrl(ctx.previousUrl)) {
        if (isSameSite(ctx.url, ctx.previousUrl)) { st.score += w.sameSite; st.reasons.push('same-site-navigation'); }
        else { st.score += w.crossSite; st.reasons.push('cross-site-navigation'); }
      }
      return makeVerdict(st.score, st.reasons, st.matched, st.ruleHit);
    } catch (e) { return lowVerdict('error'); }
  }

  // ------------------------------------------------------ scoreElementSignals
  /*
   * Element scoring is NOT implemented here. It lives in shared/element-scoring.js, which the
   * service worker loads with importScripts and the manifest also injects as a content script.
   * One file, loaded by both worlds, so the page-side detector and this engine can never
   * disagree about what counts as an ad. This is a thin forwarder kept for API compatibility.
   */
  function scoreElementSignals(signals, settings) {
    try {
      const shared = root.SRGElementScoring;
      if (!shared) {
        // The shared module failed to load; fail open rather than guessing.
        return lowVerdict('element-scoring-unavailable');
      }
      return shared.scoreElementSignals(signals, settings);
    } catch (e) { return lowVerdict('error'); }
  }

  const api = {
    WEIGHTS: WEIGHTS,
    get ELEMENT_WEIGHTS() {
      return root.SRGElementScoring ? root.SRGElementScoring.ELEMENT_WEIGHTS : null;
    },
    VETO_PATH_TOKENS: VETO_PATH_TOKENS,
    setRules: setRules,
    parseUrl: parseUrl,
    registrableDomain: registrableDomain,
    isSameSite: isSameSite,
    isIgnorableUrl: isIgnorableUrl,
    hasVetoSignal: hasVetoSignal,
    classifyTab: classifyTab,
    classifyNavigation: classifyNavigation,
    scoreElementSignals: scoreElementSignals
  };

  root.SRGDetect = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = root.SRGDetect; }
})(typeof self !== 'undefined' ? self : this);
