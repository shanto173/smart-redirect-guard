/*
 * SRG element-detector.js  -  "Is this piece of the page an advertisement?"
 *
 * WHAT THIS FILE DOES (plain language)
 *   This is the judging part of Layer 3 (element-level ad blocking). Given a page element it
 *   collects facts about it ("signals": does it look like a known ad container? is it floating
 *   over the page? does it cover the screen? does it contain a login form?), adds those facts up
 *   with a small scoring table, and returns a verdict: "high", "medium" or "low" confidence.
 *   It never changes the page. Hiding is the job of element-blocker.js.
 *
 * WHY THERE IS A COPY OF THE SCORING TABLE HERE
 *   The background service worker has its own scoring code (SRGDetect.scoreElementSignals).
 *   Content scripts cannot import background files, so this file carries an identical copy of
 *   the weights in SRG.detector.WEIGHTS. A test compares the two so they cannot drift apart.
 *
 * THE CROSS-ORIGIN IFRAME LIMITATION
 *   When a page embeds <iframe src="https://other-site.test/...">, the browser's same-origin
 *   policy lets us see the iframe ELEMENT from the parent page (its src, size, position) but
 *   never the page INSIDE it. No extension permission changes that. So for iframes we can only
 *   judge by URL (host / URL pattern) and by how the frame box is placed on the page. If the
 *   content script also runs inside the frame (all_frames), it judges that frame's own DOM
 *   independently, but only for frames the browser lets it enter.
 *
 * SAFETY RULES BAKED IN
 *   - "high" confidence is only possible with an explicit selector match or ad-iframe match.
 *     Layout heuristics alone can reach "medium" at most.
 *   - Anything allow-listed (cookie banners, logins, payments, video players, navigation,
 *     dialogs, captcha ...) is never touched, and neither is anything that contains a password
 *     field, a video, an auth/payment form or a captcha.
 *   - Fail open: any exception means "low" (leave the element visible).
 *   - getComputedStyle is called at most once per element per evaluation.
 */
