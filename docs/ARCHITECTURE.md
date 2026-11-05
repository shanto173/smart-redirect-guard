# Smart Redirect Guard (SRG) — Architecture

**Phase 1 deliverable.** This document explains how the extension is put together, which Chrome
APIs do the work, what data flows where, which permissions are needed and why, and — importantly —
what Chrome genuinely *cannot* do. It is written for someone who has not built a Chrome extension
before, so it starts from the basics.

---

## 1. What problem are we solving?

Three different annoyances get lumped together as "ads", but technically they are three completely
different events inside the browser:

| # | Annoyance | What actually happens in Chrome | Which API can see it |
|---|-----------|--------------------------------|----------------------|
| 1 | A click opens an unwanted ad **tab** | A new tab object is created, with the old tab recorded as its *opener* | `chrome.tabs.onCreated`, `chrome.webNavigation.onCreatedNavigationTarget` |
| 2 | A click **replaces** the current page with an ad site | A top-level (main frame) navigation happens in the existing tab | `chrome.webNavigation.*`, `chrome.declarativeNetRequest` |
| 3 | An ad is **drawn inside** the page (banner, sticky bar, overlay) | Nothing navigates at all. DOM nodes appear. | A content script + `MutationObserver` |

Because the three are technically unrelated, SRG is built as **three independent layers**. Each one
can be switched off on its own, and switching one off never disables the others. They share one
central scoring component (the detection engine) so that "is this an ad?" is answered the same way
everywhere.

---

## 2. The two worlds an extension lives in

This is the single most important concept for a beginner.

```
┌──────────────────────── CHROME BROWSER ────────────────────────┐
│                                                                │
│  EXTENSION WORLD (privileged)        PAGE WORLD (unprivileged) │
│  ────────────────────────────        ───────────────────────── │
│                                                                │
│  background/service-worker.js        content/content.js        │
│   • can call chrome.tabs.*            • runs INSIDE example.com│
│   • can close tabs                    • can read/edit the DOM   │
│   • can read tab URLs                 • CANNOT close tabs      │
│   • CANNOT touch page DOM             • CANNOT read other tabs │
│                                                                │
│            └────── chrome.runtime messages ──────┘             │
│                                                                │
│  popup/ and dashboard/ are ordinary web pages that also live   │
│  in the extension world and talk to the service worker by      │
│  message passing.                                              │
└────────────────────────────────────────────────────────────────┘
```

* The **service worker** is the brain. It has the powerful `chrome.*` APIs but no access to page
  content. In Manifest V3 it is *not* always running — Chrome stops it after roughly 30 seconds of
  idleness and restarts it when an event arrives. Anything we need to remember must therefore be
  written to storage, never kept only in a JavaScript variable.
* The **content script** is the hands. It is injected into every page and can see and hide DOM
  elements, but it is sandboxed: it cannot close tabs or inspect other tabs.

Everything SRG does is a conversation between these two.

---

## 3. Component map

```
manifest.json ............. declares permissions, the service worker,
                            content scripts and the static DNR ruleset

background/
  service-worker.js ....... entry point. Wires events to modules, owns the
                            message router, boots state after a restart.
  tab-monitor.js .......... LAYER 1. Watches tab creation, tracks opener
                            relationships, decides when a tab is "ad-only".
  navigation-monitor.js ... LAYER 2. Watches main-frame navigations and
                            redirect chains, remembers the last safe URL.
  detection-engine.js ..... Pure scoring logic. No Chrome API calls, no I/O.
                            Input: a context object. Output: a verdict.
  action-manager.js ....... The only module allowed to take a visible action
                            (close tab, activate tab, log, notify, badge).

content/
  content.js .............. LAYER 3 coordinator. Fetches config, sets up the
                            observer, batches work with requestIdleCallback.
  element-detector.js ..... Scores a DOM element. Mirror image of
                            detection-engine.js but for elements.
  element-blocker.js ...... Hides elements and keeps an undo record so they
                            can be restored.
  mutation-observer.js .... Debounced, loop-safe wrapper around
                            MutationObserver.

rules/
  rules.json .............. STATIC declarativeNetRequest ruleset (real blocking)
  element-selectors.json .. selectors + allowlist for layer 3
  trusted-sites.json ...... shipped default trusted sites

storage/
  storage-manager.js ...... the ONLY module that touches chrome.storage.
                            Schema, defaults, migrations, write batching.

popup/ ................... quick controls + live counters
dashboard/ ............... full settings, trusted sites, activity, restore UI
tests/ ................... mock site + headless rule tests + test report
```

