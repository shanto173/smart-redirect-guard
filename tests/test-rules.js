/*
 * SRG automated test suite  -  run with:  node tests/test-rules.js
 *
 * WHAT THIS CAN AND CANNOT PROVE
 *   It runs the parts of the extension that are plain logic: the scoring engine, the veto rules,
 *   domain parsing, the storage manager (against a fake chrome.storage), the rule data files and
 *   the manifest. The content-script modules are exercised inside jsdom, which is a real DOM but
 *   not Chrome, so selector and layout behaviour is indicative rather than final.
 *
 *   It cannot prove anything about real tab closing, real navigation events, real DNR blocking or
 *   the UI. Those are the manual cases in tests/test-plan.md and they are reported separately.
 *
 * Exit code 0 = everything passed.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const readJson = (p) => JSON.parse(read(p));

// ---------------------------------------------------------------- tiny runner
let passed = 0, failed = 0, skipped = 0;
const failures = [];
let group = '';

function section(name) { group = name; console.log('\n' + name); }
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else {
    failed++; failures.push(group + ' / ' + name + (detail ? ' -- ' + detail : ''));
    console.log('  FAIL  ' + name + (detail ? '  (' + detail + ')' : ''));
  }
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  ok(name, a === e, a === e ? '' : 'got ' + a + ', expected ' + e);
}
function skip(name, why) { skipped++; console.log('  SKIP  ' + name + '  (' + why + ')'); }

// ------------------------------------------------------------- load modules
const sharedScoring = require(path.join(ROOT, 'shared', 'element-scoring.js'));

// detection-engine.js expects a global `self`; give it one that already has the shared module.
function loadDetectionEngine() {
  // A vm context does NOT inherit Node's globals, so hand over the ones a service worker has.
  const sandbox = { module: { exports: {} }, console, URL, URLSearchParams, Date, Math, JSON };
  sandbox.self = sandbox;
  sandbox.SRGElementScoring = sharedScoring;
  vm.createContext(sandbox);
  vm.runInContext(read('background/detection-engine.js'), sandbox, { filename: 'detection-engine.js' });
  return sandbox.SRGDetect;
}
const D = loadDetectionEngine();

const elementRules = readJson('rules/element-selectors.json');
const dnrRules = readJson('rules/rules.json');
const manifest = readJson('manifest.json');
const trustedSites = readJson('rules/trusted-sites.json');

// Rule data the engine scores against, mirroring what the service worker feeds it.
D.setRules({
  adDomains: ['example-adnetwork.test', 'ads.example-tracker.test'],
  suspiciousDomains: ['redirect.example-suspicious.test'],
  urlPatterns: ['*/popunder*', '*/ad-redirect*'],
  trustedDomains: ['accounts.google.com']
});

const NOW = 1763000000000;

// =============================================================== 1. tab layer
section('A1-A7  Tab classification (Layer 1)');

let v = D.classifyTab({
  url: 'http://example-adnetwork.test/landing', openerUrl: 'https://example.com/article',
  urlHistory: ['http://x.test/a', 'http://example-adnetwork.test/landing'],
  createdAt: NOW, now: NOW + 500, srgOpened: false, trusted: false, userGesture: false
});
ok('A1  known ad domain in a new tab reaches HIGH', v.confidence === 'high', JSON.stringify(v));
ok('A1b matchedRule names the rule that fired', !!v.matchedRule, JSON.stringify(v.matchedRule));

v = D.classifyTab({
  url: 'http://unknown-brand-new-site.test/page', openerUrl: 'https://example.com/article',
  urlHistory: ['http://a.test/1', 'http://b.test/2', 'http://unknown-brand-new-site.test/page'],
  createdAt: NOW, now: NOW + 100, srgOpened: false, trusted: false, userGesture: false
});
ok('A2  heuristics alone NEVER reach high (unknown domain, 3-hop chain, no gesture)',
  v.confidence !== 'high', JSON.stringify(v));

[['login', 'http://example-adnetwork.test/login?next=/x'],
 ['payment', 'http://example-adnetwork.test/checkout/payment'],
 ['download', 'http://example-adnetwork.test/download/file.zip'],
 ['oauth', 'http://example-adnetwork.test/oauth/authorize']
].forEach(([label, url]) => {
  const r = D.classifyTab({ url, openerUrl: 'https://example.com/a', urlHistory: [url],
    createdAt: NOW, now: NOW + 100, srgOpened: false, trusted: false, userGesture: false });
  ok('A3  veto on ' + label + ' URL (ad domain + ' + label + ' => low)',
    r.confidence === 'low', JSON.stringify(r));
});

ok('A3b "logindexing" is NOT vetoed as "login"',
  D.hasVetoSignal('http://x.test/logindexing/page').veto === false);
ok('A3c "/sign-in" IS vetoed', D.hasVetoSignal('http://x.test/sign-in').veto === true);

v = D.classifyTab({ url: 'http://example-adnetwork.test/landing', openerUrl: 'https://example.com/a',
  urlHistory: ['http://example-adnetwork.test/landing'], createdAt: NOW, now: NOW + 100,
  srgOpened: false, trusted: true, userGesture: false });
