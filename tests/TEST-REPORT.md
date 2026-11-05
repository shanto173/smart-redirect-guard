# SRG Test Report

**Date:** 2026-11-05
**Version:** 0.2.0
**Environment:** Windows 11, Node.js v24.13.1, jsdom 26.1.0

---

## The honesty rule for this document

A test is marked **PASS** only if it was actually executed and actually passed. Everything that
requires a real Chrome profile and has not been run is marked **NOT EXECUTED** — not "expected to
pass", not "should work". Where a result is partial, the limitation is stated next to it.

---

## Part 1 — Automated suite (executed)

```
$ node tests/test-rules.js
passed: 105   failed: 0   skipped: 0
exit code 0
```

| Group | Assertions | Result |
|---|---|---|
| A1–A7 Tab classification (Layer 1) | 14 | **PASS** |
| A8 Navigation classification (Layer 2) | 3 | **PASS** |
| A9–A11 Element scoring (shared module) | 10 | **PASS** |
| A12–A13 Rule data files | 9 | **PASS** |
| A18 Manifest V3 validity | 10 | **PASS** |
| A19 UI ↔ worker message contract | 4 | **PASS** |
| A15–A17 Storage manager (fake `chrome.storage`) | 17 | **PASS** |
| A14 + INT Content scripts and worker→page integration (jsdom) | 21 | **PASS** |
| M Detector vs. the real mock-site pages (jsdom) | 17 | **PASS** |
| **Total** | **105** | **105 pass / 0 fail** |

### Notable assertions, in plain language

| ID | What it proves | Result |
|---|---|---|
| A2 | An unknown domain reached through a 3-hop chain with no user gesture **cannot** reach high confidence. Heuristics alone never justify closing a tab. | PASS |
| A3 | A URL on a known ad domain is still vetoed to `low` when its path contains `login`, `checkout/payment`, `download` or `oauth`. | PASS |
| A3b | `logindexing` is **not** vetoed as `login` — token matching is separator-delimited, not substring. | PASS |
| A7 | A new tab on the same site as its opener never reaches high confidence. | PASS |
| A8b | A plain user link click to an unknown site scores `low`. Cross-domain is not evidence. | PASS |
| A8c | An OAuth redirect to a trusted provider is never flagged. | PASS |
| A10c | The maximum possible heuristic stack (fixed + z-index 99999 + 95% coverage + injected late + outbound ad link) still cannot reach high confidence. | PASS |
| A11a–d | The background engine and the page-side detector use **one** scoring implementation; no duplicate weights table survives in either file. | PASS |
| A12c | No shipped example rule references a real-looking TLD. | PASS |
| A14b | The token `ad` does not match `badge`, `download`, `gradient`, `loading`, `thread`, `header`, `radio`, `padding`, `upload`, `add`, `shadow`, `road`, `broadcast`. | PASS |
| A17c | `evilexample.com` is not matched by a trusted entry for `example.com`. | PASS |
| A19b | Every message type the popup and dashboard send has a handler in the service worker. | PASS |
| INT2/INT3 | A user-supplied custom selector and a custom ad-iframe host, delivered through the worker's real config reply, actually take effect in the page. | PASS |
| E5 | An element matching a high-confidence ad selector that contains a password field is **not** hidden. | PASS |
| B5 | Restore returns an element's exact original inline styles. | PASS |
| B6 | `element.remove()` appears nowhere in the content scripts. | PASS |
| M4 | The mock cookie bar, payment form and video player are all protected. | PASS |
| M6 | The control article page produces zero detections. | PASS |

### Bugs found and fixed by this suite

These were genuine defects, caught before any browser testing:

1. **The worker's config reply never reached the detector.** The service worker sent
   `selectors` as a nested object while the content script read it as a flat array, so every
   user-defined selector and every edit to `rules/element-selectors.json` was silently ignored —
   the page fell back to built-in defaults. Fixed by making the worker emit the exact flat shape
   `configure()` consumes; `INT1`–`INT3` now guard it.
2. **Two divergent scoring tables.** The background engine and the content detector had each
   invented their own element weights, with different numbers and *opposite* meanings for text
   hints. Replaced with one shared module loaded by both worlds; `A11a`–`A11d` enforce it.
3. **Protective text was a hard veto**, which made its weight dead code and would have let any ad
   whose text said "download now" escape. Now a capped penalty that brakes heuristic-only
   candidates without overriding an explicit rule match.
4. **Payment forms were protected only by scoring, not by veto.** A checkout form frequently has
   no password field and no telltale `action` attribute. Card-field autocomplete tokens
   (`cc-number`, `cc-csc`, `one-time-code`) and card/cvv name/id patterns are now hard vetoes.
