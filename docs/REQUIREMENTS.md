# PROJECT: SMART REDIRECT GUARD (SRG)
## Build a Complete, Intelligent Chrome Ad & Redirect Protection Extension

---

# 1. YOUR ROLE

Act as a senior Chrome Extension Engineer, JavaScript Architect, Browser Security Engineer and UI/UX Designer.

I want you to develop a complete, functional Chrome extension called:

**Smart Redirect Guard (SRG)**

This is not just a basic advertisement blocker.

It is an intelligent browser protection extension designed to detect and handle:

1. Unwanted advertising tabs and pop-ups.
2. Suspicious same-tab redirects.
3. Advertisements displayed directly inside webpages.

The objective is to provide a cleaner browsing experience without breaking legitimate website functionality.

I am not an experienced Chrome extension developer. Therefore, explain the architecture and technical decisions in beginner-friendly language.

Do not just provide theoretical explanations or disconnected code snippets. Build the actual working project with properly separated files.

---

# 2. CORE OBJECTIVE: THREE PROTECTION LAYERS

The extension must have three independent protection systems.

## LAYER 1: NEW-TAB ADVERTISEMENT BLOCKER

### Problem

Some websites open unwanted advertising tabs when users click buttons, links or other webpage elements.

Example:

1. User opens example.com.
2. User clicks an article button.
3. Website opens another Chrome tab.
4. The new tab redirects to an advertising website.
5. User gets taken away from the original browsing experience.

### Expected behaviour

1. Detect when a new tab is created.
2. Identify its opener tab when available.
3. Monitor its URL as navigation progresses.
4. Check the destination against local advertising and suspicious-domain rules.
5. Evaluate whether it is a legitimate external link or an unwanted advertisement.
6. If it is a confirmed unwanted advertising tab, close it.
7. Keep the original tab open.
8. Reactivate the original tab when appropriate.

### One-second closing mechanism

My original idea is to let the advertising tab open temporarily and close it after approximately one second.

Implement this as a configurable feature.

Default delay: 1000 milliseconds.

Requirements:

- Detect first, then close.
- Apply the delay only to confirmed unwanted tabs.
- Allow users to configure the delay.
- Preserve the original tab.
- Do not close legitimate external links.
- Do not close login, payment, authentication or download tabs.
- Avoid closing tabs intentionally opened by the extension itself.

IMPORTANT: Do not use a one-second timeout as a substitute for actual advertisement detection.

---

# 3. LAYER 2: SAME-TAB REDIRECT GUARD

### Problem

Some websites do not open a new tab. Instead, they replace the current page with an advertising website.

Example:

Original page:
example.com/article

After clicking:

advertising-site.com

The original page has been replaced.

### Expected behaviour

1. Monitor webpage navigation.
2. Identify suspicious redirect destinations.
3. Remember the previous safe URL.
4. Compare the destination against known unwanted-domain rules.
5. Block known unwanted destinations using Declarative Net Request rules where possible.
6. If the redirect has already completed, offer a recovery option.
7. Allow users to return to the previous safe URL.

### Important restrictions

Do not assume that every cross-domain redirect is an advertisement.

Legitimate redirects include:

- Login authentication.
- Payment gateways.
- OAuth authentication.
- External articles.
- Download services.
- Legitimate website redirects.

Never automatically send the user backwards simply because the domain changed.

Use appropriate Chrome APIs and explain the limitations of navigation events and request blocking.

---

# 4. LAYER 3: ELEMENT-LEVEL ADVERTISEMENT BLOCKER

This is a very important feature.

Not every advertisement opens a new tab or redirects the browser.

Some advertisements are displayed directly inside the webpage.

Examples:

- Floating advertisement banners.
- Sticky advertisements.
- Advertisement overlays.
- Full-screen advertising boxes.
- Advertisement containers covering website buttons.
- Embedded advertising iframes.
- Dynamically inserted advertisements.
- Promotional elements identified by known advertising selectors.