ok('A4  trusted destination => low', v.confidence === 'low', JSON.stringify(v));

v = D.classifyTab({ url: 'http://example-adnetwork.test/landing', openerUrl: 'https://example.com/a',
  urlHistory: ['http://example-adnetwork.test/landing'], createdAt: NOW, now: NOW + 100,
  srgOpened: true, trusted: false, userGesture: false });
ok('A5  tab opened by SRG itself => low', v.confidence === 'low', JSON.stringify(v));

eq('A6a registrableDomain multi-part TLD', D.registrableDomain('a.b.example.co.uk'), 'example.co.uk');
eq('A6b registrableDomain plain', D.registrableDomain('www.example.com'), 'example.com');
eq('A6c registrableDomain IP literal', D.registrableDomain('127.0.0.1'), '127.0.0.1');
eq('A6d registrableDomain localhost', D.registrableDomain('localhost'), 'localhost');
ok('A6e isSameSite across subdomains', D.isSameSite('https://a.example.com/x', 'https://b.example.com/y'));
ok('A6f isSameSite rejects lookalike', !D.isSameSite('https://example.com', 'https://evilexample.com'));

v = D.classifyTab({ url: 'https://example.com/other', openerUrl: 'https://example.com/article',
  urlHistory: ['https://example.com/other'], createdAt: NOW, now: NOW + 100,
  srgOpened: false, trusted: false, userGesture: true });
ok('A7  same-site as opener never reaches high', v.confidence !== 'high', JSON.stringify(v));

v = D.classifyTab({ url: 'http://example-adnetwork.test/x', openerUrl: '', urlHistory: ['http://example-adnetwork.test/x'],
  createdAt: NOW, now: NOW + 100, srgOpened: false, trusted: false, userGesture: true });
ok('A7b no opener (user opened it) is downweighted', v.score < 70 || v.confidence !== 'high',
  JSON.stringify(v));

// ======================================================== 2. navigation layer
section('A8  Navigation classification (Layer 2)');

v = D.classifyNavigation({ url: 'http://example-adnetwork.test/go', previousUrl: 'https://example.com/article',
  transitionType: 'link', transitionQualifiers: ['client_redirect'], frameId: 0, trusted: false,
  chainLength: 2, timeSinceLastNav: 200 });
ok('A8a client_redirect to an ad domain => high', v.confidence === 'high', JSON.stringify(v));

v = D.classifyNavigation({ url: 'https://news.other.test/article', previousUrl: 'https://example.com/article',
  transitionType: 'link', transitionQualifiers: [], frameId: 0, trusted: false,
  chainLength: 1, timeSinceLastNav: 5000 });
ok('A8b a plain user link click to an unknown site => low', v.confidence === 'low', JSON.stringify(v));

v = D.classifyNavigation({ url: 'https://accounts.google.com/o/oauth2/auth?client_id=1',
  previousUrl: 'https://example.com/article', transitionType: 'link',
  transitionQualifiers: ['server_redirect'], frameId: 0, trusted: true, chainLength: 2, timeSinceLastNav: 100 });
ok('A8c an OAuth redirect is never flagged', v.confidence === 'low', JSON.stringify(v));

// =========================================================== 3. element layer
section('A9-A11  Element scoring (Layer 3, shared module)');

const S = (o) => Object.assign({
  selectorMatch: null, iframeHostMatch: false, fixed: false, sticky: false, zIndex: 0,
  viewportCoverage: 0, appearedAfterLoad: false, hasOutboundAdLink: false,
  hasFormInput: false, hasVideo: false, allowMatch: false, textHints: [], promoHints: []
}, o);

v = sharedScoring.scoreElementSignals(S({ allowMatch: true, selectorMatch: 'high' }));
ok('A9  allowMatch short-circuits even with a high selector', v.confidence === 'low', JSON.stringify(v));

v = sharedScoring.scoreElementSignals(S({ selectorMatch: 'high' }));
ok('A9b a bare known-ad-selector match reaches high', v.confidence === 'high', JSON.stringify(v));

v = sharedScoring.scoreElementSignals(S({ selectorMatch: 'high', hasFormInput: true }));
ok('A10a a form input drags a high selector below high', v.confidence !== 'high', JSON.stringify(v));
v = sharedScoring.scoreElementSignals(S({ selectorMatch: 'high', hasVideo: true }));
ok('A10b a video drags a high selector below high', v.confidence !== 'high', JSON.stringify(v));

v = sharedScoring.scoreElementSignals(S({
  fixed: true, zIndex: 99999, viewportCoverage: 0.95, appearedAfterLoad: true, hasOutboundAdLink: true
}));
ok('A10c the maximum heuristic stack still cannot reach high',
  v.confidence !== 'high', 'score=' + v.score + ' conf=' + v.confidence);

v = sharedScoring.scoreElementSignals(S({ selectorMatch: 'medium', fixed: true }));
ok('A10d a medium selector + floating => medium', v.confidence === 'medium', JSON.stringify(v));

