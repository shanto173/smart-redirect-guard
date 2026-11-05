# SRG — Frozen Interface Contract

Every module in the project must conform to this file. Phase 2 (background) and Phase 3 (content)
are written against it so they fit together without rework. **Do not change a name here without
updating this document.**

Globals convention: there is no bundler. Background modules are loaded by the service worker with
`importScripts()`; content modules are listed in `manifest.json` in dependency order. Each file
attaches exactly one namespace object to `self` (background) or `window.SRG` (content).

---

## 1. Message protocol

All messages are `{ type, payload? }` and travel over `chrome.runtime.sendMessage` (page → worker) or
`chrome.tabs.sendMessage` (worker → page). Every handler replies, even if only `{ok:true}`, and uses
`return true` for async replies.

### Content script → service worker

| type | payload | reply |
|---|---|---|
| `SRG_GET_CONFIG` | `{ url, frameId }` | `{ ok, enabled, settings, selectors, allowSelectors, adIframeHosts, trusted }` |
| `SRG_REPORT_HIDDEN` | `{ url, items: [{sid, label, confidence, reason}] }` | `{ ok }` |
| `SRG_REPORT_ELEMENT_RESTORED` | `{ url, sid }` | `{ ok }` |
| `SRG_LOG_ACTIVITY` | `{ domain, layer, type, action, confidence, detail }` | `{ ok }` |

### Popup / dashboard → service worker

| type | payload | reply |
|---|---|---|
| `SRG_GET_STATE` | — | `{ ok, settings, stats, status, activeTab:{id,url,domain,trusted} }` |
| `SRG_UPDATE_SETTINGS` | partial settings object (deep-merged) | `{ ok, settings }` |
| `SRG_GET_ACTIVITY` | `{ limit? }` | `{ ok, activity: ActivityRow[] }` |
| `SRG_CLEAR_ACTIVITY` | — | `{ ok }` |
| `SRG_RESET_STATS` | — | `{ ok, stats }` |
| `SRG_GET_TRUSTED` | — | `{ ok, trusted: TrustedEntry[] }` |
| `SRG_ADD_TRUSTED` | `{ domain, scope?, durationMs? }` | `{ ok, trusted }` |
| `SRG_REMOVE_TRUSTED` | `{ domain }` | `{ ok, trusted }` |
| `SRG_GET_CUSTOM_RULES` | — | `{ ok, customRules }` |
| `SRG_UPDATE_CUSTOM_RULES` | `{ customRules }` | `{ ok, customRules }` |
| `SRG_GET_RECOVERY` | `{ tabId }` | `{ ok, recovery: {from, to, ts} \| null }` |
| `SRG_RECOVER_TAB` | `{ tabId }` | `{ ok, url }` |
| `SRG_GET_HIDDEN_ELEMENTS` | `{ tabId }` | `{ ok, items:[{sid,label,confidence,reason}] }` |
| `SRG_RESTORE_ELEMENT` | `{ tabId, sid }` | `{ ok }` |
| `SRG_RESTORE_ALL_ELEMENTS` | `{ tabId }` | `{ ok, count }` |
| `SRG_RESCAN_TAB` | `{ tabId }` | `{ ok }` |
| `SRG_EXPORT_CONFIG` | — | `{ ok, data }` |
| `SRG_IMPORT_CONFIG` | `{ data }` | `{ ok, settings }` |

### Service worker → content script

| type | payload | effect |
|---|---|---|
| `SRG_SETTINGS_CHANGED` | `{ enabled, settings, trusted }` | re-apply or tear down layer 3 |
| `SRG_LIST_HIDDEN` | — | reply `{ ok, items }` |
| `SRG_RESTORE` | `{ sid }` | reply `{ ok }` |
| `SRG_RESTORE_ALL` | — | reply `{ ok, count }` |
| `SRG_RESCAN` | — | reply `{ ok, hidden }` |

Worker→content sends must tolerate "Receiving end does not exist" (no content script on
`chrome://`, PDF viewer, etc.) — always catch and ignore.

---

## 2. Storage schema (`chrome.storage.local`)

One top-level key per concern. `storage-manager.js` is the only writer.