(function () {
  'use strict';

  window.SRG = window.SRG || {};
  var SRG = window.SRG;

  /* ------------------------------------------------------------------ */
  /* Built-in example rules (same content as rules/element-selectors.json). */
  /* They are ILLUSTRATIVE EXAMPLES; rules supplied through configure()   */
  /* are merged on top of them. The allow list is always applied.         */
  /* ------------------------------------------------------------------ */
  var DEFAULTS = {
    "high": {
      "selectors": [
        "[id=\"ad-container\"]",
        "[class~=\"advertisement\"]",
        ".ad-banner",
        ".adsbygoogle",
        "ins.adsbygoogle",
        "[data-ad-slot]",
        "[data-ad-client]",
        "#banner-ad",
        ".sponsored-ad",
        ".ad-wrapper",
        ".adunit",
        ".ad-slot",
        ".popunder",
        ".ad-overlay",
        ".advertisement-popup",
        "[aria-label=\"advertisement\" i]",
        "[id=\"ad-wrapper\"]",
        "[id=\"ad-banner\"]",
        "[id=\"advertisement\"]",
        ".ad-container",
        ".ad-box",
        ".adbox",
        ".ad-unit",
        ".advert",
        ".advertisement",
        ".ad-placeholder",
        ".ad-leaderboard",
        ".ad-sidebar",
        ".ad-interstitial",
        ".interstitial-ad",
        ".ad-popup",
        ".popup-ad",
        ".banner-ad",
        ".google-ad",
        ".google-ads",
        "[id^=\"google_ads_\"]",
        "[id^=\"div-gpt-ad\"]",
        "[data-google-query-id]",
        "[data-ad-unit]",
        "[data-ad-unit-id]",
        "[data-adunit]",
        "[aria-label=\"sponsored\" i]",
        "[data-advertisement]",
        ".sponsored-banner",
        ".ad-modal",
        ".adslot",
        ".ad-frame",
        "iframe[id^=\"google_ads_iframe\"]",
        ".fullscreen-ad"
      ],
      "idClassTokens": [
        "ad",
        "ads",
        "advert",
        "adverts",
        "advertisement",
        "advertising",
        "adbanner",
        "adbox",
        "adslot",
        "adunit",
        "adwrapper",
        "adcontainer",
        "adsense",
        "adsbygoogle",
        "banner-ad",
        "google-ad",
        "google-ads",
        "sponsored",
        "sponsored-ad",
        "popunder",
        "interstitial-ad",
        "ad-banner",
        "ad-container",
        "ad-slot",
        "ad-unit",
        "ad-wrapper",
        "ad-box",
        "ad-overlay",
        "popup-ad",
        "ad-popup"
      ],
      "iframeHosts": [
        "ads.example-adnetwork.test",
        "banner.example-ads.test",
        "popunder.example.test",
        "serve.example-adserver.test",
        "cdn.example-adcdn.test",
        "track.example-adtrack.invalid",
        "display.example-display.test",
        "sponsor.example-sponsor.example",
        "promo.example-promo.test",
        "adx.example-exchange.test",
        "native.example-native.test",
        "pop.example-pop.invalid",
        "syndication.example-syndication.test",
        "creative.example-creative.test",
        "rtb.example-rtb.test"
      ]
    },
    "medium": {
      "selectors": [
        ".floating-banner",
        ".sticky-promo",
        ".promo-overlay",
        "[class*=\"promo-popup\"]",
        ".offer-modal",
        ".sticky-banner",
        ".promo-banner",
        ".promo-modal",
        ".special-offer",
        "[class*=\"special-offer\"]",
        ".fixed-promo",
        "[class*=\"floating-promo\"]",
        ".promo-bar",
        ".promotion-popup",
        ".offer-popup",
        ".lightbox-promo",
        "[class*=\"sticky-promo\"]",
        "[id*=\"promo-popup\"]",
        ".bottom-sticky-banner",
        "[class*=\"offer-overlay\"]"
      ],
      "idClassTokens": [
        "promo",
        "promotion",
        "promo-popup",
        "promo-overlay",
        "promo-banner",
        "floating-banner",
        "sticky-promo",
        "floating-promo",
        "special-offer",
        "offer-modal",
        "offer-popup",
        "offer-overlay",
        "sponsor",
        "promoted",
        "sticky-banner",
        "fixed-promo",
        "lightbox-promo",
        "takeover",
        "page-takeover",
        "overlay-promo",
        "deal-popup",
        "giveaway"
      ]
    },
    "allow": {
      "selectors": [
        "#onetrust-banner-sdk",
        ".cc-window",
        "[id*=\"cookie\" i]",
        "[class*=\"consent\" i]",
        "[aria-label*=\"cookie\" i]",
        "[id*=\"consent\" i]",
        "[class*=\"cookie\" i]",
        "#CybotCookiebotDialog",
        ".truste_box_overlay",
        "form[action*=\"login\"]",
        "[id*=\"login\" i]",
        "[class*=\"signin\" i]",
        "[class*=\"login\" i]",
        "[id*=\"signin\" i]",
        "[class*=\"auth-\" i]",
        "[class*=\"checkout\" i]",
        "[id*=\"payment\" i]",
        "[class*=\"payment\" i]",
        "iframe[src*=\"stripe\"]",
        "iframe[src*=\"paypal\"]",
        "iframe[name*=\"3ds\"]",
        "[id*=\"checkout\" i]",
        "video",
        ".video-player",
        ".jwplayer",
        ".plyr",
        "iframe[src*=\"youtube.com/embed\"]",
        "iframe[src*=\"player.vimeo\"]",
        ".vjs-player",
        ".video-js",
        "nav",
        "header nav",
        "[role=\"navigation\"]",
        ".navbar",
        ".menu",
        ".sidebar-nav",
        "[role=\"dialog\"]",
        "[role=\"alertdialog\"]",
        "dialog",
        ".modal-dialog",
        "[class*=\"download\" i]",
        "[id*=\"download\" i]",
        "[role=\"alert\"]",
        "[role=\"status\"]",
        ".toast",
        ".notification",
        "[role=\"toolbar\"]",
        "[role=\"tablist\"]",
        ".app-shell",
        "iframe[src*=\"recaptcha\"]",
        "iframe[src*=\"hcaptcha\"]",
        ".g-recaptcha",
        "iframe[title*=\"captcha\" i]",
        ".h-captcha",
        "html",
        "body",
        "main",
        "[role=\"main\"]",
        "#root",
        "#app",
        "#__next"
      ],
      "textHints": [
        "accept cookies",
        "accept all cookies",
        "cookie policy",
        "cookie settings",
        "manage preferences",
        "sign in",
        "log in",
        "login",
        "password",
        "two-factor",
        "verification code",
        "verify",
        "checkout",
        "card number",
        "cvv",
        "billing",
        "payment",
        "download",
        "i agree",
        "privacy settings",
        "privacy policy",
        "consent",
        "reject all",
        "terms of service",
        "captcha"
      ]
    },
    "adDomains": [
      "ads.example-adnetwork.test",
      "banner.example-ads.test",
      "popunder.example.test",
      "serve.example-adserver.test",
      "cdn.example-adcdn.test",
      "track.example-adtrack.invalid",
      "display.example-display.test",
      "promo.example-promo.test",
      "adx.example-exchange.test",
      "native.example-native.test",
      "pop.example-pop.invalid",
      "syndication.example-syndication.test",
      "creative.example-creative.test",
      "rtb.example-rtb.test",
      "clicks.example-clicks.test"
    ],
    "urlPatterns": [
      "*/ads/*",
      "*/adserver/*",
      "*/popunder*",
      "*/sponsored-content/*",
      "*/banner-ads/*",
      "*/adframe*",
      "*/adview*",
      "*/ad-click*",
      "*/click-track/*",
      "*/advert/*",
      "*/adsense/*",
      "*/pop-under*",
      "*/interstitial-ad*",
      "*/ad_unit*",
      "*/ad-delivery/*"
    ]
  };

  /*
   * The scoring table and the scoring function are NOT defined here. They live in
   * shared/element-scoring.js, which the manifest injects immediately before this file and
   * which the service worker also loads with importScripts. One file, both worlds, so the
   * page-side verdict and the background verdict can never drift apart.
   */
  var SHARED = window.SRGElementScoring || null;
  var WEIGHTS = SHARED ? SHARED.ELEMENT_WEIGHTS : Object.freeze({});

  var NEVER_TAGS = { HTML: 1, BODY: 1, HEAD: 1, SCRIPT: 1, STYLE: 1, LINK: 1, META: 1, NOSCRIPT: 1, TEMPLATE: 1 };

  /* Allow selectors that describe the page skeleton. They apply to the element itself only;
     if they were used on ancestors, "#root" or ".app-shell" would shield the whole app. */
  var STRUCTURAL = { 'html': 1, 'body': 1, 'main': 1, '[role="main"]': 1, '#root': 1, '#app': 1, '#__next': 1, '.app-shell': 1 };

  /* Things that, if they live INSIDE an element, mean "do not touch it". */
  var CONTAINS_SELECTOR = [
    'input[type="password"]', 'video',
    // Payment fields. A checkout form often has no password and no telltale action attribute,
    // so match the autocomplete tokens the browser itself uses for card data.
    'input[autocomplete^="cc-"]', 'input[autocomplete*="cc-number"]', 'input[autocomplete*="cc-csc"]',
    'input[name*="card" i]', 'input[id*="card" i]', 'input[name*="cvv" i]', 'input[id*="cvv" i]',
    'input[autocomplete="one-time-code"]',
    'form[action*="login" i]', 'form[action*="signin" i]', 'form[action*="auth" i]',
    'form[action*="checkout" i]', 'form[action*="payment" i]', 'form[action*="oauth" i]',
    'iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]', '.g-recaptcha', '.h-captcha'
  ].join(',');

  var PLAYER_SELECTOR = 'video, audio, iframe[src*="youtube.com/embed"], iframe[src*="player.vimeo"], iframe[src*="twitch.tv"]';
  var FORM_INPUT_SELECTOR = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="image"]), select, textarea';
  var TEXT_CAP = 400;           // max characters of visible text read for hint matching
  var MAX_ANCESTOR_DEPTH = 40;  // ancestor walk bound
  var SWEEP_CAP = 400;          // max elements examined by the broad floating/overlay sweep
  var SELECTOR_HIT_CAP = 2000;  // safety bound on selector hits per candidates() call

  var state = null;             // compiled configuration; built lazily by ensureConfigured()

  /* ---------------------------- helpers ----------------------------- */

  function isEl(x) { return !!x && x.nodeType === 1; }

  function uniq(list) {
    var seen = Object.create(null), out = [];
    for (var i = 0; i < list.length; i++) {
      var v = list[i];
      if (typeof v === 'string' && v && !seen[v]) { seen[v] = 1; out.push(v); }
    }
    return out;
  }

  function lowerList(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      if (typeof list[i] === 'string' && list[i]) { out.push(list[i].toLowerCase()); }
    }
    return uniq(out);
  }

  /* Validate selectors one by one so a single bad entry cannot break the combined selector. */
  function filterValidSelectors(list, counter) {
    var good = [];
    var probe = document.createDocumentFragment();
    for (var i = 0; i < list.length; i++) {
      var sel = list[i];
      if (typeof sel !== 'string' || !sel || /[{}@\n\r]|<\//.test(sel)) { counter.dropped++; continue; }
      try { probe.querySelector(sel); good.push(sel); } catch (e) { counter.dropped++; }
    }
    return good;
  }

  function safeMatches(el, sel) {
    if (!sel) { return false; }
    try { return el.matches(sel); } catch (e) { return false; }
  }

  /* Turn "*\/ads/*" style patterns into case-insensitive regular expressions. */
  function compilePatterns(patterns) {
    var out = [];
    for (var i = 0; i < patterns.length; i++) {
      var p = patterns[i];
      if (typeof p !== 'string' || !p) { continue; }
      var parts = p.split('*');
      for (var j = 0; j < parts.length; j++) { parts[j] = parts[j].replace(/[.+?^${}()|[\]\\\/]/g, '\\$&'); }
      try { out.push(new RegExp(parts.join('.*'), 'i')); } catch (e) { /* skip bad pattern */ }
    }
    return out;
  }

  /* Normalise a token the same way element words are normalised: split on separators, re-join
     with "-". This lets "banner-ad", "banner_ad" and "banner.ad" all mean the same thing. */
  function normaliseToken(t) {
    return String(t).toLowerCase().split(/[\s_\-.:]+/).filter(Boolean).join('-');
  }

  /*
   * Separator-delimited token matching.
   * Each whitespace-separated word (e.g. one CSS class) is split on _ - . : into parts and
   * compared with the token as WHOLE parts. So token "ad" matches "ad", "ad-top", "top_ad",
   * "ad.container" but not "add", "badge", "download", "gradient", "loading" or "thread",
   * because those contain "ad" only inside a longer part.
   * Returns the matched token or null.
   */
  function matchTokens(str, tokens) {
    if (typeof str !== 'string' || !str || !tokens || !tokens.length) { return null; }
    var words = str.toLowerCase().split(/\s+/);
    for (var w = 0; w < words.length; w++) {
      if (!words[w]) { continue; }
      var padded = '-' + words[w].split(/[_\-.:]+/).filter(Boolean).join('-') + '-';
      for (var t = 0; t < tokens.length; t++) {
        if (padded.indexOf('-' + tokens[t] + '-') !== -1) { return tokens[t]; }
      }
    }
    return null;
  }

  /* Does any identifying attribute (id, class, data-*) match one of the tokens? */
  function attributesMatchTokens(el, tokens) {
    if (!tokens.length) { return false; }
    if (matchTokens(el.getAttribute('id'), tokens) || matchTokens(el.getAttribute('class'), tokens)) { return true; }
    var attrs = el.attributes;
    var n = Math.min(attrs ? attrs.length : 0, 20);
    for (var i = 0; i < n; i++) {
      var a = attrs[i];
      if (a.name.indexOf('data-') !== 0) { continue; }
      if (matchTokens(a.name.slice(5), tokens)) { return true; }
      if (a.value && a.value.length <= 80 && matchTokens(a.value, tokens)) { return true; }
    }
    return false;
  }

  function hostMatches(host, list) {
    for (var i = 0; i < list.length; i++) {
      if (host === list[i] || host.length > list[i].length && host.slice(-(list[i].length + 1)) === '.' + list[i]) { return true; }
    }
    return false;
  }

  var TWO_PART_SLD = { co: 1, com: 1, org: 1, net: 1, gov: 1, edu: 1, ac: 1 };
  /* Small eTLD+1 approximation, enough to tell "same site" from "other site". */
  function registrable(host) {
    var parts = String(host || '').toLowerCase().split('.');
    if (parts.length <= 2) { return parts.join('.'); }
    var last = parts[parts.length - 1], second = parts[parts.length - 2];
    if (last.length === 2 && TWO_PART_SLD[second]) { return parts.slice(-3).join('.'); }
    return parts.slice(-2).join('.');
  }

  function urlIsAd(href, host) {
    if (hostMatches(host, state.adDomains) || hostMatches(host, state.iframeHosts)) { return true; }
    for (var i = 0; i < state.urlRegexes.length; i++) {
      if (state.urlRegexes[i].test(href)) { return true; }
    }
    return false;
  }

  function parseUrl(raw) {
    try { return new URL(raw, location.href); } catch (e) { return null; }
  }

  /* Read at most TEXT_CAP characters of text under el without building the whole textContent. */
  function readText(el) {
    var out = '';
    try {
      var walker = document.createTreeWalker(el, 4 /* SHOW_TEXT */, null);
      var node;
      while ((node = walker.nextNode()) && out.length < TEXT_CAP) { out += ' ' + node.nodeValue; }
    } catch (e) { /* ignore */ }
    return out.slice(0, TEXT_CAP).toLowerCase();
  }

  function documentArea() {
    var de = document.documentElement;
    var w = Math.max(de.scrollWidth || 0, de.clientWidth || 0, window.innerWidth || 0);
    var h = Math.max(de.scrollHeight || 0, de.clientHeight || 0, window.innerHeight || 0);
    return Math.max(1, w * h);
  }

  function getRect(el, ctx) {
    if (!ctx.rect) { ctx.rect = el.getBoundingClientRect(); }
    return ctx.rect;
  }

  /* ------------------------- configuration -------------------------- */

  function defaultSettings() {
    return { enabled: true, hideHighConfidence: true, mediumAction: 'log', floatingDetection: true,
      overlayDetection: true, stickyDetection: true, iframeDetection: true, cosmeticCss: true };
  }

  function configure(cfg) {
    cfg = cfg || {};
    var counter = { dropped: 0 };
    var settings = defaultSettings();
    var given = cfg.settings && (cfg.settings.element || cfg.settings);
    if (given && typeof given === 'object') {
      for (var k in settings) {
        if (Object.prototype.hasOwnProperty.call(given, k) && given[k] !== undefined) { settings[k] = given[k]; }
      }
    }

    function arr(x) { return Array.isArray(x) ? x : []; }

    var high = filterValidSelectors(uniq(DEFAULTS.high.selectors.concat(arr(cfg.selectors))), counter);
    var medium = filterValidSelectors(uniq(DEFAULTS.medium.selectors.concat(arr(cfg.mediumSelectors))), counter);
    var allow = filterValidSelectors(uniq(DEFAULTS.allow.selectors.concat(arr(cfg.allowSelectors))), counter);

    var allowSelf = [], allowAncestor = [];
    for (var i = 0; i < allow.length; i++) { (STRUCTURAL[allow[i]] ? allowSelf : allowAncestor).push(allow[i]); }

    state = {
      settings: settings,
      highList: high,
      mediumList: medium,
      highSel: high.join(','),
      mediumSel: medium.join(','),
      allowCount: allow.length,
      allowSelfSel: allowSelf.join(','),
      allowAncestorSel: allowAncestor.join(','),
      highTokens: uniq(DEFAULTS.high.idClassTokens.concat(arr(cfg.highTokens)).map(normaliseToken)),
      mediumTokens: uniq(DEFAULTS.medium.idClassTokens.concat(arr(cfg.mediumTokens)).map(normaliseToken)),
      iframeHosts: lowerList(DEFAULTS.high.iframeHosts.concat(arr(cfg.adIframeHosts))),
      adDomains: lowerList(DEFAULTS.adDomains.concat(arr(cfg.adDomains))),
      urlRegexes: compilePatterns(DEFAULTS.urlPatterns.concat(arr(cfg.urlPatterns))),
      textHints: lowerList(DEFAULTS.allow.textHints.concat(arr(cfg.textHints))),
      dropped: counter.dropped
    };
    return diagnostics();
  }

  function ensureConfigured() { if (!state) { configure({}); } }

  function diagnostics() {
    ensureConfigured();
    return { droppedSelectors: state.dropped, high: state.highList.length, medium: state.mediumList.length,
      allow: state.allowCount };
  }

  /* The validated selector lists, so content.js can build the cosmetic stylesheet from them. */
  function getSelectors() {
    ensureConfigured();
    return { high: state.highList.slice(), medium: state.mediumList.slice() };
  }

  /* ---------------------------- allow check ------------------------- */

  /* Returns { allowed: bool, hints: [matched allow text phrases] }. Uses no computed style. */
  function allowCheck(el, ctx) {
    var hints = [], promo = [];
    if (!isEl(el) || NEVER_TAGS[el.tagName]) { return { allowed: true, hints: hints, promo: promo }; }

    // Page skeleton nodes (main, #root, #app, ...) match on the element itself only.
    if (safeMatches(el, state.allowSelfSel)) { return { allowed: true, hints: hints, promo: promo }; }

    // Element or any ancestor below <body> matches an allow selector.
    var node = el, depth = 0;
    while (node && node !== document.body && node !== document.documentElement && depth < MAX_ANCESTOR_DEPTH) {
      if (safeMatches(node, state.allowAncestorSel)) { return { allowed: true, hints: hints, promo: promo }; }
      node = node.parentElement;
      depth++;
    }

    // Element contains a password field, video, auth/payment form or captcha.
    try { if (el.querySelector(CONTAINS_SELECTOR)) { return { allowed: true, hints: hints, promo: promo }; } } catch (e) { /* ignore */ }

    // Never hide (nearly) the whole page.
    var rect = getRect(el, ctx);
    if (rect.width * rect.height / documentArea() > 0.92) { return { allowed: true, hints: hints, promo: promo }; }

    // Visible text says "this is a cookie / login / payment / download thing".
    // This is a SOFT signal, not a veto: it is returned as hints and scored as a capped
    // penalty. Real ads also say "download now", so wording alone must not protect an element
    // that matched a known ad selector - and it must not be the only thing protecting a
    // cookie banner either, which is why the allow SELECTOR list above is the real shield.
    var text = readText(el);
    if (text) {
      for (var i = 0; i < state.textHints.length; i++) {
        if (text.indexOf(state.textHints[i]) !== -1) { hints.push(state.textHints[i]); }
      }
      promo = SHARED ? SHARED.findPromoHints(text) : [];
    }
    return { allowed: false, hints: hints, promo: promo };
  }

  function isAllowed(el) {
    try { ensureConfigured(); return allowCheck(el, { rect: null }).allowed; } catch (e) { return true; }
  }

  /* --------------------------- signals ------------------------------ */

  function emptySignals() {
    return { selectorMatch: null, iframeHostMatch: false, fixed: false, sticky: false, zIndex: 0,
      viewportCoverage: 0, appearedAfterLoad: false, hasOutboundAdLink: false, hasFormInput: false,
      hasVideo: false, allowMatch: false, textHints: [], promoHints: [] };
  }

  function detectSelectorMatch(el) {
    if (safeMatches(el, state.highSel) || attributesMatchTokens(el, state.highTokens)) { return 'high'; }
    if (state.settings.mediumAction !== 'ignore' &&
        (safeMatches(el, state.mediumSel) || attributesMatchTokens(el, state.mediumTokens))) { return 'medium'; }
    return null;
  }

  function detectIframeHost(el) {
    var frames;
    if (el.tagName === 'IFRAME') { frames = [el]; }
    else { try { frames = Array.prototype.slice.call(el.querySelectorAll('iframe[src]'), 0, 5); } catch (e) { return false; } }
    for (var i = 0; i < frames.length; i++) {
      var raw = frames[i].getAttribute('src');
      var u = raw && parseUrl(raw);
      if (u && /^https?:$/.test(u.protocol) && urlIsAd(u.href, u.hostname.toLowerCase())) { return true; }
    }
    return false;
  }

  function detectOutboundAdLink(el) {
    var anchors = [];
    if (el.tagName === 'A' && el.hasAttribute('href')) { anchors.push(el); }
    try { anchors = anchors.concat(Array.prototype.slice.call(el.querySelectorAll('a[href]'), 0, 20)); } catch (e) { /* ignore */ }
    var mySite = registrable(location.hostname);
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      var u = parseUrl(a.getAttribute('href'));
      if (!u || !/^https?:$/.test(u.protocol)) { continue; }
      var host = u.hostname.toLowerCase();
      if (registrable(host) === mySite) { continue; }
      if (urlIsAd(u.href, host)) { return true; }
      var rel = (a.getAttribute('rel') || '').toLowerCase();
      var weakRel = rel.indexOf('noreferrer') === -1 && rel.indexOf('nofollow') === -1 && rel.indexOf('sponsored') === -1;
      if (a.getAttribute('target') === '_blank' && weakRel && (a.querySelector('img') || el.tagName === 'IMG')) { return true; }
    }
    return false;
  }

  function collectSignals(el, opts) {
    var signals = emptySignals();
    try {
      ensureConfigured();
      if (!isEl(el)) { signals.allowMatch = true; return signals; }
      var ctx = { rect: null };
      var allow = allowCheck(el, ctx);
      signals.textHints = allow.hints;
      signals.promoHints = allow.promo || [];
      if (allow.allowed) { signals.allowMatch = true; return signals; }

      var style = window.getComputedStyle(el);   // the ONE computed-style read for this element
      if (!style || style.display === 'none') { return signals; }   // nothing to hide

      signals.fixed = style.position === 'fixed';
      signals.sticky = style.position === 'sticky';
      var z = parseInt(style.zIndex, 10);
      signals.zIndex = isNaN(z) ? 0 : z;

      var rect = getRect(el, ctx);
      var vw = window.innerWidth || document.documentElement.clientWidth || 1;
      var vh = window.innerHeight || document.documentElement.clientHeight || 1;
      if (rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden') {
        signals.viewportCoverage = Math.max(0, Math.min(1, (rect.width * rect.height) / (vw * vh)));
      }

      signals.selectorMatch = detectSelectorMatch(el);
      signals.iframeHostMatch = detectIframeHost(el);
      signals.appearedAfterLoad = !!(opts && opts.appearedAfterLoad);
      signals.hasOutboundAdLink = detectOutboundAdLink(el);
      signals.hasFormInput = !!el.querySelector(FORM_INPUT_SELECTOR);
      signals.hasVideo = el.tagName === 'VIDEO' || el.tagName === 'AUDIO' || !!el.querySelector(PLAYER_SELECTOR);
    } catch (e) {
      return emptySignals();
    }
    return signals;
  }

  /* ----------------------------- scoring ---------------------------- */

  /* Pure function: signals (+ settings) -> verdict. Mirrors SRGDetect.scoreElementSignals. */
  function scoreSignals(s, settings) {
    if (!SHARED) {
      // Shared scoring module missing: fail open, never hide anything on a guess.
      return { confidence: 'low', score: 0, reasons: ['scoring-unavailable'], matchedRule: null };
    }
    return SHARED.scoreElementSignals(s, settings || defaultSettings());
  }

  function score(el, opts) {
    try {
      ensureConfigured();
      return scoreSignals(collectSignals(el, opts), state.settings);
    } catch (e) {
      return { confidence: 'low', score: 0, reasons: ['error-fail-open'], matchedRule: null };
    }
  }

  /* --------------------------- candidates --------------------------- */

  function candidates(root) {
    ensureConfigured();
    var out = [], seen = new Set();
    root = root || document;
    function add(el) {
      if (!isEl(el) || NEVER_TAGS[el.tagName] || seen.has(el)) { return; }
      seen.add(el);
      out.push(el);
    }
    function addAll(list, cap) {
      var n = Math.min(list.length, cap);
      for (var i = 0; i < n; i++) { add(list[i]); }
    }
    try {
      // 1. Direct selector hits (cheap: the browser's selector engine does the work).
      if (state.highSel) { addAll(root.querySelectorAll(state.highSel), SELECTOR_HIT_CAP); }
      if (state.mediumSel && state.settings.mediumAction !== 'ignore') { addAll(root.querySelectorAll(state.mediumSel), SELECTOR_HIT_CAP); }
      // 2. Iframes: judged by URL only (we cannot see inside cross-origin frames).
      addAll(root.querySelectorAll('iframe[src]'), SELECTOR_HIT_CAP);
      // 3. Floating/overlay sweep. Overlays and interstitials are almost always direct children
      //    of <body> or one level below (or carry inline fixed/sticky/z-index styles), so we
      //    look only there instead of walking every node. It is capped at SWEEP_CAP examined
      //    elements so a huge page cannot make a scan expensive.
      var sweep = root.querySelectorAll('body > *, body > * > *, [style*="fixed"], [style*="sticky"], [style*="z-index"]');
      addAll(sweep, SWEEP_CAP);
    } catch (e) { /* fail open: return what we have */ }
    return out;
  }

  SRG.detector = {
    WEIGHTS: WEIGHTS,
    configure: configure,
    collectSignals: collectSignals,
    score: score,
    scoreSignals: scoreSignals,
    candidates: candidates,
    isAllowed: isAllowed,
    getSelectors: getSelectors,
    diagnostics: diagnostics,
    matchTokens: matchTokens,
    normaliseToken: normaliseToken
  };
})();