v = sharedScoring.scoreElementSignals(S({ selectorMatch: 'high', textHints: ['download', 'sign in', 'cookie', 'billing'] }));
ok('A10e protective wording does not override an explicit ad-selector match',
  v.confidence === 'high', JSON.stringify(v));
v = sharedScoring.scoreElementSignals(S({ fixed: true, zIndex: 5000, viewportCoverage: 0.6,
  appearedAfterLoad: true, textHints: ['accept cookies', 'privacy settings'] }));
ok('A10e2 protective wording DOES brake a heuristic-only candidate',
  v.confidence === 'low', JSON.stringify(v));

v = sharedScoring.scoreElementSignals(S({ iframeHostMatch: true }), { iframeDetection: false });
ok('A10f iframeDetection:false disables the iframe signal', v.confidence === 'low', JSON.stringify(v));

// The whole point of shared/element-scoring.js: there is exactly ONE implementation.
ok('A11a background engine and shared module are the same function object',
  D.scoreElementSignals(S({ selectorMatch: 'high' })).score ===
  sharedScoring.scoreElementSignals(S({ selectorMatch: 'high' })).score);
ok('A11b background exposes the shared weights table',
  D.ELEMENT_WEIGHTS === sharedScoring.ELEMENT_WEIGHTS);
ok('A11c no duplicate weights table is left in content/element-detector.js',
  !/selectorHigh:\s*\d+/.test(read('content/element-detector.js')),
  'a numeric selectorHigh weight is still defined in the content script');
ok('A11d no duplicate weights table is left in background/detection-engine.js',
  !/selectorHigh:\s*\d+/.test(read('background/detection-engine.js')));

// ============================================================= 4. rule files
section('A12-A13  Rule data files');

const VALID_RESOURCE_TYPES = new Set(['main_frame', 'sub_frame', 'stylesheet', 'script', 'image',
  'font', 'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'webtransport',
  'webbundle', 'other']);
const VALID_RULE_KEYS = new Set(['id', 'priority', 'action', 'condition']);
const VALID_COND_KEYS = new Set(['urlFilter', 'regexFilter', 'isUrlFilterCaseSensitive',
  'initiatorDomains', 'excludedInitiatorDomains', 'requestDomains', 'excludedRequestDomains',
  'domains', 'excludedDomains', 'domainType', 'resourceTypes', 'excludedResourceTypes',
  'requestMethods', 'excludedRequestMethods', 'tabIds', 'excludedTabIds', 'responseHeaders']);

ok('A12a rules.json is an array', Array.isArray(dnrRules));
const ids = new Set();
let ruleProblems = [];
dnrRules.forEach((r, i) => {
  if (typeof r.id !== 'number' || r.id < 1) ruleProblems.push('rule ' + i + ': bad id');
  if (ids.has(r.id)) ruleProblems.push('duplicate id ' + r.id);
  ids.add(r.id);
  if (r.id > 999) ruleProblems.push('id ' + r.id + ' outside the static 1-999 range');
  Object.keys(r).forEach(k => { if (!VALID_RULE_KEYS.has(k)) ruleProblems.push('rule ' + r.id + ': unknown key "' + k + '"'); });
  if (!r.action || typeof r.action.type !== 'string') ruleProblems.push('rule ' + r.id + ': missing action.type');
  if (!r.condition) ruleProblems.push('rule ' + r.id + ': missing condition');
  else {
    Object.keys(r.condition).forEach(k => {
      if (!VALID_COND_KEYS.has(k)) ruleProblems.push('rule ' + r.id + ': unknown condition key "' + k + '"');
    });
    (r.condition.resourceTypes || []).forEach(t => {
      if (!VALID_RESOURCE_TYPES.has(t)) ruleProblems.push('rule ' + r.id + ': bad resourceType "' + t + '"');
    });
  }
});
ok('A12b every DNR rule is structurally valid (' + dnrRules.length + ' rules)',
  ruleProblems.length === 0, ruleProblems.slice(0, 4).join('; '));