```js
SRG_SCHEMA_VERSION = 1

"srg.version"      : 1

"srg.settings" : {
  masterEnabled: true,
  tab: {
    enabled: true,
    closeDelayMs: 1000,          // 0–10000, configurable
    mediumAction: "log",         // "log" | "ignore"  (never auto-close on medium)
    reactivateOpener: true
  },
  redirect: {
    enabled: true,
    dnrBlocking: true,
    offerRecovery: true,
    rememberSafeUrl: true
  },
  element: {
    enabled: true,
    hideHighConfidence: true,
    mediumAction: "log",         // "log" | "hide" | "ignore"
    floatingDetection: true,
    overlayDetection: true,
    stickyDetection: true,
    iframeDetection: true,
    cosmeticCss: true            // inject <style> at document_start
  },
  logging: { activityEnabled: true, maxEntries: 200 },
  ui: { theme: "auto", showBadge: true }
}

"srg.trusted" : [ { domain, scope:{tab,redirect,element}, expiresAt, addedAt } ]

"srg.stats" : {
  tabsClosed: 0, tabsAllowed: 0,
  redirectsBlocked: 0, redirectsDetected: 0,
  elementsHidden: 0, elementsRestored: 0,
  lastReset: <ms>
}

"srg.activity" : ActivityRow[]      // newest first, capped at settings.logging.maxEntries

"srg.customRules" : {
  adDomains: [], suspiciousDomains: [], urlPatterns: [],
  selectors: [], allowSelectors: []
}
```

`ActivityRow`:
```js
{ id, ts, domain, layer: "tab"|"redirect"|"element", type, action, confidence, detail }
```
`layer` is the protection layer, `type` the detection kind (`"ad-tab"`, `"client-redirect"`,
`"overlay"`, …), `action` what was done (`"closed"`, `"blocked"`, `"hidden"`, `"logged"`,
`"allowed"`, `"restored"`).

### `chrome.storage.session` (memory only, privacy-sensitive)

```js
"srg.tabs"     : { [tabId]: { openerTabId, openerUrl, createdAt, urlHistory:[], decided, srgOpened } }
"srg.safeUrl"  : { [tabId]: { url, ts } }
"srg.recovery" : { [tabId]: { from, to, ts, confidence } }
```

---

## 3. `storage/storage-manager.js` — API

Attaches `self.SRGStorage`. All methods return Promises. Must be importable by the service worker
**and** usable from popup/dashboard pages (so: no service-worker-only APIs inside; it is also loaded
via `<script src="../storage/storage-manager.js">` — guard with `typeof self !== 'undefined'`).

```js
SRGStorage.DEFAULTS                      // frozen defaults object
SRGStorage.bootstrap()                   // install defaults + run migrations, returns settings
SRGStorage.getSettings()
SRGStorage.updateSettings(partial)       // deep merge, returns merged settings
SRGStorage.resetSettings()

SRGStorage.getTrusted()
SRGStorage.addTrusted(domain, scope?, durationMs?)
SRGStorage.removeTrusted(domain)
SRGStorage.isTrusted(url, layer)         // layer: "tab"|"redirect"|"element" -> bool
                                         // matches registrable domain + subdomains, honours expiry

SRGStorage.getStats()
SRGStorage.bumpStat(key, n = 1)          // buffered in memory, flushed on debounce
SRGStorage.flush()                       // force write (called from alarm + onSuspend)
SRGStorage.resetStats()

SRGStorage.getActivity(limit?)
SRGStorage.addActivity(row)              // assigns id+ts, prepends, trims to maxEntries
SRGStorage.clearActivity()

SRGStorage.getCustomRules()
SRGStorage.updateCustomRules(rules)

SRGStorage.session.getTab(tabId) / setTab(tabId, rec) / deleteTab(tabId) / pruneTabs(liveIds)
SRGStorage.session.getSafeUrl(tabId) / setSafeUrl(tabId, url)
SRGStorage.session.getRecovery(tabId) / setRecovery(tabId, rec) / clearRecovery(tabId)

SRGStorage.exportConfig() / importConfig(data)
SRGStorage.onChanged(cb)                 // wraps chrome.storage.onChanged for the given keys
```