### Example

A webpage contains:

<div class="advertisement-popup">
    Special Offer!
    <button>Buy Now</button>
</div>

Our extension identifies the unwanted advertisement element and hides it while preserving the rest of the webpage.

### Technical implementation

Build a separate element-detection and blocking engine.

Use:

1. CSS selectors.
2. DOM inspection.
3. MutationObserver.
4. Known advertisement iframe sources.
5. Known advertising element patterns.
6. Configurable local selector rules.

### Dynamic advertisements

Some websites load their main content first and inject advertisements after several seconds.

A normal page-load inspection will miss these.

Use MutationObserver to detect newly added DOM elements.

The observer should:

- Monitor relevant DOM changes.
- Inspect newly inserted elements.
- Identify potential advertising elements.
- Avoid repeatedly processing the same element.
- Avoid infinite observer loops.
- Avoid unnecessary performance overhead.
- Disconnect or clean up when appropriate.

### Detection confidence

Implement three confidence levels.

HIGH CONFIDENCE:
- Known advertisement selectors.
- Known advertisement iframe sources.
- Explicit advertising identifiers.
- Strong matches against local rules.

Action: Automatically hide the confirmed advertisement.

MEDIUM CONFIDENCE:
- Suspicious floating containers.
- Promotional identifiers.
- Suspicious dynamically injected elements.

Action: Apply configurable handling, with conservative defaults.

LOW CONFIDENCE:
- Unknown popup containers.
- Elements that merely look promotional.

Action: Do not automatically hide them.

### False-positive protection

Never blindly hide:

- Login dialogs.
- Cookie consent interfaces.
- Payment interfaces.
- Video players.
- Navigation menus.
- Legitimate modal dialogs.
- Download interfaces.
- Important notifications.
- Application controls.

### Hide versus remove

Prefer hiding elements instead of permanently removing them.

For example:

element.style.display = "none";

Keep the ability to restore incorrectly hidden elements.

Use element.remove() only when there is a strong technical reason and restoration remains possible.

### Cross-origin iframe limitations

Do not assume that content scripts can inspect the internal DOM of cross-origin iframes.

Explain these limitations and use supported browser APIs and URL-based filtering where appropriate.

### Required files

Create:

- content/content.js
- content/element-detector.js
- content/element-blocker.js
- content/mutation-observer.js
- rules/element-selectors.json

---

# 5. COMPLETE TECHNICAL STACK

Use:

- Chrome Extension Manifest V3.
- Vanilla JavaScript.
- HTML5.
- CSS3.
- Chrome Tabs API.
- Chrome WebNavigation API.
- Chrome Storage API.
- Chrome Declarative Net Request API.
- Chrome Scripting API where necessary.
- MutationObserver.

Do not use:

- React.
- Node.js backend.
- External database server.
- Paid APIs.
- External AI APIs.
- Subscription services.
- Unnecessary third-party dependencies.

The extension must operate locally inside Chrome.

Use actual supported Chrome APIs. Verify the API names, permissions, event availability and Manifest V3 restrictions.

---

# 6. COMPLETE PROJECT ARCHITECTURE

Create the following project structure:

Smart-Redirect-Guard/

    manifest.json

    background/
        service-worker.js
        tab-monitor.js
        navigation-monitor.js
        detection-engine.js
        action-manager.js

    content/
        content.js
        element-detector.js
        element-blocker.js
        mutation-observer.js

    rules/
        rules.json
        trusted-sites.json
        element-selectors.json

    storage/
        storage-manager.js

    popup/
        popup.html
        popup.css
        popup.js

    dashboard/
        dashboard.html
        dashboard.css
        dashboard.js

    icons/
        icon16.png
        icon48.png
        icon128.png

    tests/
        test-plan.md
        test-rules.js

    README.md

You may add supporting files if necessary.

### Component responsibilities

**service-worker.js**

