/*
 * SRG shared/element-scoring.js  -  the ONE element scoring table and function.
 *
 * WHY THIS FILE EXISTS (plain language)
 *   Two completely different parts of the extension need to answer "how ad-like is this page
 *   element?":
 *     - content/element-detector.js, which runs inside the web page and does the real work
 *     - background/detection-engine.js, which exposes the same logic so it can be unit-tested
 *       and so every layer scores things the same way
 *   A content script cannot importScripts() a background file, so the obvious approach is to
 *   copy the scoring code into both. Copies drift apart, and a silently drifted ad-blocker is
 *   a broken ad-blocker.
 *
 *   So instead this single file is loaded by BOTH worlds:
 *     - the service worker loads it with importScripts('../shared/element-scoring.js')
 *     - the manifest lists it as the first content script, before element-detector.js
 *   One file, one table, no drift, nothing to keep in sync.
 *
 * WHAT IT IS
 *   A pure function. No Chrome APIs, no DOM access, no I/O. It is handed a plain "signals"
 *   object that somebody else collected, and it returns a verdict. That also means plain Node
 *   can require() it in the tests.
 *
 * THE RULE THAT KEEPS FALSE POSITIVES DOWN
 *   "high" confidence is only reachable with explicit evidence - a known ad selector/identifier
 *   or a known ad iframe host. Layout heuristics (floating, big, high z-index, appeared late)
 *   can reach "medium" at most, and medium never hides anything unless the user opts in.
 */
