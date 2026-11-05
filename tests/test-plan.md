# SRG Test Plan

Two kinds of testing are used, and the difference matters when reading the results:

| Kind | What it proves | Where |
|---|---|---|
| **Automated (Node)** | The pure logic — scoring, veto rules, domain parsing, rule-file validity, storage merge/trim behaviour — behaves as specified. Runs with `node tests/test-rules.js`. No browser needed. | `tests/test-rules.js` |
| **Manual (Chrome)** | The parts that only exist inside a real browser — tab closing, navigation events, DNR blocking, MutationObserver timing, UI. Driven by the local mock site. | `tests/mock-site/` |

**No test is marked "pass" in `tests/TEST-REPORT.md` unless it was actually executed.** Manual
cases that were not run in a real Chrome profile are recorded as *Not executed*, not as passes.

---

## Running the automated tests

```bash
node tests/test-rules.js
```

Exit code 0 = all assertions passed. The runner prints one line per assertion group and a summary.

## Running the mock site

The mock site is plain static HTML — no server is required for most cases, but a couple of them
need real origins to exercise cross-site logic. Two options:

```bash
# Option A - file:// (quickest; cross-origin cases will be limited)
#   open tests/mock-site/index.html in Chrome

# Option B - two local origins (recommended, exercises cross-site rules)
cd tests/mock-site && python -m http.server 8080
#   publisher site : http://localhost:8080/index.html
#   "ad" site      : http://127.0.0.1:8080/ad-landing.html
# 127.0.0.1 and localhost are different hosts to Chrome, so this is a genuine cross-site test.
```

Load the extension first: `chrome://extensions` → Developer mode → **Load unpacked** → select the
project root.

> The mock "ad" pages use reserved example hostnames and local addresses only. No real advertising
> network is contacted at any point.

---

## Test matrix

| # | Scenario | How to run it | Expected result | Kind |
|---|---|---|---|---|
| 1 | Normal website navigation | Mock site → "Normal internal link" | Page loads, nothing closed, nothing hidden, no activity row | Manual |
| 2 | Known ad popup opens in a new tab | Mock site → "Open known ad tab" (opens a URL matching a static DNR/ad-domain rule) | New tab is detected as high confidence, closed after the configured delay, original tab stays open and becomes active, `tabsClosed` increments | Manual |
| 3 | Legitimate external link opens in a new tab | Mock site → "Open legitimate external link" (`target=_blank` to a normal host) | Tab stays open; verdict is low; no activity row or a low/allowed row only | Manual |
| 4 | Login redirect | Mock site → "Simulated login redirect" (`/login?next=…`) | Veto fires on the auth token; navigation proceeds untouched | Manual |
| 5 | Suspicious same-tab redirect | Mock site → "Same-tab redirect to ad host" | Either DNR blocks it (`ERR_BLOCKED_BY_CLIENT`, logged as `blocked`) or it commits and recovery is offered in the popup; never an automatic navigation back | Manual |
| 6 | Unknown domain opens in a new tab | Mock site → "Open unknown domain" | Verdict low or medium; tab is **not** closed | Manual |
| 7 | Floating ad banner present at load | Mock site → `ads-static.html` | The known ad container is hidden; the rest of the page is intact | Manual |
| 8 | Ad injected after 3 seconds | Mock site → `ads-dynamic.html` | MutationObserver detects it within ~1 s of injection and hides it; `elementsHidden` increments | Manual |
| 9 | Legitimate modal dialog | Mock site → `legit-ui.html` → "Open modal" | Dialog stays visible and usable | Manual |
| 10 | Cookie consent dialog | Mock site → `legit-ui.html` (consent bar renders on load) | Bar stays visible, Accept/Reject still work | Manual |
| 11 | Restore a hidden element | Dashboard → Hidden elements → Restore | Element reappears with its original inline styles; `elementsRestored` increments | Manual |
| 12 | Service-worker restart | `chrome://serviceworker-internals` → Stop, or wait ~30 s idle, then repeat test 2 | Behaviour unchanged; state rebuilt from `chrome.storage.session` or re-derived | Manual |
| 13 | Protection disabled | Popup → master switch off → repeat tests 2, 5, 7 | No tabs closed, no elements hidden, no DNR dynamic rules applied | Manual |
| 14 | Trusted site opens an external link | Dashboard → add the mock publisher host as trusted (tab scope) → repeat test 2 | Tab stays open; activity row shows the trusted veto | Manual |
| 15 | Cross-origin iframe ad | Mock site → `ads-iframe.html` | The iframe **element** is hidden from the parent page by host match; the extension does not attempt to read inside it; limitation documented | Manual |
| A1 | Scoring: ad-domain match reaches high | `node tests/test-rules.js` | high | Auto |
| A2 | Scoring: heuristics alone never reach high | " | medium at most | Auto |
| A3 | Veto: auth/payment/download URLs | " | low, veto reason present | Auto |
| A4 | Veto: trusted domain and subdomain | " | low | Auto |
| A5 | Veto: SRG-opened tab | " | low | Auto |
| A6 | `registrableDomain` incl. multi-part TLDs, IPs, localhost | " | exact expected values | Auto |
| A7 | Same-site opener suppresses the tab verdict | " | low/medium, never high | Auto |
| A8 | Navigation: `client_redirect` + ad domain → high; user `link` click → downweighted | " | as specified | Auto |
| A9 | Element scoring: allow-match short-circuits | " | low | Auto |
| A10 | Element scoring: password field / video veto | " | low | Auto |
| A11 | Background and content scoring tables are numerically identical | " | identical | Auto |
| A12 | `rules/rules.json` is a structurally valid DNR ruleset (unique ids, known keys, valid actions and resourceTypes) | " | valid | Auto |
| A13 | `rules/element-selectors.json` schema + selector sanity | " | valid | Auto |
| A14 | Token matcher rejects `badge`/`download`/`loading`/`add` for token `ad` | " | rejected | Auto |
| A15 | Settings deep-merge keeps unrelated nested keys | " | preserved | Auto |
| A16 | Activity log trims to `maxEntries` and stays newest-first | " | trimmed | Auto |
| A17 | `isTrusted` honours scope per layer and `expiresAt` | " | as specified | Auto |
| A18 | `manifest.json` is valid MV3 (no MV2 keys, declared files exist) | " | valid | Auto |

---

## Known limitations that tests cannot overcome

* A committed same-tab navigation cannot be cancelled in MV3 — test 5 therefore has two acceptable
  outcomes depending on whether a DNR rule covered the destination.
* `onRuleMatchedDebug` only reports for unpacked extensions, so DNR match counts are unavailable in
  a packed build.
* Cross-origin iframe internals (test 15) are unreadable by design; only element-level and
  URL-level handling is testable.
* The automated suite runs the detection logic in Node with a light DOM shim. It validates scoring
  and rule data, not real rendering or real browser event ordering.