Coordinates the extension's background activities.

**tab-monitor.js**

Detects newly created tabs and tab updates.

**navigation-monitor.js**

Monitors navigation events and redirect chains.

**detection-engine.js**

Classifies destinations and suspicious behaviour.

**action-manager.js**

Performs appropriate actions: allow, block, close or recover.

**content.js**

Coordinates webpage-level advertisement detection.

**element-detector.js**

Identifies advertising elements.

**element-blocker.js**

Hides and restores confirmed advertising elements.

**mutation-observer.js**

Monitors dynamically inserted webpage elements.

**storage-manager.js**

Manages local settings, trusted sites and statistics.

---

# 7. INTELLIGENT DETECTION ENGINE

Build a central detection engine shared by the protection systems where appropriate.

It should evaluate:

- Destination domain.
- URL patterns.
- Known advertising rules.
- Suspicious navigation behaviour.
- Tab opener information.
- Original tab relationship.
- Trusted website exceptions.
- Element-level advertising selectors.

Implement the following classification:

HIGH CONFIDENCE:
Confirmed advertising destination or strong advertising match.

MEDIUM CONFIDENCE:
Suspicious redirect or advertising behaviour.

LOW CONFIDENCE:
Unknown or insufficient evidence.

Actions:

- HIGH: Apply the relevant protective action.
- MEDIUM: Warn or request user confirmation.
- LOW: Allow normal browsing.

Use separate decision policies for tabs, navigation and webpage elements.

Never assume that an unfamiliar domain is malicious.

---

# 8. TRUSTED WEBSITE MANAGEMENT

Users must be able to manage trusted websites.

Implement:

- Add trusted website.
- Remove trusted website.
- View trusted websites.
- Temporarily disable protection for a website.
- Restore normal protection.

Trusted exceptions must not silently disable every protection layer.

Clearly explain what is exempted.

---

# 9. USER INTERFACE AND DASHBOARD

Create a professional, modern, lightweight interface.

The extension popup must include:

### Main dashboard

- Protection ON/OFF switch.
- New-tab protection ON/OFF.
- Redirect protection ON/OFF.
- Element blocking ON/OFF.
- Total unwanted tabs closed.
- Total suspicious redirects detected.
- Total advertising elements hidden.
- Current protection status.

### Recent activity

Display:

- Website domain.
- Detection type.
- Action performed.
- Date and time.
- Confidence level.

### Settings

Allow users to:

- Configure the tab-closing delay.
- Enable or disable individual protection layers.
- Manage trusted websites.
- Enable or disable floating-ad detection.
- Enable or disable overlay detection.
- View and restore hidden elements where technically possible.
- Clear local history.

### Design requirements

Use a clean, modern browser-extension design.

The interface should be:

- Simple.
- Responsive.
- Easy to understand.
- Visually consistent.
- Suitable for beginners.

Do not overload the popup with unnecessary information.

---

# 10. LOCAL STORAGE AND PRIVACY

The extension must work without a backend.

Use chrome.storage.local for:

- Protection settings.
- Trusted websites.
- Custom filter rules.
- Statistics.
- Recent activity.
- Previous safe URLs where appropriate.

Privacy requirements:

- Do not send browsing history to external servers.
- Do not use analytics services.
- Do not collect personal information.
- Do not transmit browsing data.
- Do not add unnecessary external requests.
- Request minimum permissions.
- Explain every permission in README.md.

Ensure sensitive navigation information is not retained unnecessarily.

---

# 11. FILTER RULE MANAGEMENT

Create a modular local rule-management system.

It must support:

1. Known advertising domains.
2. Suspicious redirect domains.
3. Advertising URL patterns.
4. Advertising element selectors.
5. Trusted websites.
6. Custom user rules.

Use example rules for testing.

Clearly mark example rules as illustrative rather than verified malicious domains.

Do not download untrusted filter lists automatically.

Design the architecture so future filter-list updates can be added safely.