(function (root) {
  'use strict';

  /*
   * The scoring table. Positive numbers mean "more ad-like", negative mean "leave it alone".
   *
   * Note the two thresholds: selectorHigh (80) on its own clears high (70), because a match
   * against a known ad container selector IS the evidence. iframeHost (75) likewise. Nothing
   * else can get there alone - the biggest heuristic stack (fixed + z-index + full coverage +
   * appeared late + outbound ad link = 15+10+20+10+25 = 80) is deliberately still blocked from
   * "high" by the explicit-evidence requirement below.
   */
  var ELEMENT_WEIGHTS = Object.freeze({
    selectorHigh: 80,        // matches a high-confidence selector or id/class token
    selectorMedium: 35,      // matches a medium-confidence selector or id/class token
    iframeHost: 75,          // iframe src host / URL matches the ad list

    fixed: 15,               // position: fixed
    sticky: 8,               // position: sticky
    zIndexHigh: 10,          // z-index >= zIndexThreshold
    zIndexThreshold: 1000,
    coverageLarge: 20,       // covers >= coverageLargeMin of the viewport
    coverageLargeMin: 0.5,
    coverageMedium: 10,      // covers >= coverageMediumMin of the viewport
    coverageMediumMin: 0.2,
    appearedAfterLoad: 10,   // injected after the page finished loading
    outboundAdLink: 25,      // links to a third-party ad destination

    formInput: -30,          // contains real form inputs (probably an app control)
    video: -40,              // contains a video / player
    textHint: -15,           // per matched "do not touch" phrase from allow.textHints
    textHintCap: -45,        // ... capped, so wording alone is a brake, not a veto

    promoHint: 8,            // per matched promotional word (weak, positive)
    promoHintCap: 16,        // ... capped, so wording alone never decides anything

    highMin: 70,             // score needed for "high" (AND explicit evidence is required)
    mediumMin: 35            // score needed for "medium"
  });

  /* Weak promotional wording. Deliberately only worth a few points: plenty of legitimate
     content says "special offer". Used as a tie-breaker, never as evidence on its own. */
  var PROMO_WORDS = Object.freeze([
    'sponsored', 'advertisement', 'advert', 'ad choices', 'ads by', 'promoted',
    'special offer', 'limited offer', 'free gift', 'you won', 'claim your prize',
    'click here', 'install now', 'download now', 'act now'
  ]);

  function defaultElementSettings() {
    return {
      floatingDetection: true,
      overlayDetection: true,
      stickyDetection: true,
      iframeDetection: true
    };
  }

  /*
   * signals = {
   *   selectorMatch: "high" | "medium" | null,
   *   iframeHostMatch: bool,
   *   fixed: bool, sticky: bool, zIndex: number, viewportCoverage: 0..1,
   *   appearedAfterLoad: bool, hasOutboundAdLink: bool,
   *   hasFormInput: bool, hasVideo: bool,
   *   allowMatch: bool,            // hard veto - the element is allow-listed
   *   textHints: string[],         // matched allow.textHints ("sign in", "accept cookies", ...)
   *   promoHints: string[]         // matched promotional words
   * }
   * settings = the element-layer settings object (toggles); missing keys default to enabled.
   *
   * returns { confidence, score, reasons, matchedRule }
   */
  function scoreElementSignals(signals, settings) {
    var s = signals || {};
    var cfg = settings || defaultElementSettings();

    // Hard veto. An allow-listed element is never an ad, whatever else matched.
    if (s.allowMatch) {
      return { confidence: 'low', score: 0, reasons: ['allow-listed'], matchedRule: null };
    }

    var W = ELEMENT_WEIGHTS;
    var score = 0;
    var reasons = [];
    var rule = null;

    var iframeHit = !!s.iframeHostMatch && cfg.iframeDetection !== false;

    if (s.selectorMatch === 'high') {
      score += W.selectorHigh;
      reasons.push('known ad selector/identifier');
      rule = 'selector:high';
    } else if (s.selectorMatch === 'medium') {
      score += W.selectorMedium;
      reasons.push('promotional selector/identifier');
      rule = 'selector:medium';
    }
    if (iframeHit) {
      score += W.iframeHost;
      reasons.push('ad iframe host');
      rule = rule || 'iframe-host';
    }

    // Floating / sticky behaviour - only if the user left those detectors on.
    if (cfg.floatingDetection !== false) {
      if (s.fixed) { score += W.fixed; reasons.push('position:fixed'); }
      if (s.sticky && cfg.stickyDetection !== false) { score += W.sticky; reasons.push('position:sticky'); }
    }

    // Overlay behaviour: stacked above the page and/or covering a lot of it.
    if (cfg.overlayDetection !== false) {
      if (Number(s.zIndex) >= W.zIndexThreshold) { score += W.zIndexHigh; reasons.push('high z-index'); }
      var cov = Number(s.viewportCoverage) || 0;
      if (cov >= W.coverageLargeMin) { score += W.coverageLarge; reasons.push('covers most of the viewport'); }
      else if (cov >= W.coverageMediumMin) { score += W.coverageMedium; reasons.push('covers part of the viewport'); }
    }

    if (s.appearedAfterLoad) { score += W.appearedAfterLoad; reasons.push('injected after load'); }
    if (s.hasOutboundAdLink) { score += W.outboundAdLink; reasons.push('outbound ad link'); }

    // Negative evidence: these say "this is part of the site, not an ad".
    if (s.hasFormInput) { score += W.formInput; reasons.push('contains form inputs'); }
    if (s.hasVideo) { score += W.video; reasons.push('contains video/player'); }

    var allowHints = Array.isArray(s.textHints) ? s.textHints : [];
    var explicit = s.selectorMatch === 'high' || iframeHit;
    if (allowHints.length) {
      // Protective wording ("sign in", "accept cookies", "download") is a BRAKE on guesswork,
      // not an override of evidence:
      //   - with no explicit match, it subtracts (capped), which is where false positives live
      //   - with an explicit ad-selector / ad-iframe match it is recorded but not subtracted,
      //     because real ads say "download now" too and the rule match is the stronger signal
      // The HARD protections (allow selectors, a contained password field, a video, a captcha,
      // an auth/payment form, covering the whole page) are vetoes applied before scoring.
      if (!explicit) { score += Math.max(W.textHint * allowHints.length, W.textHintCap); }
      reasons.push('protective text: ' + allowHints.join('|') + (explicit ? ' (not applied: explicit rule match)' : ''));
    }

    var promo = Array.isArray(s.promoHints) ? s.promoHints : [];
    if (promo.length) {
      score += Math.min(W.promoHint * promo.length, W.promoHintCap);
      reasons.push('promotional wording: ' + promo.join('|'));
    }

    var confidence = 'low';
    // THE false-positive guard: "high" requires explicit evidence, never heuristics alone.
    if ((s.selectorMatch === 'high' || iframeHit) && score >= W.highMin) {
      confidence = 'high';
    } else if (score >= W.mediumMin) {
      confidence = 'medium';
    }

    if (confidence === 'low') { rule = null; }
    else if (!rule) { rule = 'heuristic'; }

    return { confidence: confidence, score: score, reasons: reasons, matchedRule: rule };
  }

  /* Find promotional words in a lowercased text sample. Shared so both worlds agree. */
  function findPromoHints(lowerText) {
    var out = [];
    if (typeof lowerText !== 'string' || !lowerText) { return out; }
    for (var i = 0; i < PROMO_WORDS.length; i++) {
      if (lowerText.indexOf(PROMO_WORDS[i]) !== -1) { out.push(PROMO_WORDS[i]); }
    }
    return out;
  }

  var api = {
    ELEMENT_WEIGHTS: ELEMENT_WEIGHTS,
    PROMO_WORDS: PROMO_WORDS,
    scoreElementSignals: scoreElementSignals,
    findPromoHints: findPromoHints,
    defaultElementSettings: defaultElementSettings
  };

  root.SRGElementScoring = api;

  // Lets tests require() this file directly in plain Node.
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof self !== 'undefined' ? self : this);