**Why separate `detection-engine.js` from the monitors?** Because scoring is the part most likely to
be wrong, and pure functions with no Chrome dependencies can be unit-tested in plain Node. The
monitors gather facts; the engine judges them; the action manager acts. One responsibility each.

---

## 4. Data flow

```
     Chrome event                 facts              verdict            effect
  ─────────────────   ────────────────────────   ──────────────   ─────────────────
  tabs.onCreated  ──► tab-monitor ───────────┐
  webNavigation   ──► navigation-monitor ────┼─► detection-engine ─► action-manager
  DOM mutation    ──► element-detector ──────┘        (scores)        (close/hide/
       (in page)                                                       log/badge)
                                                                            │
                           storage-manager  ◄──────────────────────────────┘
                                   ▲
                                   │ settings, trusted sites, stats, activity
                           popup / dashboard
```

Rules of the road:

1. Monitors never close a tab or hide an element directly. They produce a **context object** and ask
   the engine.
2. The engine never calls a Chrome API. It is deterministic: same context in, same verdict out.
3. Only `action-manager.js` performs side effects, so there is exactly one place to audit for
   "could this close a legitimate tab?".
4. Only `storage-manager.js` reads or writes `chrome.storage`, so the schema can never drift.

---

## 5. Chrome APIs used, and what each one can and cannot do

### `chrome.tabs`
* `onCreated` → fires with a `Tab` object. `tab.openerTabId` tells us which tab spawned it — this is
  how we know "tab 42 opened this". **Caveat:** at `onCreated` time `tab.url` is usually empty or
  `"about:blank"`, because navigation has not started. So we cannot judge a tab on creation alone.
* `onUpdated` → fires as the tab's URL/status changes. This is where the real destination appears,
  often after one or more redirects.
* `remove()` → closes a tab. This is our Layer 1 action.
* `update(id, {active:true})` → brings the original tab back to the front.
* **Cannot** cancel a navigation. `onUpdated` is an observation, not a veto.

### `chrome.webNavigation`
* `onCreatedNavigationTarget` → the cleanest signal for "a page opened a new tab": gives
  `sourceTabId`, `tabId` and the intended `url`. Better than `tabs.onCreated` because the URL is
  present.
* `onBeforeNavigate` / `onCommitted` / `onCompleted` / `onErrorOccurred` → the lifecycle of a
  navigation. `onCommitted` carries `transitionType` (`"link"`, `"typed"`, `"form_submit"`, …) and
  `transitionQualifiers` (`"client_redirect"`, `"server_redirect"`), which is exactly the evidence we
  need to tell "the user clicked a link" from "the page redirected itself".
* **Cannot** block. All `webNavigation` events are read-only notifications. By the time
  `onBeforeNavigate` fires, the request is already on its way.

### `chrome.declarativeNetRequest` (DNR)
* This is the **only** API in Manifest V3 that can actually *stop* a request. Manifest V2's blocking
  `chrome.webRequest` was removed; we do not use it.
* Rules are data, not code: Chrome evaluates them natively, so the extension never sees the URL. That
  is good for privacy and speed, but it means rules must be written up front.
* Two kinds we use:
  * **Static** rules from `rules/rules.json`, declared in the manifest. Shipped defaults.
  * **Dynamic** rules via `updateDynamicRules()` for user-added rules and trusted-site exceptions.
    Dynamic rules survive browser restarts. (Session rules, which do not, are not needed here.)
* Priority matters: an `allow` / `allowAllRequests` rule with higher priority beats a `block` rule.
  That is how a trusted site is exempted without deleting the block rules.