---

# 12. PERFORMANCE AND RELIABILITY

The extension must not noticeably slow down browsing.

Requirements:

- Avoid unnecessary DOM scans.
- Use efficient MutationObserver handling.
- Batch DOM processing.
- Avoid duplicate event processing.
- Avoid memory leaks.
- Avoid excessive local storage writes.
- Handle service-worker restarts.
- Persist essential state.
- Handle missing or invalid URLs.
- Handle tabs that close unexpectedly.
- Handle browser restarts.
- Avoid infinite observer loops.

Fail safely.

If the extension is uncertain, preserve legitimate website functionality.

---

# 13. ERROR HANDLING

Handle:

- Missing tab IDs.
- Invalid URLs.
- Empty URLs.
- Chrome API failures.
- Service-worker termination.
- Duplicate navigation events.
- Closed original tabs.
- Browser restarts.
- Unknown redirect destinations.
- Cross-origin iframe restrictions.
- Websites that dynamically change their DOM.
- Elements that are incorrectly identified.

Never let an error cause the extension to close legitimate tabs unnecessarily.

---

# 14. TESTING REQUIREMENTS

Create a local mock website for testing.

Do not depend on real advertising websites to verify basic functionality.

Test the following scenarios:

TEST 1 — Normal website navigation.

Expected: Website works normally.

TEST 2 — Known advertising popup opens in a new tab.

Expected: Confirmed unwanted tab closes and original tab remains open.

TEST 3 — Legitimate external link opens.

Expected: New tab remains open.

TEST 4 — Login redirect occurs.

Expected: Authentication works.

TEST 5 — Suspicious same-tab redirect occurs.

Expected: Detection and recovery mechanism works.

TEST 6 — Unknown domain opens.

Expected: It is not automatically closed without sufficient evidence.

TEST 7 — Floating advertising banner appears.

Expected: Confirmed advertising element is hidden.

TEST 8 — Advertisement is injected after three seconds.

Expected: MutationObserver detects and processes it.

TEST 9 — Legitimate modal dialog appears.

Expected: Dialog remains visible.

TEST 10 — Cookie consent dialog appears.

Expected: Dialog remains functional.

TEST 11 — User restores a hidden element.

Expected: Element is restored where possible.

TEST 12 — Service worker restarts.

Expected: Essential functionality continues.

TEST 13 — Protection is disabled.

Expected: Protective actions stop.

TEST 14 — Trusted website opens an external link.

Expected: Legitimate navigation is preserved.

TEST 15 — Cross-origin iframe advertisement.

Expected: The extension uses supported URL-level detection where possible and respects cross-origin restrictions.

Provide a test report showing:

- Test case.
- Expected result.
- Actual result.
- Pass/fail.
- Any known limitation.

---

# 15. MANIFEST V3 REQUIREMENTS

This is particularly important.

Use Manifest V3 correctly.

Do not use deprecated Manifest V2 APIs.

Verify:

- manifest_version.
- background.service_worker.
- permissions.
- host_permissions.
- content_scripts.
- web_accessible_resources.
- declarative_net_request.
- storage permissions.

Request only permissions genuinely needed by the implementation.

Explain why each permission is required.

Remember:

Chrome WebNavigation events, tab events and Declarative Net Request rules have different capabilities.

Do not claim that chrome.tabs.onUpdated or webNavigation events can always cancel navigation after the fact.

Use the appropriate supported API for blocking requests.

---

# 16. DEVELOPMENT PHASES

Build the project in the following order.

### PHASE 1 — Architecture

Explain:

- Overall architecture.
- Component responsibilities.
- Data flow.
- Chrome APIs.
- Permission requirements.
- Technical limitations.

### PHASE 2 — Core protection

Implement:

- Tab monitor.
- Navigation monitor.
- Detection engine.
- Action manager.
- New-tab protection.
- Same-tab recovery.

### PHASE 3 — Element protection