5. **A test fixture lied about the engine.** `ads-static.html` claimed its floating banner would
   be hidden at high confidence; that selector is on the medium list by design. Fixture corrected,
   and `M1b` now keeps the fixture and the engine honest with each other.

### What the automated suite cannot prove

* Real tab creation, closing and re-activation.
* Real `webNavigation` event ordering and `transitionQualifiers` values.
* Real `declarativeNetRequest` blocking.
* Real `MutationObserver` timing under a live rendering engine.
* Anything about layout: **jsdom has no layout engine and does not load the external stylesheet**,
  so `position`, `z-index` and viewport-coverage signals are not exercised against the mock pages.
  Those weights are covered only by synthetic signal objects (A10c–A10f).
* The popup and dashboard as rendered UI. They were driven in jsdom with a stubbed `chrome`
  object, which verifies wiring and message payloads but not appearance or real browser behaviour.

---

## Part 2 — Browser scenarios (NOT EXECUTED)

These 15 scenarios from `tests/test-plan.md` require the extension loaded into a real Chrome
profile. **They have not been run.** No claim is made about their outcome.

| # | Scenario | Expected result | Actual | Status |
|---|---|---|---|---|
| 1 | Normal website navigation | Page works normally; no detections | — | **NOT EXECUTED** |
| 2 | Known ad popup opens in a new tab | Tab closes after the delay; original tab stays and re-activates | — | **NOT EXECUTED** |
| 3 | Legitimate external link opens | Tab stays open | — | **NOT EXECUTED** |
| 4 | Login redirect | Authentication proceeds untouched | — | **NOT EXECUTED** |
| 5 | Suspicious same-tab redirect | Blocked by DNR, or detected with recovery offered | — | **NOT EXECUTED** |
| 6 | Unknown domain opens | Not closed | — | **NOT EXECUTED** |
| 7 | Floating ad banner at load | Confirmed ad element hidden | — | **NOT EXECUTED** |
| 8 | Ad injected after 3 seconds | MutationObserver detects and hides it | — | **NOT EXECUTED** |
| 9 | Legitimate modal dialog | Stays visible and usable | — | **NOT EXECUTED** |
| 10 | Cookie consent dialog | Stays visible and functional | — | **NOT EXECUTED** |
| 11 | User restores a hidden element | Element returns with original styles | — | **NOT EXECUTED** |
| 12 | Service worker restarts | Behaviour unchanged | — | **NOT EXECUTED** |
| 13 | Protection disabled | No protective actions taken | — | **NOT EXECUTED** |
| 14 | Trusted site opens an external link | Navigation preserved; trusted exemption logged | — | **NOT EXECUTED** |
| 15 | Cross-origin iframe ad | URL-level handling only; no same-origin error | — | **NOT EXECUTED** |

Scenarios 1, 3, 4, 6, 7, 9, 10 and 15 have an *analogue* covered by the automated suite (the same
decision logic, run outside a browser), so the scoring behaviour behind them is tested even though
the browser behaviour is not. Scenarios 2, 5, 8, 11, 12, 13 and 14 depend on browser mechanics
that have no automated analogue at all.

### To run them

```bash
python -m http.server 8080 --directory tests/mock-site
```

Load the extension (`chrome://extensions` → Developer mode → Load unpacked → the project root),
import `tests/mock-site/srg-test-config.json` via Dashboard → Settings → Import, then open
http://localhost:8080/ and work down the page. Each scenario states its expected result inline.

---

## Part 3 — Known limitations confirmed during development

| Limitation | Nature |
|---|---|
| A committed same-tab navigation cannot be cancelled in MV3 | Platform limit. Layer 2 prevents only what a DNR rule already covers; everything else is detect-and-offer-recovery. |
| Cross-origin iframe internals are unreadable | Same-origin policy. Only the iframe element and its URL can be judged. |
| First-party ads cannot be separated by URL | Inherent to URL-based filtering. |
| `onRuleMatchedDebug` is unpacked-only | Chrome restriction; affects counters only. |
| Cosmetic CSS bypasses the allow-list vetoes | By design, to prevent ad flash at `document_start`. The high and allow lists are disjoint by construction, but a careless custom selector would hide without a veto check. Toggleable in settings and documented in the README. |
| Shipped rules are examples, not a filter list | Deliberate. No remote list is downloaded. |

---

## Summary

| | |
|---|---|
| Automated assertions executed | **105** |
| Automated assertions passed | **105** |
| Automated assertions failed | **0** |
| Browser scenarios executed | **0 of 15** |
| Defects found and fixed during testing | **5** |

The logic, the rule data, the storage layer, the manifest and the message contracts are tested and
passing. The browser-dependent behaviour is implemented and code-reviewed but **unverified**, and
this report does not claim otherwise.