* **Limits:** a static ruleset is guaranteed at least 30,000 rules; dynamic + session rules are
  capped (5,000 on older Chrome, 30,000 on recent versions). SRG stays far below both.
* `declarativeNetRequestFeedback` + `onRuleMatchedDebug` lets us count what was blocked. It **only
  works for unpacked extensions**, so stats from it are a development nicety, not a product feature.

### `chrome.storage.local` and `chrome.storage.session`
* `local` → settings, trusted sites, statistics, activity log. Persists across restarts. Capped at
  ~10 MB (and `unlimitedStorage` is deliberately *not* requested).
* `session` → the "last safe URL" per tab. Lives in memory only and is wiped when Chrome closes, so
  browsing history is not written to disk. This is a privacy decision.

### `MutationObserver` (page side)
* A browser primitive, not a Chrome API. Calls us back when DOM nodes are added. The danger is
  feedback loops: hiding an element changes the DOM, which notifies the observer, which hides again.
  We avoid this by (a) only reacting to `childList` additions and a narrow `attributeFilter`,
  (b) marking processed nodes with a `WeakSet` + data attribute, and (c) debouncing into batches.

### What we deliberately do **not** use
`chrome.webRequest` blocking (removed in MV3), `chrome.scripting` (not needed — content scripts are
declared statically), `host_permissions` (content script `matches` already grants page access),
`notifications`, `unlimitedStorage`, and any network fetch to a remote server.

---

## 6. Permissions, and the justification for each

| Permission | Why it is genuinely required | What would break without it |
|---|---|---|
| `tabs` | Read `tab.url` and `tab.openerTabId`; call `tabs.remove()` and `tabs.update()` | Layer 1 cannot identify or close an ad tab, and cannot restore the original tab |
| `webNavigation` | `onCreatedNavigationTarget` for new-tab origin; `onCommitted` transition qualifiers to distinguish a user click from a self-redirect | Layer 2 cannot see redirect chains; Layer 1 loses its most reliable signal |
| `storage` | Settings, trusted sites, stats, activity, per-tab last-safe-URL | Nothing is remembered across a service-worker restart |
| `declarativeNetRequest` | The only MV3 way to actually block a request | Layer 2 degrades to detect-and-offer-recovery only |
| `declarativeNetRequestFeedback` | `onRuleMatchedDebug` so the dashboard can show what was blocked | Blocked-request counters stay at zero (unpacked-only feature anyway) |
| `alarms` | Flush buffered stats and prune stale per-tab state on a timer that survives service-worker sleep | Stats could be lost when the worker is killed; state would leak |
| `content_scripts: <all_urls>` | Layer 3 must be able to inspect any page the user visits | Element blocking only works on a hardcoded list of sites |

Notably **absent**: no `host_permissions`, no `webRequest`, no `<all_urls>` fetch access, no
`cookies`, no `history`, no `management`, no remote code. The extension makes zero network requests
of its own.

---

## 7. The decision model (shared by all three layers)

Every judgement produces the same shape:

```js
{
  confidence: "high" | "medium" | "low",
  score: 0..100,
  reasons: ["domain-in-adlist", "opener-was-click", ...],
  matchedRule: "ads-doubleclick" | null
}
```

Evidence is additive, and **negative evidence can veto**:

```
  +  destination domain on the local ad-domain list ............ strong
  +  URL matches a known ad URL pattern (/ads/, ?utm_adgroup=) . moderate
  +  navigation was a client_redirect, not a user click ........ moderate
  +  new tab opened with no user gesture ....................... moderate
  +  tab opened and immediately redirected twice+ .............. moderate
  -  destination path looks like auth/payment/download ......... VETO
  -  destination domain is on the trusted list ................. VETO
  -  tab was opened by SRG itself .............................. VETO
  -  same registrable domain as the opener ..................... strong negative
```

| Confidence | Layer 1 (tabs) | Layer 2 (navigation) | Layer 3 (elements) |
|---|---|---|---|
| **high** | close the tab after the configured delay, re-activate opener | DNR already blocked it; log + offer recovery | hide element, record undo |
| **medium** | do **not** close; log and badge (optional user confirmation) | log + offer recovery link, never auto-navigate | configurable, default **off** |
| **low** | allow | allow | allow |

