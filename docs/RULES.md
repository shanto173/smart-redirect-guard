# SRG Rule System

This document explains the rules Smart Redirect Guard (SRG) uses, where they live, and how they
reach Chrome. Read it together with `docs/ARCHITECTURE.md`.

## IMPORTANT: the shipped lists are illustrative examples

Every domain in `rules/rules.json` uses a reserved or clearly fake top-level domain (`.test`,
`.example`, `.invalid`, see RFC 2606 and RFC 6761) such as `example-adnetwork.test` or
`popunder.example.test`. **They are not real advertisers, they are not a verified malicious list,
and they will never match real traffic.** They exist so the engine, the tests and the mock site have
something safe to work with. SRG is an engine, not a curated filter list. Nothing is downloaded
automatically. Real protection requires you to add your own rules (see below) or, in the future, a
reviewed filter list.

The trusted-sites list (`rules/trusted-sites.json`) is different: it holds real, well-known
sign-in, payment and developer domains so that login and checkout flows are never interfered with.

## The three kinds of rule

1. **Redirect-protection rules (domain blocks).** `block` rules with `condition.requestDomains` and
   `resourceTypes: ["main_frame", "sub_frame"]`. If a page tries to navigate a tab or frame to one of
   these domains (or any subdomain), Chrome cancels the request before it leaves the browser. This
   is the only real "prevention" SRG can do for navigations.
2. **Ad-resource rules.** `block` rules on `requestDomains` for `sub_frame`, `script` and `image`
   (and a few `ping` / `xmlhttprequest` ones). They stop ad iframes, scripts and banners from
   loading at all.
3. **URL-pattern rules.** `block` rules using `condition.urlFilter` such as `*/popunder*` or
   `*/ad-redirect*`. These catch ad URLs on domains we do not know. They are limited to
   `main_frame` and `sub_frame` so ordinary page assets are not affected. Patterns are broad, so
   keep them specific.

All shipped static rules are block-only with `priority` 1. Trusted-site exceptions are added at
runtime with a higher priority (below).

## Static vs dynamic rules

| | Static rules | Dynamic rules |
|---|---|---|
| Source | `rules/rules.json`, declared in `manifest.json` as ruleset `srg-static` | Added at runtime with `chrome.declarativeNetRequest.updateDynamicRules()` |
| Who changes them | Only a new extension version | The extension, in response to user actions |
| Survive restart | Yes (part of the package) | Yes (Chrome persists them) |
| Used by SRG for | Shipped example blocks | Trusted-site exceptions and user custom rules |

Static rules must be a bare JSON array. Chrome **rejects unknown keys**, so the JSON cannot hold
comments. All explanation lives here instead.

## Rule id ranges

| Range | Owner |
|---|---|
| 1 - 999 | static ruleset (`rules/rules.json`) |
| 1000 - 1999 | dynamic: trusted-site `allowAllRequests` rules |
| 2000 - 2999 | dynamic: user custom block rules |

Every update removes the whole range it owns first and then adds the new set, so the ranges never
collide and stale rules never linger.

## How trusted sites become allow rules

When you trust a site and the "redirect" scope is ticked, SRG creates a dynamic rule:

```json
{ "id": 1000, "priority": 100,
  "action": { "type": "allowAllRequests" },
  "condition": { "requestDomains": ["accounts.google.com"],
                 "resourceTypes": ["main_frame", "sub_frame"] } }
```

`allowAllRequests` with priority 100 beats every priority-1 block rule for that page and the requests
it makes, so a trusted login page works even if some resource would otherwise match a block rule.
Entries that have expired (the "pause for one hour" feature) are skipped when the rules are rebuilt.
The tab and element layers consult the same trusted list in code.

## Adding custom rules

Custom rules live in `chrome.storage.local` under `srg.customRules`:

```json
{ "adDomains": [], "suspiciousDomains": [], "urlPatterns": [], "selectors": [], "allowSelectors": [] }
```

* `adDomains` become dynamic DNR `block` rules (`requestDomains`) AND feed the in-code detection
  engine (+55 score).
* `suspiciousDomains` feed only the detection engine (+30); they never block by themselves.
* `urlPatterns` become dynamic DNR `urlFilter` block rules and feed the engine.
* `selectors` / `allowSelectors` are used by the element layer.

Use the dashboard (or the `SRG_UPDATE_CUSTOM_RULES` message). Entries are validated: domains must
look like host names, patterns must be printable text without spaces. Invalid entries are skipped,
not fatal. Saving re-applies the dynamic rules at once.

## Limits

* Static rulesets: Chrome guarantees at least 30,000 static rules per extension.
* Dynamic plus session rules together: 5,000 on older Chrome versions, 30,000 on newer ones. SRG
  uses a few dozen at most, but custom lists are cut off well below the old limit.
* Regex rules have a separate, much smaller cap; SRG does not use `regexFilter`.
* `onRuleMatchedDebug` (used for the blocked-requests counter) only exists when the extension is
  loaded unpacked.

## Adding filter-list updates safely in the future

Nothing is fetched today. If updates are ever added, they should follow these rules:

1. Never download and apply a list silently. The user opts in and sees the source.
2. Treat the list as data, never code. Convert it to DNR rule objects; never evaluate it.
3. Validate every rule (allowed keys, types, id range, size) and skip bad ones.
4. Keep downloaded rules in a separate dynamic id range, so they can be wiped in one call, and keep
   them below the dynamic cap.
5. Trusted sites always win: their priority-100 allow rules stay above any imported block rule.
6. Show a diff or count before applying, and keep a one-click rollback.
7. Preferably ship list updates inside a new extension version (static rules) so Chrome Web Store
   review covers them.