Implement:

- Content scripts.
- Element detector.
- Element blocker.
- MutationObserver.
- Local selector rules.
- Restore functionality.

### PHASE 4 — Storage

Implement:

- Settings storage.
- Trusted website storage.
- Detection statistics.
- Activity history.

### PHASE 5 — Interface

Build:

- Popup.
- Main dashboard.
- Settings.
- Trusted websites management.
- Recent activity.

### PHASE 6 — Testing

Create mock websites.

Run available tests.

Inspect the code.

Fix discovered errors.

Do not claim a test passed unless it was actually executed.

### PHASE 7 — Documentation

Provide:

- Installation instructions.
- Chrome Developer Mode instructions.
- Testing instructions.
- Permission explanations.
- Project structure explanation.
- Known limitations.

---

# 17. IMPORTANT DEVELOPMENT RULES

1. Do not provide incomplete pseudocode for essential functionality.
2. Do not leave critical features as TODO comments.
3. Do not invent Chrome APIs.
4. Do not use unsupported Manifest V3 functionality.
5. Do not break legitimate website functionality.
6. Do not close every newly opened tab.
7. Do not hide every element that looks like an advertisement.
8. Do not blindly reverse every cross-domain redirect.
9. Do not use arbitrary timeouts as a substitute for detection.
10. Do not circumvent website access controls or anti-adblock protections.
11. Keep all three protection layers independent.
12. Allow each layer to be individually enabled or disabled.
13. Write modular, readable and maintainable code.
14. Explain difficult technical decisions in simple language.
15. Prioritize reliability and low false-positive rates over aggressive blocking.

---

# 18. FINAL DELIVERABLES

I expect:

1. A complete working Chrome extension project.
2. All source files.
3. A valid Manifest V3 configuration.
4. A professional popup interface.
5. A settings dashboard.
6. Local detection rules.
7. Local storage implementation.
8. A working test environment.
9. A testing report.
10. README.md.
11. Installation instructions.
12. Known limitations and future improvements.

If you have access to a file-generation environment, create the actual project files and package the project into a ZIP archive.

If you cannot create files directly, provide each file with its complete contents and exact file path.

Do not pretend that untested functionality has been verified.

---

# 19. TEACH ME HOW THE SOFTWARE WORKS

I am learning software architecture, so explain the complete lifecycle in simple technical language.

Use a real example:

A user visits example.com and clicks a button that opens an advertising tab.

Explain:

1. What happens inside Chrome?
2. Which Chrome API detects the new tab?
3. Which JavaScript file receives the event?
4. How does the extension identify the original tab?
5. How does the detection engine evaluate the destination?
6. How does the action manager close the unwanted tab?
7. How does the original tab remain available?

Then explain the same lifecycle for:

- Same-tab redirects.
- Floating advertisements.
- Dynamically injected advertisements.
- Advertising overlays.

Use simple diagrams and step-by-step explanations.

---

# 20. START NOW

Start with PHASE 1.

First provide the architecture and explain the complete workflow.

Then proceed with implementation phase by phase.

Do not skip the architecture.

Do not sacrifice working functionality for a quick code dump.

The final goal is a reliable, privacy-focused, locally running Chrome extension that combines:

NEW-TAB AD BLOCKING
+
SAME-TAB REDIRECT PROTECTION
+
ELEMENT-LEVEL AD BLOCKING

All three must work together as one product while remaining independently configurable.

My final technical recommendation
One important architectural decision: keep the three engines independent but coordinated by one central detection system.

This gives us flexibility:
- If element blocking creates a problem, disable only element blocking.
- If a website needs external tabs, disable only tab protection.
- Keep same-tab redirect protection running independently.
Also, remember that no extension can guarantee removal of every advertisement. Some ads are served from the same domains as legitimate content, and some website elements are inaccessible because of cross-origin browser restrictions.

Start by giving Claude this entire prompt and ask it to complete the project phase by phase.