The veto list is what keeps the false-positive rate low. A path or host containing `login`, `signin`,
`oauth`, `auth`, `sso`, `checkout`, `payment`, `billing`, `3ds`, `download`, `captcha` is never
treated as an ad by the tab or navigation layers, no matter what else matches.

**The one-second close, done properly.** The delay is not the detection. The sequence is: detect →
confirm high confidence → *then* wait `closeDelayMs` (default 1000) → re-verify the tab still exists
and still points at the confirmed-bad destination → close. The delay exists only so a tab that is
mid-redirect-chain settles on its final URL before we judge it, and so the user sees that something
happened. A timer alone never closes anything.

---

## 8. Lifecycle walkthrough 1 — an ad tab (the Section 19 example)

User is on `example.com/article` (tab 42) and clicks a button that calls
`window.open("http://ads.example-adnetwork.test/landing")`.

```
 ① Page calls window.open()
      │
 ② Chrome creates tab 77, records openerTabId = 42
      │
 ③ chrome.webNavigation.onCreatedNavigationTarget fires
      {sourceTabId: 42, tabId: 77, url: "http://ads.example-adnetwork.test/landing"}
      │   ──► background/service-worker.js receives it
      │   ──► hands it to background/tab-monitor.js
      │
 ④ tab-monitor records: {tabId:77, openerTabId:42, openerUrl:"example.com/article",
                         createdAt:now, urlHistory:["…/landing"], userGesture:unknown}
      │
 ⑤ tabs.onUpdated fires for tab 77 as it navigates/redirects.
    Each new URL is appended to urlHistory.
      │
 ⑥ tab-monitor builds a context and calls detection-engine.classifyTab(ctx)
      • domain on ad list?            yes  → +strong
      • redirect chain length 2       yes  → +moderate
      • path contains auth/payment?   no   → no veto
      • opener domain == dest domain? no
      • trusted site?                 no
      → {confidence:"high", score:88, reasons:[...], matchedRule:"ads-test-network"}
      │
 ⑦ action-manager.closeAdTab(77, {delay:1000})
      • schedules the close
      • after 1000 ms re-reads tab 77 with chrome.tabs.get()
      • still exists? still the same bad host? ──► chrome.tabs.remove(77)
      • tab already gone / navigated somewhere benign ──► abort, do nothing
      │
 ⑧ action-manager calls chrome.tabs.update(42, {active:true})
    Tab 42 was never touched, so the article is exactly where the user left it.
      │
 ⑨ storage-manager increments stats.tabsClosed and appends one activity row
    {domain:"ads.example-adnetwork.test", layer:"tab", action:"closed",
     confidence:"high", ts:…}. The popup badge updates.
```

If step ⑥ had come back `medium`, step ⑦ would **not** close anything — it would only log the event
and show it in Recent Activity, so the user can add a rule themselves.

---

## 9. Lifecycle walkthrough 2 — a same-tab redirect

```
 User on example.com/article (tab 42)
      │
 ① Click triggers location.href = "http://redirect.example-adnetwork.test/go"
      │
 ② chrome.webNavigation.onBeforeNavigate fires for tab 42, frameId 0
      │   navigation-monitor already stored lastSafeUrl[42] = "example.com/article"
      │   (written to chrome.storage.session — memory only)
      │
 ③ TWO possible outcomes, and the difference matters:
      │
      ├─ (a) The destination matches a rule in rules/rules.json.
      │      Chrome's DNR engine blocks the request BEFORE it leaves the browser.
      │      The navigation fails; the user stays on the article.
      │      webNavigation.onErrorOccurred fires → we log "blocked".
      │      ✔ This is real prevention.
      │
      └─ (b) The destination is not in any rule.
             The navigation completes. onCommitted fires with
             transitionQualifiers:["client_redirect"].
             ✘ We cannot undo this — no MV3 API can cancel a committed navigation.
             So: classify it, and if high/medium, offer RECOVERY:
               • badge + popup banner "Redirected away from example.com/article"
               • one click → chrome.tabs.update(42, {url: lastSafeUrl})
             We never navigate back automatically, because a cross-domain
             redirect is completely normal for OAuth, payments and downloads.
```