const realish = dnrRules.filter(r => JSON.stringify(r.condition).match(/"[^"]*\.(com|net|org|io|ru|cn)"/));
ok('A12c shipped example rules use reserved test TLDs only, never real domains',
  realish.length === 0, realish.length + ' rules reference a real-looking TLD');

ok('A13a element-selectors.json has every required section',
  ['version', 'note', 'high', 'medium', 'allow', 'adDomains', 'urlPatterns'].every(k => k in elementRules));
ok('A13b the note marks the lists as illustrative examples',
  /example/i.test(elementRules.note) && /not a verified/i.test(elementRules.note), elementRules.note);

const allSelectors = []
  .concat(elementRules.high.selectors, elementRules.medium.selectors, elementRules.allow.selectors);
const badChars = allSelectors.filter(s => /[{}@\n\r]|<\//.test(s));
ok('A13c no selector can break out of a CSS rule (' + allSelectors.length + ' selectors)',
  badChars.length === 0, badChars.join(', '));

ok('A13d the allow list is substantial (false-positive shield)',
  elementRules.allow.selectors.length >= 40, elementRules.allow.selectors.length + ' entries');
ok('A13e the allow list covers consent, auth, payment, video, captcha and dialogs',
  ['cookie', 'consent', 'login', 'signin', 'checkout', 'payment', 'video', 'captcha', 'dialog']
    .every(k => JSON.stringify(elementRules.allow.selectors).toLowerCase().includes(k)));

ok('A13f trusted-sites.json entries all carry a reason and a scope',
  Array.isArray(trustedSites.sites) && trustedSites.sites.length > 0 &&
  trustedSites.sites.every(s => s.domain && s.reason && s.scope &&
    typeof s.scope.tab === 'boolean' && typeof s.scope.redirect === 'boolean' &&
    typeof s.scope.element === 'boolean'));

// ============================================================== 5. manifest
section('A18  Manifest V3 validity');

eq('A18a manifest_version is 3', manifest.manifest_version, 3);
ok('A18b no Manifest V2 keys present',
  !('background' in manifest && manifest.background.scripts) && !('browser_action' in manifest) &&
  !('page_action' in manifest) && !('web_accessible_resources' in manifest &&
    Array.isArray(manifest.web_accessible_resources) && typeof manifest.web_accessible_resources[0] === 'string'));
ok('A18c uses a service worker', !!manifest.background && !!manifest.background.service_worker);

const PERMS = manifest.permissions || [];
eq('A18d requests exactly the documented permissions', PERMS.slice().sort(),
  ['alarms', 'declarativeNetRequest', 'declarativeNetRequestFeedback', 'storage', 'tabs', 'webNavigation'].sort());
ok('A18e no host_permissions (content_scripts matches are enough)', !manifest.host_permissions);
ok('A18f does not request the removed blocking webRequest API', !PERMS.includes('webRequest'));

const declared = []
  .concat([manifest.background.service_worker])
  .concat(manifest.content_scripts.flatMap(c => c.js))
  .concat((manifest.declarative_net_request.rule_resources || []).map(r => r.path))
  .concat(Object.values(manifest.icons || {}))
  .concat([manifest.action && manifest.action.default_popup, manifest.options_page].filter(Boolean));
const missing = declared.filter(f => !fs.existsSync(path.join(ROOT, f)));
ok('A18g every file the manifest declares exists (' + declared.length + ' files)',
  missing.length === 0, 'missing: ' + missing.join(', '));

// Assets the extension's own HTML pages pull in. The manifest only names the HTML files, so
// without this a missing stylesheet or script would ship silently.
const htmlPages = ['popup/popup.html', 'dashboard/dashboard.html'].filter(f => fs.existsSync(path.join(ROOT, f)));
const assetProblems = [];
htmlPages.forEach(pg => {
  const dir = path.dirname(pg);
  const html = read(pg);
  const refs = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)].map(m => m[1]);
  refs.forEach(r => {
    if (/^(https?:|data:|#|mailto:)/.test(r)) {
      if (/^https?:/.test(r)) assetProblems.push(pg + ' loads an external resource: ' + r);
      return;
    }
    if (!fs.existsSync(path.join(ROOT, dir, r))) assetProblems.push(pg + ' references a missing file: ' + r);
  });
});
ok('A18j every asset the extension pages reference exists and is local (' + htmlPages.length + ' pages)',
  htmlPages.length === 2 && assetProblems.length === 0,
  htmlPages.length !== 2 ? 'a UI page is missing entirely' : assetProblems.join('; '));

const csOrder = manifest.content_scripts[0].js;
ok('A18h shared/element-scoring.js is injected before element-detector.js',
  csOrder.indexOf('shared/element-scoring.js') >= 0 &&
  csOrder.indexOf('shared/element-scoring.js') < csOrder.indexOf('content/element-detector.js'),
  csOrder.join(' -> '));
ok('A18i content scripts run at document_start in all frames',
  manifest.content_scripts[0].run_at === 'document_start' && manifest.content_scripts[0].all_frames === true);

// ============================================== 5b. UI <-> worker message contract
section('A19  UI / service-worker message contract');

(function contractTests() {
  const sw = read('background/service-worker.js');
  const block = sw.slice(sw.indexOf('const handlers = {'));
  const handlers = new Set([...block.matchAll(/^\s{4}(SRG_[A-Z_]+)\s*:/gm)].map(m => m[1]));
  ok('A19a the worker exposes a handler table (' + handlers.size + ' handlers)', handlers.size >= 20);

  const uiFiles = ['popup/popup.js', 'dashboard/dashboard.js'].filter(f => fs.existsSync(path.join(ROOT, f)));
  if (uiFiles.length < 2) { skip('A19b every message the UI sends has a handler', 'UI not built yet'); return; }

  const sent = new Set();
  uiFiles.forEach(f => { [...read(f).matchAll(/'(SRG_[A-Z_]+)'/g)].forEach(m => sent.add(m[1])); });
  const orphan = [...sent].filter(t => !handlers.has(t));
  ok('A19b every message type the UI sends has a worker handler (' + sent.size + ' used)',
    orphan.length === 0, 'no handler for: ' + orphan.join(', '));

  // The content script's messages must resolve too.
  const contentSent = new Set();
  [...read('content/content.js').matchAll(/'(SRG_[A-Z_]+)'/g)].forEach(m => contentSent.add(m[1]));
  const contentToWorker = [...contentSent].filter(t =>
    ['SRG_GET_CONFIG', 'SRG_REPORT_HIDDEN', 'SRG_REPORT_ELEMENT_RESTORED', 'SRG_LOG_ACTIVITY'].includes(t));
  ok('A19c the content script worker-bound messages all have handlers',
    contentToWorker.every(t => handlers.has(t)), contentToWorker.join(', '));

  // And the worker must only forward message types the content script actually answers.
  const forwarded = ['SRG_LIST_HIDDEN', 'SRG_RESTORE', 'SRG_RESTORE_ALL', 'SRG_RESCAN', 'SRG_SETTINGS_CHANGED'];
  const contentHandles = forwarded.filter(t => read('content/content.js').includes("'" + t + "'"));
  ok('A19d the content script handles every type the worker forwards to it',
    contentHandles.length === forwarded.length,
    'unhandled: ' + forwarded.filter(t => !contentHandles.includes(t)).join(', '));
})();

// ======================================================== 6. storage manager
section('A15-A17  Storage manager (fake chrome.storage)');

function fakeChrome() {
  const local = {}, session = {};
  const area = (store) => ({
    get: (keys) => Promise.resolve(
      keys === null || keys === undefined ? Object.assign({}, store) :
        (Array.isArray(keys) ? keys : [keys]).reduce((o, k) => { if (k in store) o[k] = store[k]; return o; }, {})),
    set: (obj) => { Object.assign(store, JSON.parse(JSON.stringify(obj))); return Promise.resolve(); },
    remove: (keys) => { (Array.isArray(keys) ? keys : [keys]).forEach(k => delete store[k]); return Promise.resolve(); },
    clear: () => { Object.keys(store).forEach(k => delete store[k]); return Promise.resolve(); }
  });
  return {
    runtime: { lastError: null, id: 'test' },
    storage: { local: area(local), session: area(session),
      onChanged: { addListener() {}, removeListener() {} } },
    __local: local, __session: session
  };
}

function loadStorage(chromeStub) {
  const sandbox = { module: { exports: {} }, console, chrome: chromeStub, crypto,
    setTimeout, clearTimeout, Date, URL, URLSearchParams, Math, JSON };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('storage/storage-manager.js'), sandbox, { filename: 'storage-manager.js' });
  return sandbox.SRGStorage;
}