Write discipline: `bumpStat` must never write more than once per 2 s; `addActivity` coalesces
bursts the same way.

---

## 4. `background/detection-engine.js` — API

Attaches `self.SRGDetect`. **Pure functions only — no `chrome.*` calls, no `await`, no I/O**, so
`tests/test-rules.js` can require it in plain Node.

```js
// Verdict shape returned by every classifier
// { confidence: "high"|"medium"|"low", score: number, reasons: string[], matchedRule: string|null }

SRGDetect.VETO_PATH_TOKENS   // login, signin, oauth, auth, sso, saml, checkout, payment,
                             // billing, 3ds, download, captcha, verify, 2fa, mfa, account/recovery
SRGDetect.setRules({ adDomains, suspiciousDomains, urlPatterns, trustedDomains })

SRGDetect.parseUrl(url)              // -> {ok, href, host, registrable, path, query} | {ok:false}
SRGDetect.registrableDomain(host)    // eTLD+1 approximation incl. common two-part TLDs
SRGDetect.isSameSite(a, b)
SRGDetect.isIgnorableUrl(url)        // chrome://, about:, file://, chrome-extension://, blank, ""
SRGDetect.hasVetoSignal(url)         // -> {veto:bool, reason}

SRGDetect.classifyTab(ctx)
//   ctx = { url, openerUrl, urlHistory, createdAt, now, transitionQualifiers,
//           srgOpened, trusted, userGesture }
SRGDetect.classifyNavigation(ctx)
//   ctx = { url, previousUrl, transitionType, transitionQualifiers, frameId,
//           trusted, chainLength, timeSinceLastNav }
SRGDetect.scoreElementSignals(signals)
//   signals = { selectorMatch, iframeHostMatch, fixed, sticky, zIndex, viewportCoverage,
//               appearedAfterLoad, hasOutboundAdLink, hasFormInput, hasVideo,
//               allowMatch, textHints:[] }
```

`scoreElementSignals` lives here (not in the content script) so tab, navigation and element scoring
share one rule interpretation; `content/element-detector.js` gathers the signals in the page and
ships a **copy** of the same scoring table (content scripts cannot `importScripts` a background
module). Keep the two in sync and cover both with the Phase 6 tests.

---

## 5. `background/tab-monitor.js`

Attaches `self.SRGTabMonitor`.

```js
SRGTabMonitor.init()                     // registers listeners (idempotent)
SRGTabMonitor.markSrgOpened(tabId)       // so SRG never closes its own tabs
SRGTabMonitor.handleCreatedTarget(details)
SRGTabMonitor.handleTabCreated(tab)
SRGTabMonitor.handleTabUpdated(tabId, changeInfo, tab)
SRGTabMonitor.handleTabRemoved(tabId)
SRGTabMonitor.prune()                    // alarm-driven cleanup
```

Listeners owned: `chrome.webNavigation.onCreatedNavigationTarget`, `chrome.tabs.onCreated`,
`chrome.tabs.onUpdated`, `chrome.tabs.onRemoved`.

## 6. `background/navigation-monitor.js`

Attaches `self.SRGNavMonitor`.

```js
SRGNavMonitor.init()
SRGNavMonitor.handleBeforeNavigate(d)
SRGNavMonitor.handleCommitted(d)
SRGNavMonitor.handleErrorOccurred(d)
SRGNavMonitor.getRecovery(tabId)
SRGNavMonitor.recover(tabId)             // -> url navigated back to, or null
```

Only `frameId === 0` is considered. Listeners owned: `chrome.webNavigation.onBeforeNavigate`,
`onCommitted`, `onErrorOccurred`.

## 7. `background/action-manager.js`

Attaches `self.SRGAction`. **The only module permitted to cause a side effect.**

```js
SRGAction.closeAdTab(tabId, { delayMs, openerTabId, verdict, url })  // re-verifies before closing
SRGAction.allowTab(tabId, verdict, url)
SRGAction.activateTab(tabId)
SRGAction.noteRedirect(tabId, verdict, from, to)
SRGAction.navigateBack(tabId)
SRGAction.updateBadge(tabId?)
SRGAction.log(row)                       // -> storage-manager.addActivity + bumpStat
SRGAction.applyTrustedDnrRules()         // dynamic allowAllRequests rules for trusted domains
SRGAction.applyCustomDnrRules()          // dynamic block rules from customRules
```