This is the honest limitation to understand: **Layer 2 prevents only what is already in a rule;
everything else it can only detect and offer to undo.**

---

## 10. Lifecycle walkthrough 3 — a floating ad already in the HTML

```
 ① Chrome starts parsing example.com/article
 ② content/content.js is injected at document_start (before the DOM is built)
 ③ content.js asks the service worker for config:
      {type:"SRG_GET_CONFIG"} ──► service-worker ──► storage-manager + rules/element-selectors.json
      ◄── {settings, selectors, allowSelectors, trusted:false}
    While waiting, it injects a <style> with the high-confidence selectors so known
    ad containers are hidden by CSS the moment they parse — no flicker.
 ④ On DOMContentLoaded, content.js runs ONE scan:
      element-detector.scan(document) walks only candidate nodes
      (matched selectors + fixed/sticky positioned elements above a size threshold)
 ⑤ For each candidate, element-detector.score(el) checks:
      + matches a known ad selector / id / class token      → high
      + is an <iframe> whose src host is on the ad list     → high
      + position:fixed, high z-index, covers >25% viewport,
        contains an outbound link, no form inputs           → medium
      - matches an ALLOW selector (cookie banner, login
        dialog, <video>, <nav>, role="dialog" with a form)  → VETO, never hide
 ⑥ element-blocker.hide(el) for high confidence:
      • saves {id, selectorPath, prevDisplay, prevVisibility} in an undo map
      • sets el.style.setProperty("display","none","important")
      • adds data-srg-hidden="<id>"
      Hide, never remove — restoring is then a one-line undo.
 ⑦ A batched count goes to the service worker once, not once per element:
      {type:"SRG_REPORT_HIDDEN", items:[…]} → stats.elementsHidden += n
```

## 11. Lifecycle walkthrough 4 — an ad injected after 3 seconds, and overlays

A single page-load scan would miss this entirely, which is why the observer exists.

```
 t=0.0s  page loads, scan finds nothing
 t=3.0s  the site's own script does document.body.appendChild(adDiv)
 t=3.0s  MutationObserver callback fires with a childList mutation
             │
             ├─ mutation-observer.js pushes addedNodes into a pending queue
             ├─ it does NOT process immediately — it debounces ~150 ms and
             │  coalesces bursts, so a site adding 500 nodes costs one pass
             └─ the batch runs inside requestIdleCallback so scrolling stays smooth
             │
 t=3.15s  for each queued node:
             • already in the processed WeakSet? skip (prevents re-work and loops)
             • not an Element / not rendered? skip
             • element-detector.score(node)
             • high → element-blocker.hide(node)
             │
          Overlay-specific scoring: an element that appears *after* load, is
          position:fixed or has an ancestor with inert/aria-hidden siblings,
          has z-index ≥ 1000, covers most of the viewport and sets
          body{overflow:hidden} is a classic interstitial → medium/high.
          But if it contains a password input, a <form action=…checkout…>,
          a cookie-consent keyword, or role="dialog" with a labelled close
          button and no outbound ad link, the ALLOW rules veto it.
```

Loop safety is explicit: the observer is configured with
`{childList:true, subtree:true, attributes:true, attributeFilter:["class","style","id"]}`, our own
mutations set a `suppress` flag that the callback checks, every processed node is recorded, and the
observer is disconnected on `pagehide` so nothing leaks.

### Cross-origin iframes — the hard wall

If `example.com` embeds `<iframe src="https://ads.other.test/banner">`, our content script **cannot**
read or modify anything inside that iframe. The browser's same-origin policy forbids it, and no
extension permission changes that. What we *can* do:

1. Inspect the iframe **element** from the parent page (its `src`, size, position) and hide the whole
   frame if the host matches the ad list — URL-level detection.