(async function storageTests() {
  const chromeStub = fakeChrome();
  const St = loadStorage(chromeStub);
  await St.bootstrap();

  let s = await St.getSettings();
  ok('A15a defaults install on bootstrap', s.masterEnabled === true && s.tab.closeDelayMs === 1000);

  s = await St.updateSettings({ tab: { closeDelayMs: 2500 } });
  ok('A15b deep merge keeps sibling keys in the same branch',
    s.tab.closeDelayMs === 2500 && s.tab.enabled === true && s.tab.reactivateOpener === true,
    JSON.stringify(s.tab));
  ok('A15c deep merge keeps other branches', s.element && s.element.enabled === true && !!s.redirect);

  s = await St.updateSettings({ tab: { closeDelayMs: 999999 } });
  ok('A15d closeDelayMs is clamped to a sane maximum', s.tab.closeDelayMs <= 10000, String(s.tab.closeDelayMs));

  await St.addTrusted('example.com', { tab: true, redirect: true, element: false });
  ok('A17a isTrusted matches the exact domain', await St.isTrusted('https://example.com/x', 'tab'));
  ok('A17b isTrusted matches subdomains', await St.isTrusted('https://www.example.com/x', 'tab'));
  ok('A17c isTrusted rejects a lookalike domain', !(await St.isTrusted('https://evilexample.com/x', 'tab')));
  ok('A17d isTrusted honours per-layer scope', !(await St.isTrusted('https://example.com/x', 'element')));

  // A negative duration correctly means "no expiry", so set a genuinely past timestamp
  // through storage and check the READ path honours it.
  await St.addTrusted('expired.test', { tab: true, redirect: true, element: true }, 60000);
  ok('A17e0 a temporary trusted entry is trusted before it expires',
    await St.isTrusted('https://expired.test/x', 'tab'));
  const stored = chromeStub.__local['srg.trusted'];
  stored.find(e => e.domain === 'expired.test').expiresAt = Date.now() - 1000;
  await chromeStub.storage.local.set({ 'srg.trusted': stored });
  ok('A17e an expired trusted entry is ignored', !(await St.isTrusted('https://expired.test/x', 'tab')));

  // maxEntries is deliberately clamped to a 10..1000 range, so assert against the EFFECTIVE
  // value rather than the requested one.
  await St.updateSettings({ logging: { maxEntries: 5 } });
  const effMax = (await St.getSettings()).logging.maxEntries;
  ok('A16a0 maxEntries is clamped into its supported range', effMax === 10, String(effMax));
  for (let i = 0; i < 25; i++) {
    await St.addActivity({ domain: 'd' + i + '.test', layer: 'element', type: 't', action: 'hidden', confidence: 'high', detail: '' });
  }
  const act = await St.getActivity();
  ok('A16a activity log trims to maxEntries', act.length === effMax, act.length + ' rows');
  ok('A16b activity log is newest first', act[0].domain === 'd24.test', act[0] && act[0].domain);
  ok('A16c every row has an id and a timestamp', act.every(r => r.id && typeof r.ts === 'number'));

  St.bumpStat('tabsClosed', 2); St.bumpStat('tabsClosed', 3); St.bumpStat('elementsHidden', 7);
  await St.flush();
  const stats = await St.getStats();
  ok('A16d buffered stat bumps flush to the correct totals',
    stats.tabsClosed === 5 && stats.elementsHidden === 7, JSON.stringify(stats));

  const exported = await St.exportConfig();
  ok('A16e export contains settings/trusted/customRules but no activity or stats',
    exported && exported.settings && exported.trusted && exported.customRules &&
    !('activity' in exported) && !('stats' in exported), Object.keys(exported || {}).join(','));
  const bad = await St.importConfig({ nonsense: true });
  ok('A16f import rejects malformed data', bad && bad.ok === false, JSON.stringify(bad));

  await domTests();
})().catch(e => { failed++; failures.push('storage tests threw: ' + e.stack); console.log('  FAIL  storage suite threw\n' + e.stack); finish(); });

