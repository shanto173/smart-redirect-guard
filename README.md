# Smart Redirect Guard (SRG)

An intelligent, privacy-focused Chrome extension (Manifest V3) that deals with three *technically
different* problems that people lump together as "ads":

| Layer | Problem | What SRG does |
|---|---|---|
| **1. New-tab protection** | A click opens an unwanted advertising tab | Detects the tab, confirms the destination against local rules, then closes it and brings your original tab back |
| **2. Redirect protection** | A click replaces the page you were reading with an ad site | Blocks known destinations with `declarativeNetRequest`, and offers one-click recovery to the last safe URL when a redirect already completed |
| **3. Element blocking** | Ads drawn inside the page: banners, sticky bars, overlays, ad iframes | Hides them with a confidence-scored detector plus a `MutationObserver` for ads injected seconds after load |

The three layers are **independent**. Each can be switched off on its own without affecting the
others, which matters: if element blocking ever breaks a site, you turn off element blocking, not
your whole protection.

Everything runs locally. **No backend, no analytics, no telemetry, no remote filter lists, and the
extension makes zero network requests of its own.**

---

## Contents

- [Install it](#install-it)
- [Try it immediately](#try-it-immediately-the-mock-test-site)
- [Permissions, and why each one is needed](#permissions-and-why-each-one-is-needed)
- [How it decides what to block](#how-it-decides-what-to-block)
- [Project structure](#project-structure)
- [Running the tests](#running-the-tests)
- [Known limitations](#known-limitations)
- [Future improvements](#future-improvements)
- [Documentation](#documentation)

---

## Install it

SRG is not on the Chrome Web Store. Load it as an unpacked extension:

1. Download or clone this repository.
2. Open Chrome and go to **`chrome://extensions`**.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked**.
5. Select the **project root folder** — the one containing `manifest.json`. Not a subfolder.
6. The shield icon appears in your toolbar. Pin it (puzzle-piece icon → pin) so you can reach the
   popup easily.

Requires Chrome 110 or newer.

**Updating after a code change:** go back to `chrome://extensions` and click the reload arrow on
the SRG card. Content script changes also need a page refresh.

**Where things are:** click the toolbar icon for the popup (quick switches, counters, recovery).
Click **Open dashboard** in the popup — or right-click the icon → *Options* — for the full
settings, activity log, trusted sites, hidden-element restore and custom rules.

---

## Try it immediately: the mock test site

The repository ships a local test site so you never have to visit a real advertising network to
check that the extension works.

```bash
# from the project root
python -m http.server 8080 --directory tests/mock-site
```

Then open **http://localhost:8080/**.

The server answers on both `localhost` and `127.0.0.1`, and Chrome treats those as two different
sites — which is what makes the cross-site tests genuine rather than simulated.

For the tab-closing tests, first import `tests/mock-site/srg-test-config.json` via
**Dashboard → Settings → Import**. It registers `127.0.0.1` as an example ad domain, so a tab
opened there counts as a confirmed advertisement. Without it the extension correctly *refuses* to
close an unknown host — which is itself one of the test cases.

Every scenario on that page states what should happen and why.

---

## Permissions, and why each one is needed

SRG asks for six permissions and no host permissions. Each one is load-bearing:

| Permission | Why it is genuinely required | What breaks without it |
|---|---|---|
| `tabs` | Read a tab's URL and its `openerTabId`; call `tabs.remove()` to close a confirmed ad tab and `tabs.update()` to bring your original tab back | Layer 1 cannot identify, close or recover from an ad tab |
| `webNavigation` | `onCreatedNavigationTarget` tells us which tab opened a new tab *and* its destination URL; `onCommitted`'s `transitionQualifiers` distinguish "the user clicked a link" from "the page redirected itself" | Layer 2 is blind to redirect chains; Layer 1 loses its best signal |
| `storage` | Settings, trusted sites, statistics, activity log, and the per-tab last-safe-URL | Nothing survives a service-worker restart |
| `declarativeNetRequest` | The **only** API in Manifest V3 that can actually stop a request before it is sent | Layer 2 degrades to detect-and-offer-recovery, with no real prevention |
| `declarativeNetRequestFeedback` | `onRuleMatchedDebug`, so the dashboard can count blocked sub-frame requests | Some counters stay at zero (this is an unpacked-only Chrome feature anyway) |
| `alarms` | A timer that survives the service worker being put to sleep, used to flush buffered statistics and prune dead per-tab state | Statistics could be lost on worker shutdown; stale state would accumulate |

**Deliberately *not* requested:** `host_permissions` (the content-script `matches` already grant
page access), `webRequest` (its blocking form was removed in MV3 and SRG does not use it),
`scripting`, `cookies`, `history`, `management`, `unlimitedStorage`, and anything allowing remote
code.

### Privacy

* No browsing data ever leaves your machine. There is no server to send it to and no `fetch` to a
  remote host anywhere in the codebase.
* The last-safe-URL and per-tab navigation state live in `chrome.storage.session`, which is
  **memory only** and is wiped when Chrome closes, so browsing URLs are never written to disk.
* The activity log is local, capped (default 200 rows), and can be cleared with one click.
* DNR rules are evaluated natively by Chrome. The extension never sees the URLs they match.

---

## How it decides what to block

Every judgement — tab, navigation or element — returns the same shape:

```js
{ confidence: "high" | "medium" | "low", score, reasons: [...], matchedRule }
```

Two rules keep the false-positive rate down, and both are enforced structurally rather than by
convention:

**1. A `high` verdict always requires a real rule match.** Behaviour alone — no user gesture, a
long redirect chain, a floating element covering the screen — tops out at `medium`. And `medium`
never closes a tab, never navigates, and by default never hides anything.

**2. Veto signals outrank every positive signal.** If a URL's host, path or query contains an
authentication, payment, download or captcha token (`login`, `oauth`, `sso`, `checkout`,
`payment`, `3ds`, `download`, `2fa`, …), or the domain is trusted, or SRG opened the tab itself,
the verdict is `low` immediately — no matter how many ad rules also matched. Token matching is
separator-delimited, so `/login` matches but `logindexing` does not.

For elements, the hard vetoes are: an allow-list selector match on the element or an ancestor; a
contained password field, card-number field, `<video>`, captcha or auth/payment form; or covering
more than 92% of the document. These are applied *before* scoring, so they cannot be outvoted.

**The one-second close, properly.** The delay is not the detection. The sequence is:

```
detect → confirm HIGH confidence → wait closeDelayMs (default 1000) →
re-read the tab → re-classify its CURRENT url → still high? → close
```

The delay exists so a tab mid-redirect-chain settles on its final address before being judged. If
the tab has already gone, or has landed somewhere benign, the close is abandoned and logged as
`revalidation-cleared`. A timer on its own never closes anything.

**Hide, never remove.** Elements are hidden with `display: none !important` and their original
inline styles are recorded, so **Restore** in the dashboard puts them back exactly as they were.
`element.remove()` is not called anywhere in the codebase, and a test enforces that.

---

## Project structure

```
manifest.json              Manifest V3: permissions, service worker, content scripts, DNR ruleset

background/
  service-worker.js        Entry point: event wiring, message router, boot after restart
  tab-monitor.js           LAYER 1 - new tab detection and opener tracking
  navigation-monitor.js    LAYER 2 - navigation/redirect watching, last-safe-URL memory
  detection-engine.js      Pure scoring. No Chrome APIs, no I/O, unit-testable in plain Node
  action-manager.js        The ONLY module allowed to cause a side effect

content/
  content.js               LAYER 3 coordinator
  element-detector.js      Collects signals about an element and asks for a verdict
  element-blocker.js       Hides elements and keeps a lossless undo record
  mutation-observer.js     Debounced, loop-safe, budgeted MutationObserver wrapper

shared/
  element-scoring.js       ONE scoring table + function, loaded by BOTH the worker and the page

rules/
  rules.json               Static declarativeNetRequest ruleset (real blocking)
  element-selectors.json   Ad selectors, ad iframe hosts, and the allow list
  trusted-sites.json       Shipped default trusted sites (auth and payment providers)

storage/storage-manager.js The only module that touches chrome.storage

popup/                     Quick controls, counters, recovery banner, trust panel
dashboard/                 Full settings, activity, trusted sites, restore, custom rules
icons/                     16/32/48/128px PNGs + the script that generates them
tests/                     Automated suite, mock test site, test plan and report
docs/                      Architecture, module contract, rule documentation
```

Why `detection-engine.js` is separate from the monitors: scoring is the part most likely to be
wrong, and a pure function with no Chrome dependencies can be unit-tested in plain Node. Monitors
gather facts, the engine judges them, the action manager acts. One responsibility each, and
exactly one file to audit for "could this close a legitimate tab?".

---

## Running the tests

```bash
npm install        # installs jsdom, used only by the test harness
npm test           # or: node tests/test-rules.js
```

105 assertions covering scoring, veto rules, domain parsing, the storage manager, the rule data
files, Manifest V3 validity, UI↔worker message-contract drift, and the real detector run over the
real mock-site pages. Exit code 0 means everything passed.

The extension itself ships **zero dependencies**; `jsdom` is a dev-only test dependency.

The automated suite cannot prove anything about real tab closing, real navigation events, real DNR
blocking or the UI — those need a browser. See [`tests/test-plan.md`](tests/test-plan.md) for the
15 manual scenarios and [`tests/TEST-REPORT.md`](tests/TEST-REPORT.md) for results, where anything
not actually executed is recorded as **not executed** rather than as a pass.

---

## Known limitations

These are real and stated up front, not discovered later.

1. **A committed same-tab navigation cannot be cancelled in Manifest V3.** Nothing can undo it
   after the fact. Only a `declarativeNetRequest` rule *prevents* a redirect; for everything else
   SRG can only detect it and offer you a way back. This is a platform limit, not an oversight.
2. **Cross-origin iframe internals are unreadable.** The same-origin policy forbids it and no
   extension permission changes that. SRG can judge the iframe *element* from the parent page (its
   `src`, size, position) and can have DNR block the frame's request, but it cannot look inside.
3. **First-party ads are largely out of reach.** Ads served from the same domain as the real
   content cannot be separated by URL.
4. **The shipped rule lists are illustrative examples**, deliberately using reserved `.test`,
   `.example` and `.invalid` domains. This is a detection *engine*, not a curated filter list, and
   no remote list is ever downloaded. Add real rules yourself under Dashboard → Custom rules.
5. **`onRuleMatchedDebug` only works for unpacked extensions**, so blocked-request counts would be
   unavailable in a packed build.
6. **Medium-confidence element handling is off by default.** Turning it on *will* eventually hide
   something it should not. That is precisely why Restore exists.
7. **Cosmetic CSS is applied before scoring.** To prevent ad containers flashing on screen during
   page load, high-confidence selectors are injected as a stylesheet at `document_start`, before
   any element exists to examine. That path is selector-only and does not run the allow-list
   vetoes. The high-confidence and allow lists are disjoint by construction, but if you add an
   over-broad custom selector it will hide matching elements without a veto check. Turn off
   **Settings → Element layer → Cosmetic CSS** if you want every hide to go through full scoring.
8. **SRG does not attempt to defeat anti-adblock detection or paywalls**, and does not circumvent
   website access controls.
9. **No extension can remove every advertisement.** Anyone claiming otherwise is selling something.

---

## Future improvements

* Optional, explicitly user-initiated import of a standard filter list, converted locally to DNR
  rules — never automatic, never silent.
* Per-site statistics and a "why was this hidden?" inspector overlay.
* A heuristics "preview" mode that highlights what medium confidence *would* hide, without hiding
  it, so the setting can be evaluated safely.
* Syncing settings through `chrome.storage.sync` as an opt-in.

---

## Documentation

| Document | Contents |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | How it works end to end, in beginner-friendly language: the two-world extension model, every Chrome API and its real limits, data flow, and four step-by-step lifecycle walkthroughs (ad tab, same-tab redirect, static ad, dynamically injected overlay) |
| [`docs/INTERFACES.md`](docs/INTERFACES.md) | The module contract: message protocol, storage schemas, every module API, rule file schemas |
| [`docs/RULES.md`](docs/RULES.md) | How the rule system works, DNR static vs dynamic rules, id ranges, and how to add your own |
| [`tests/test-plan.md`](tests/test-plan.md) | The 15 browser scenarios and 20+ automated checks |
| [`tests/TEST-REPORT.md`](tests/TEST-REPORT.md) | What was actually run, and what was not |

## License

MIT — see [`LICENSE`](LICENSE).
