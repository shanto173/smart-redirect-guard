/*
 * SRG element-blocker.js  -  "Hide it, and make it easy to bring back."
 *
 * WHAT THIS FILE DOES (plain language)
 *   When the detector decides an element is an advertisement, this file hides it. It also
 *   remembers exactly how the element looked before (its inline style values), so the user can
 *   press "Restore" and get the original back. It can also inject one small stylesheet at page
 *   start so well-known ad containers never flash on screen.
 *
 * WHY WE NEVER CALL element.remove()
 *   Removing a node from the DOM destroys its position and may break the page's own scripts that
 *   still hold a reference to it. Hiding with display:none keeps the node in place, so the undo is
 *   perfect. Every hide here is reversible; nothing is ever deleted.
 *
 * WHY suppress() EXISTS
 *   Our own style changes would be seen by the MutationObserver, which would then re-process the
 *   element, which would change it again... an infinite loop. suppress(fn) raises a flag while we
 *   write to the DOM and discards the resulting mutation records, so the observer ignores us.
 */
(function () {
  'use strict';

  window.SRG = window.SRG || {};
  var SRG = window.SRG;

  var STYLE_ID = 'srg-cosmetic';
  var MAX_COSMETIC_SELECTORS = 2000;   // safety bound on the stylesheet size
  var records = new Map();             // sid -> undo record (holds a direct element reference)
  var restored = new WeakSet();        // elements the user restored; never re-hide automatically
  var counter = 0;
  var suppressDepth = 0;
  var cosmeticApplied = [];

  /* ---- suppress: nesting-safe flag the observer checks ---- */
  function suppress(fn) {
    if (suppressDepth === 0 && SRG.observer && typeof SRG.observer.drainPending === 'function') {
      SRG.observer.drainPending();   // keep real page mutations that happened just before us
    }
    suppressDepth++;
    try {
      return fn();
    } finally {
      suppressDepth--;
      if (suppressDepth === 0 && SRG.observer && typeof SRG.observer.discardPending === 'function') {
        // MutationObserver callbacks run later (asynchronously), after our flag is already
        // cleared, so we also throw away the records our own writes just produced.
        SRG.observer.discardPending();
      }
    }
  }

  function isSuppressed() { return suppressDepth > 0; }

  function makeSid() {
    counter++;
    return 's' + counter + Math.floor(Math.random() * 1679616).toString(36);
  }

  /* Short human-readable name for the dashboard, e.g. "div#promo-box" or "iframe.ad-frame". */
  function makeLabel(el) {
    var label = String(el.tagName || 'element').toLowerCase();
    var id = el.getAttribute && el.getAttribute('id');
    var cls = el.getAttribute && el.getAttribute('class');
    if (id) {
      label += '#' + id;
    } else if (cls) {
      var first = String(cls).trim().split(/\s+/)[0];
      if (first) { label += '.' + first; }
    }
    return label.slice(0, 60);
  }

  function setOrRemove(el, prop, value, priority) {
    if (value) { el.style.setProperty(prop, value, priority || ''); }
    else { el.style.removeProperty(prop); }
  }

  /* Hide el. Returns the new sid, or null if it was already hidden by us / cannot be hidden. */
  function hide(el, verdict) {
    try {
      if (!el || el.nodeType !== 1 || !el.style) { return null; }
      if (el.dataset && el.dataset.srgHidden && records.has(el.dataset.srgHidden)) { return null; }
      verdict = verdict || {};
      var sid = makeSid();
      var hadAria = el.hasAttribute('aria-hidden');
      var rec = {
        sid: sid,
        el: el,   // direct reference so restore works even if the page detaches the node
        label: makeLabel(el),
        confidence: verdict.confidence || 'high',
        reason: Array.isArray(verdict.reasons) ? verdict.reasons.join(', ') : '',
        // INLINE values (not computed), so restore puts back exactly what was written there.
        prevDisplay: el.style.getPropertyValue('display'),
        prevDisplayPriority: el.style.getPropertyPriority('display'),
        prevVisibility: el.style.getPropertyValue('visibility'),
        prevPointerEvents: el.style.getPropertyValue('pointer-events'),
        addedAria: !hadAria
      };
      suppress(function () {
        el.style.setProperty('display', 'none', 'important');
        el.dataset.srgHidden = sid;
        if (!hadAria) { el.setAttribute('aria-hidden', 'true'); }
      });
      records.set(sid, rec);
      return sid;
    } catch (e) {
      return null;
    }
  }

  function restore(sid) {
    try {
      var rec = records.get(sid);
      if (!rec) { return false; }
      var el = rec.el;
      suppress(function () {
        setOrRemove(el, 'display', rec.prevDisplay, rec.prevDisplayPriority);
        setOrRemove(el, 'visibility', rec.prevVisibility);
        setOrRemove(el, 'pointer-events', rec.prevPointerEvents);
        delete el.dataset.srgHidden;
        if (rec.addedAria) { el.removeAttribute('aria-hidden'); }
        if (!el.getAttribute('style')) { el.removeAttribute('style'); }
      });
      records.delete(sid);
      restored.add(el);
      return true;
    } catch (e) {
      records.delete(sid);
      return false;
    }
  }

  function restoreAll() {
    var sids = Array.from(records.keys());
    var count = 0;
    for (var i = 0; i < sids.length; i++) { if (restore(sids[i])) { count++; } }
    return count;
  }

  function info(sid) {
    var r = records.get(sid);
    return r ? { sid: r.sid, label: r.label, confidence: r.confidence, reason: r.reason } : null;
  }

  function list() {
    var out = [];
    records.forEach(function (r) { out.push({ sid: r.sid, label: r.label, confidence: r.confidence, reason: r.reason }); });
    return out;
  }

  function hiddenCount() { return records.size; }

  function wasRestored(el) { return restored.has(el); }

  /* ---- cosmetic stylesheet ---- */

  function safeSelector(sel) {
    return typeof sel === 'string' && sel.length > 0 && sel.length < 300 && !/[{}@\n\r]|<\//.test(sel);
  }

  /* Inject ONE <style id="srg-cosmetic">. Works before <head> exists. Returns applied count. */
  function injectCosmeticCss(selectors) {
    try {
      var rules = [];
      var applied = [];
      var list_ = Array.isArray(selectors) ? selectors : [];
      var probe = document.createDocumentFragment();
      for (var i = 0; i < list_.length && applied.length < MAX_COSMETIC_SELECTORS; i++) {
        var sel = list_[i];
        if (!safeSelector(sel)) { continue; }
        try { probe.querySelector(sel); } catch (e) { continue; }
        // One rule per selector: a single invalid selector in a comma list would void the lot.
        rules.push(sel + '{display:none !important}');
        applied.push(sel);
      }
      suppress(function () {
        var style = document.getElementById(STYLE_ID);
        if (!style) {
          style = document.createElement('style');
          style.id = STYLE_ID;
          (document.head || document.documentElement).appendChild(style);
        }
        style.textContent = rules.join('\n');
      });
      cosmeticApplied = applied;
      return applied.length;
    } catch (e) {
      return 0;
    }
  }

  function removeCosmeticCss() {
    try {
      suppress(function () {
        var style = document.getElementById(STYLE_ID);
        if (style && style.parentNode) { style.parentNode.removeChild(style); }
      });
    } catch (e) { /* ignore */ }
    cosmeticApplied = [];
  }

  function cosmeticSelectors() { return cosmeticApplied.slice(); }

  SRG.blocker = {
    hide: hide,
    restore: restore,
    restoreAll: restoreAll,
    list: list,
    info: info,
    hiddenCount: hiddenCount,
    wasRestored: wasRestored,
    injectCosmeticCss: injectCosmeticCss,
    removeCosmeticCss: removeCosmeticCss,
    cosmeticSelectors: cosmeticSelectors,
    suppress: suppress,
    isSuppressed: isSuppressed
  };
})();