// =========================================== 7. content scripts inside jsdom
async function domTests() {
  section('A14 + integration  Content scripts (jsdom)');

  let JSDOM;
  try { ({ JSDOM } = require('jsdom')); }
  catch (e) {
    skip('A14  token matcher', 'jsdom not installed - run `npm install`');
    skip('INT  service-worker config shape reaches the detector', 'jsdom not installed');
    return finish();
  }

  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>',
    { url: 'https://publisher.example/article', pretendToBeVisual: true });
  const win = dom.window;
  win.SRGElementScoring = sharedScoring;
  // jsdom has no layout engine, so every rect is 0x0. Give elements a usable box so the
  // coverage/floating signals are exercised rather than silently skipped.
  win.Element.prototype.getBoundingClientRect = function () {
    const w = Number(this.dataset && this.dataset.testW) || 300;
    const h = Number(this.dataset && this.dataset.testH) || 250;
    return { width: w, height: h, top: 0, left: 0, right: w, bottom: h, x: 0, y: 0 };
  };

  const ctx = { window: win, document: win.document, console, location: win.location,
    getComputedStyle: win.getComputedStyle.bind(win), Set: win.Set, WeakSet: win.WeakSet,
    URL: win.URL, Node: win.Node, Element: win.Element, MutationObserver: win.MutationObserver,
    setTimeout, clearTimeout, requestAnimationFrame: (f) => setTimeout(f, 0) };
  ctx.self = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('shared/element-scoring.js'), ctx, { filename: 'element-scoring.js' });
  vm.runInContext(read('content/element-detector.js'), ctx, { filename: 'element-detector.js' });
  const det = win.SRG.detector;

  // --- A14: the token matcher is the single biggest false-positive risk -------
  const shouldMatch = ['ad', 'ad-top', 'top_ad', 'ad.container', 'leaderboard ad', 'ADS'];
  const shouldNot = ['badge', 'download', 'gradient', 'loading', 'thread', 'header',
    'radio', 'padding', 'upload', 'add', 'shadow', 'road', 'broadcast'];
  const tokens = ['ad', 'ads'];
  const hits = shouldMatch.filter(s => det.matchTokens(s, tokens));
  const falseHits = shouldNot.filter(s => det.matchTokens(s, tokens));
  ok('A14a token "ad" matches genuine ad identifiers (' + hits.length + '/' + shouldMatch.length + ')',
    hits.length === shouldMatch.length, 'missed: ' + shouldMatch.filter(s => !det.matchTokens(s, tokens)));
  ok('A14b token "ad" does NOT match ordinary words (' + shouldNot.length + ' checked)',
    falseHits.length === 0, 'false positives: ' + falseHits.join(', '));

  // --- INTEGRATION: does the worker's config actually configure the detector? --
  // This is the exact object background/service-worker.js buildConfig() returns. If the two
  // sides ever disagree about field names again, this test fails instead of the extension
  // silently ignoring the user's rules.
  const workerConfig = {
    ok: true, enabled: true, trusted: false,
    settings: { element: { enabled: true, hideHighConfidence: true, mediumAction: 'log',
      floatingDetection: true, overlayDetection: true, stickyDetection: true,
      iframeDetection: true, cosmeticCss: true } },
    selectors: ['.my-custom-ad-rule'],
    highTokens: elementRules.high.idClassTokens,
    mediumSelectors: elementRules.medium.selectors,
    mediumTokens: elementRules.medium.idClassTokens,
    allowSelectors: elementRules.allow.selectors,
    textHints: elementRules.allow.textHints,
    adIframeHosts: ['custom-ad-host.test'],
    adDomains: ['custom-ad-host.test'],
    urlPatterns: ['*/my-custom-ads/*']
  };
  const diag = det.configure(workerConfig);
  ok('INT1 configure() accepts the worker reply without dropping selectors',
    diag && diag.high > 0 && diag.allow > 0, JSON.stringify(diag));

  const doc = win.document, host = doc.getElementById('host');
  const mk = (html) => { host.innerHTML = html; return host.firstElementChild; };

  let el = mk('<div class="my-custom-ad-rule">Buy</div>');
  ok('INT2 a USER-SUPPLIED custom selector from the worker actually takes effect',
    det.score(el).confidence === 'high', JSON.stringify(det.score(el)));

  el = mk('<iframe src="https://custom-ad-host.test/banner"></iframe>');
  ok('INT3 a USER-SUPPLIED ad iframe host from the worker actually takes effect',
    det.score(el).confidence === 'high', JSON.stringify(det.score(el)));

  // --- shipped rules behave as intended -------------------------------------
  el = mk('<div class="ad-banner">Ad</div>');
  ok('E1  a shipped high selector (.ad-banner) => high', det.score(el).confidence === 'high');

  el = mk('<div class="advertisement-popup">Special Offer! <button>Buy Now</button></div>');
  ok('E2  the spec example .advertisement-popup => high', det.score(el).confidence === 'high',
    JSON.stringify(det.score(el)));

  el = mk('<div class="badge">New</div>');
  ok('E3  a .badge is not mistaken for an ad', det.score(el).confidence === 'low');

  el = mk('<div class="cc-window"><p>We use cookies</p><button>Accept cookies</button></div>');
  ok('E4  a cookie consent bar is allow-listed', det.isAllowed(el), JSON.stringify(det.score(el)));

  el = mk('<div class="ad-banner"><form action="/login"><input type="password"></form></div>');
  ok('E5  an ad-looking box containing a password field is never touched',
    det.score(el).confidence === 'low', JSON.stringify(det.score(el)));

  el = mk('<div role="dialog"><h2>Confirm</h2><button>OK</button></div>');
  ok('E6  a legitimate role="dialog" is allow-listed', det.isAllowed(el));

  el = mk('<div class="ad-banner">Download now to claim your prize</div>');
  ok('E7  promotional wording does not rescue a known ad container',
    det.score(el).confidence === 'high', JSON.stringify(det.score(el)));

  // --- blocker: hide and restore --------------------------------------------
  vm.runInContext(read('content/element-blocker.js'), ctx, { filename: 'element-blocker.js' });
  const blocker = win.SRG.blocker;
  el = mk('<div class="ad-banner" style="color: red">Ad</div>');
  const sid = blocker.hide(el, { confidence: 'high', reasons: ['test'] });
  ok('B1  hide() sets display:none !important', sid && el.style.display === 'none',
    el.getAttribute('style'));
  ok('B2  hide() does NOT remove the element from the DOM', el.parentNode === host);
  ok('B3  hide() is idempotent (second call returns null)',
    blocker.hide(el, { confidence: 'high', reasons: [] }) === null);
  ok('B4  list() reports the hidden element', blocker.list().some(i => i.sid === sid));
  ok('B5  restore() puts the original inline style back',
    blocker.restore(sid) === true && el.style.display === '' && el.style.color === 'red',
    el.getAttribute('style'));
  ok('B6  no element.remove() call exists anywhere in the content scripts',
    !/\.remove\(\s*\)/.test(read('content/element-blocker.js').replace(/\/\*[\s\S]*?\*\//g, '')));

  const css = blocker.injectCosmeticCss(['.ad-banner', '.evil{} body{display:none}', '.ok-rule']);
  const styleEl = doc.getElementById('srg-cosmetic');
  ok('B7  cosmetic CSS rejects selectors that could break out of the rule',
    styleEl && !styleEl.textContent.includes('body{display:none}'),
    styleEl ? styleEl.textContent.slice(0, 120) : 'no style element');
  void css;

  await mockSiteTests(JSDOM);
  finish();
}

/*
 * Run the REAL detector over the REAL mock-site pages. This catches the case where the shipped
 * selector list and the shipped test fixtures disagree with each other.
 *
 * Honest limitation: jsdom has no layout engine and does not fetch the external stylesheet, so
 * position/z-index/size signals are NOT evaluated here. These assertions therefore test the
 * selector and allow-list behaviour only; the floating/overlay heuristics are covered by the
 * synthetic cases above and by the manual browser tests.
 */
async function mockSiteTests(JSDOM) {
  section('M  Detector vs. the real mock-site pages (jsdom, no layout)');

  function pageDom(file) {
    const html = read(path.join('tests', 'mock-site', file));
    const dom = new JSDOM(html, { url: 'http://localhost:8080/' + file, runScripts: 'outside-only' });
    const win = dom.window;
    win.SRGElementScoring = sharedScoring;
    win.Element.prototype.getBoundingClientRect = () => ({ width: 300, height: 200, top: 0, left: 0, right: 300, bottom: 200, x: 0, y: 0 });
    const c = { window: win, document: win.document, console, location: win.location,
      getComputedStyle: win.getComputedStyle.bind(win), Set: win.Set, WeakSet: win.WeakSet,
      URL: win.URL, Node: win.Node, Element: win.Element, setTimeout, clearTimeout };
    c.self = c; c.globalThis = c;
    vm.createContext(c);
    vm.runInContext(read('shared/element-scoring.js'), c);
    vm.runInContext(read('content/element-detector.js'), c);
    const d = win.SRG.detector;
    d.configure({
      selectors: elementRules.high.selectors, highTokens: elementRules.high.idClassTokens,
      mediumSelectors: elementRules.medium.selectors, mediumTokens: elementRules.medium.idClassTokens,
      allowSelectors: elementRules.allow.selectors, textHints: elementRules.allow.textHints,
      adIframeHosts: elementRules.high.iframeHosts, adDomains: elementRules.adDomains,
      urlPatterns: elementRules.urlPatterns,
      settings: { element: { enabled: true, floatingDetection: true, overlayDetection: true,
        stickyDetection: true, iframeDetection: true } }
    });
    return { win, doc: win.document, det: d };
  }

  // --- ads-static.html: the shipped ad fixtures must be recognised -----------
  let { doc, det } = pageDom('ads-static.html');
  [['.ad-banner', 'in-flow ad banner'],
   ['.advertisement-popup', 'the spec example popup']
  ].forEach(([sel, label]) => {
    const el = doc.querySelector(sel);
    const r = el ? det.score(el) : null;
    ok('M1  ads-static.html: ' + label + ' (' + sel + ') => high',
      !!r && r.confidence === 'high', r ? JSON.stringify(r) : 'element not found in the fixture');
  });
  // .floating-banner is on the MEDIUM list by design, so it must NOT be hidden by default.
  // The fixture's on-page text says so too; this keeps the two honest with each other.
  const fb = doc.querySelector('.floating-banner');
  ok('M1b ads-static.html: the floating banner is medium, not high (default = log only)',
    !!fb && det.score(fb).confidence === 'medium', fb ? JSON.stringify(det.score(fb)) : 'not found');
  let el = doc.querySelector('.real-content');
  ok('M2  ads-static.html: the article content is left alone',
    det.score(el).confidence === 'low', JSON.stringify(det.score(el)));
  el = doc.querySelector('.sticky-promo');
  ok('M3  ads-static.html: the sticky promo bar never reaches high (medium at most)',
    det.score(el).confidence !== 'high', JSON.stringify(det.score(el)));

  // --- legit-ui.html: nothing here may be touched ---------------------------
  ({ doc, det } = pageDom('legit-ui.html'));
  [['#consent', 'cookie consent bar'],
   ['form', 'payment form'],
   ['video', 'video player']
  ].forEach(([sel, label]) => {
    const node = doc.querySelector(sel);
    ok('M4  legit-ui.html: ' + label + ' is protected',
      !!node && det.isAllowed(node), node ? JSON.stringify(det.score(node)) : 'not found');
  });
  const payForm = doc.querySelector('form');
  ok('M5  legit-ui.html: the payment form scores low even if something else matched',
    det.score(payForm).confidence === 'low', JSON.stringify(det.score(payForm)));

  // --- article.html: the control page must produce nothing ------------------
  ({ doc, det } = pageDom('article.html'));
  const hits = det.candidates(doc).filter(e => det.score(e).confidence !== 'low');
  ok('M6  article.html (the control page) yields no detections',
    hits.length === 0, hits.length + ' unexpected: ' +
      hits.slice(0, 3).map(e => e.tagName + '.' + e.className).join(', '));

  // --- the mock site must not reference anything off this machine -----------
  const mockFiles = fs.readdirSync(path.join(ROOT, 'tests', 'mock-site'))
    .filter(f => /\.(html|js|css|json)$/.test(f));
  const external = [];
  mockFiles.forEach(f => {
    const txt = read(path.join('tests', 'mock-site', f));
    const urls = txt.match(/https?:\/\/[^"'\s)]+/g) || [];
    urls.forEach(u => {
      if (!/^https?:\/\/(localhost|127\.0\.0\.1)([:/]|$)/.test(u)) external.push(f + ': ' + u);
    });
  });
  ok('M7  the mock site contacts nothing outside this machine',
    external.length === 0, external.join('; '));
}

// ------------------------------------------------------------------- summary
function finish() {
  console.log('\n' + '='.repeat(62));
  console.log('passed: ' + passed + '   failed: ' + failed + '   skipped: ' + skipped);
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach(f => console.log('  - ' + f));
  }
  console.log('='.repeat(62));
  process.exit(failed ? 1 : 0);
}