2. Let DNR block the iframe's request outright with `resourceTypes:["sub_frame"]`, so it never loads.
3. Have the content script also run in child frames (`all_frames:true`), where it independently
   applies Layer 3 *inside* that frame if the frame's own origin allows our script to run.

Anything served from the *same* domain as the real content (first-party ads) is largely out of reach
for URL-based blocking, which is a genuine, unavoidable limitation.

---

## 12. Surviving the service worker going to sleep

This bites every MV3 beginner. The worker is killed after ~30 s idle, so:

* **No long-lived globals.** Per-tab tracking (`tabId → opener, urlHistory`) is mirrored into
  `chrome.storage.session`, and rebuilt lazily on the next event if it is missing.
* **No `setTimeout` longer than a few seconds** for anything important — a sleeping worker drops
  timers. The 1000 ms close delay is short enough to be safe, and the close path re-verifies the tab
  with `chrome.tabs.get()` instead of trusting what it remembered.
* **`chrome.alarms`** (minimum period 1 minute) handles the slow jobs: flush buffered stats, prune
  per-tab records for tabs that no longer exist.
* **Writes are batched.** Stats are accumulated in memory and flushed on a debounce *and* on alarm,
  because `chrome.storage.local` has write-rate quotas and per-element writes would blow through them.
* **`onInstalled` + `onStartup`** both call the same `bootstrap()` which installs defaults, applies
  dynamic DNR rules and validates the stored schema version.

---

## 13. Failure policy

The rule is **fail open**: if anything is unknown, broken or ambiguous, leave the user's browsing
alone.

* Invalid/empty URL, `chrome://`, `about:`, `file://`, extension pages → ignore entirely.
* `chrome.tabs.get()` throws (tab already closed) → swallow and abort the action.
* Missing `openerTabId` → the tab is treated as user-initiated, never auto-closed on that evidence
  alone.
* A malformed rule file → that rule is skipped, the rest still load; the error is logged in the
  dashboard.
* A thrown exception inside the detector → the element is left visible.
* Protection master switch off → all event listeners return immediately, before any work.

No error path is allowed to end in `tabs.remove()` or `element.remove()`.

---

## 14. Trusted sites: what "trusted" actually exempts

A trusted entry is per-domain and per-layer, not a blanket kill switch:

```js
{ domain: "news.example.com",
  scope: { tab: true, redirect: true, element: false },
  expiresAt: 1763000000000 | null,   // "disable for 1 hour" support
  addedAt: … }
```

The dashboard spells out, in words, what each checkbox stops doing — because silently disabling all
three layers for a domain is exactly how an ad blocker becomes useless without the user noticing.
Trust is matched on the registrable domain plus subdomains, and a trusted domain also gets a
high-priority DNR `allowAllRequests` rule so Layer 2 lets it through natively.

---

## 15. Phase plan

| Phase | Content | Status |
|---|---|---|
| 1 | Architecture, interfaces, permission model (this document + `INTERFACES.md`) | ✅ |
| 2 | manifest, storage manager, DNR rules, Layers 1 & 2 (background) | — |
| 3 | Layer 3 (content scripts, detector, blocker, observer, selectors) | — |
| 4 | Storage: statistics, activity history, trusted sites, export/import, quota safety | — |
| 5 | Popup and dashboard UI | — |
| 6 | Mock test site, executed tests, test report | — |
| 7 | README, install/testing instructions, limitations | — |

---

## 16. Known limitations (stated up front, not discovered later)

1. A committed same-tab navigation cannot be cancelled retroactively in Manifest V3. Only DNR rules
   prevent; everything else detects and offers recovery.
2. First-party ads served from the content domain cannot be blocked by URL.
3. Cross-origin iframe internals are unreadable by design.
4. `onRuleMatchedDebug` statistics only work when the extension is loaded unpacked.
5. The shipped rule lists are small, clearly-labelled **examples** — this is an engine, not a curated
   filter list. No remote list is ever downloaded automatically.
6. Heuristic (medium-confidence) element detection is off by default. Turning it on will eventually
   hide something it should not; that is why Restore exists.
7. SRG does not attempt to defeat anti-adblock detection or paywalls.