## 8. `background/service-worker.js`

* `importScripts('../storage/storage-manager.js', 'detection-engine.js', 'tab-monitor.js',
  'navigation-monitor.js', 'action-manager.js')` — note paths are relative to the worker file.
* `chrome.runtime.onInstalled` + `chrome.runtime.onStartup` → `bootstrap()`.
* Single `chrome.runtime.onMessage` router implementing §1.
* `chrome.alarms` `"srg-maintenance"` every 1 minute → `SRGStorage.flush()` + `SRGTabMonitor.prune()`.
* Must call `SRGDetect.setRules()` after loading `rules/*.json` + custom rules, and again whenever
  custom rules or trusted sites change.

---

## 9. Content side

`manifest.json` injects, in this order, at `document_start`, `all_frames: true`:
`element-detector.js`, `element-blocker.js`, `mutation-observer.js`, `content.js`.

Each attaches to a shared namespace created defensively:
```js
window.SRG = window.SRG || {};
window.SRG.detector = { ... };
```

```js
SRG.detector.configure({ selectors, allowSelectors, adIframeHosts, settings })
SRG.detector.collectSignals(el)          // -> signals object (see §4)
SRG.detector.score(el)                   // -> verdict, uses the shared scoring table
SRG.detector.candidates(root)            // -> Element[] (selector hits + fixed/sticky/large nodes)
SRG.detector.isAllowed(el)               // ALLOW/veto check, returns true = never touch

SRG.blocker.hide(el, verdict)            // -> sid | null ; display:none !important + undo record
SRG.blocker.restore(sid)                 // -> bool
SRG.blocker.restoreAll()                 // -> count
SRG.blocker.list()                       // -> [{sid,label,confidence,reason}]
SRG.blocker.injectCosmeticCss(selectors) // <style> at document_start
SRG.blocker.removeCosmeticCss()
SRG.blocker.suppress(fn)                 // runs fn with the observer's suppress flag set

SRG.observer.start(onBatch)              // debounced, WeakSet-deduped, idle-scheduled
SRG.observer.stop()
SRG.observer.isRunning()
```

`content.js` owns: config fetch, the initial scan, wiring observer→detector→blocker, batched
reporting to the worker, and the `SRG_*` message handlers from §1.

---

## 10. Rule file schemas

`rules/rules.json` — a valid **declarativeNetRequest static ruleset** (array of rules). Ids 1–999.
Every rule gets a `"__comment"`-free shape (DNR rejects unknown keys), so documentation for rules
lives in `docs/RULES.md`, not inside the JSON.

`rules/element-selectors.json`:
```json
{
  "version": 1,
  "note": "ILLUSTRATIVE EXAMPLES — not a verified malicious-domain list",
  "high": { "selectors": [], "idClassTokens": [], "iframeHosts": [] },
  "medium": { "selectors": [], "idClassTokens": [] },
  "allow": { "selectors": [], "textHints": [] },
  "adDomains": [],
  "urlPatterns": []
}
```

`rules/trusted-sites.json`:
```json
{ "version": 1, "sites": [ { "domain": "accounts.google.com",
    "scope": { "tab": true, "redirect": true, "element": true },
    "reason": "authentication" } ] }
```

---

## 11. Hard rules for implementers

1. No `element.remove()`. Hide only, with a working undo.
2. No `chrome.tabs.remove()` outside `SRGAction.closeAdTab`, and never without re-verification.
3. Medium confidence never closes a tab and never auto-navigates.
4. Every `chrome.*` call that can reject is wrapped (`try/catch` on await, or `.catch()`).
5. No `innerHTML` with non-literal strings anywhere; build DOM with `createElement`/`textContent`.
6. No network requests. No remote scripts. No CDN links in popup/dashboard HTML.
7. Example rule lists must be labelled as examples in the file itself.
8. Everything must run with `"use strict"` semantics and no global leaks beyond the one namespace.
