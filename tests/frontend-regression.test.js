'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../app/www/index.html'), 'utf8');
const source = html.slice(html.indexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));

// Execute the application's actual top-level functions; only browser/network leaf
// dependencies are mocked. A column-zero declaration marks the next source block.
function applicationFunction(name) {
  const start = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(start, `Missing application function: ${name}`);
  const rest = source.slice(start.index + start[0].length);
  const next = /^(?:(?:async )?function |(?:const|let) |document\.|window\.|init\(\);)/m.exec(rest);
  return source.slice(start.index, next ? start.index + start[0].length + next.index : source.length);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const flush = async () => { for (let i = 0; i < 200; i++) await Promise.resolve(); };

function harness(options = {}) {
  const nodes = new Map();
  const timers = new Map();
  const intervals = new Map();
  const requests = [];
  let nextTimer = 0;
  let renderCount = 0;
  let bookmarkRenders = 0;
  const scripts = [];

  function element(initialId = '') {
    const listeners = new Map();
    const classes = new Set();
    let id = '';
    let markup = '';
    const node = {
      style: {}, children: [], attributes: {}, value: '', textContent: '', disabled: false,
      classList: {
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        contains: (name) => classes.has(name),
        toggle(name, force) {
          const active = force === undefined ? !classes.has(name) : Boolean(force);
          if (active) classes.add(name); else classes.delete(name);
          return active;
        }
      },
      appendChild(child) { child.parentNode = node; node.children.push(child); return child; },
      remove() {
        for (const child of [...node.children]) child.remove();
        if (nodes.get(id) === node) nodes.delete(id);
        if (node.parentNode) node.parentNode.children = node.parentNode.children.filter((child) => child !== node);
        node.removed = true;
      },
      setAttribute(name, value) { node.attributes[name] = String(value); },
      getAttribute(name) { return node.attributes[name] ?? null; },
      addEventListener(name, callback) {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name).add(callback);
      },
      removeEventListener(name, callback) { listeners.get(name)?.delete(callback); },
      dispatch(name) { for (const callback of [...(listeners.get(name) || [])]) callback({}); },
      callbacks(name) { return [...(listeners.get(name) || [])]; },
      querySelector(selector) {
        if (selector.includes('.proxy-frame')) return node.children.find((child) => child.tagName === 'IFRAME') || null;
        return null;
      },
      querySelectorAll() { return []; },
      focus() {},
      blur() {},
      select() {}
    };
    Object.defineProperties(node, {
      id: {
        get: () => id,
        set(value) { if (id) nodes.delete(id); id = value; if (id) nodes.set(id, node); }
      },
      innerHTML: {
        get: () => markup,
        set(value) {
          for (const child of [...node.children]) child.remove();
          markup = value;
          const iframe = /<iframe\b([^>]*)>/i.exec(value);
          if (iframe) {
            const frame = element();
            frame.tagName = 'IFRAME';
            frame.contentWindow = { open() {} };
            const documentListeners = new Map();
            frame.contentDocument = {
              title: '',
              listeners: documentListeners,
              addEventListener(name, callback, capture = false) {
                if (!documentListeners.has(name)) documentListeners.set(name, []);
                documentListeners.get(name).push({ callback, capture });
              }
            };
            for (const [, name, attrValue] of iframe[1].matchAll(/([\w-]+)="([^"]*)"/g)) {
              frame.attributes[name] = attrValue;
              if (name === 'id') frame.id = attrValue;
              if (name === 'src') frame.src = attrValue;
            }
            node.appendChild(frame);
          }
        }
      }
    });
    node.id = initialId;
    return node;
  }

  for (const id of ['authLockModal', 'authLockInput', 'authLockErr', 'authLockSubmitBtn',
    'startupNotice', 'startupRetryBtn', 'viewportContainer', 'loadingBar', 'statusText',
    'urlInput', 'backBtn', 'forwardBtn', 'starBtn', 'omniboxLockBtn', 'engineBadge', 'menuEngineInfo',
    'diagCopyBtn', 'diagCopyStatus', 'body']) element(id);
  const document = {
    title: 'Aurora', activeElement: null,
    body: null,
    execCommand: () => typeof options.execCommand === 'function' ? options.execCommand(document) : Boolean(options.execCommand),
    getElementById: (id) => nodes.get(id) || null,
    createElement(tag) { const node = element(); node.tagName = tag.toUpperCase(); return node; },
    querySelectorAll(selector) { return selector === '.tab-pane' ? [...nodes.values()].filter((node) => node.id.startsWith('pane-')) : []; },
    head: { appendChild(script) { scripts.push(script); if (options.autoLoadScripts !== false) queueMicrotask(() => script.onload?.()); } }
  };
  document.body = nodes.get('body');
  const context = vm.createContext({
    URL, TextEncoder, TextDecoder, AbortController, document,
    location: { href: options.href || 'https://aurora.test/', origin: 'https://aurora.test', protocol: 'https:', host: 'aurora.test' },
    history: { replaceState(...args) { context.replacedUrl = args[2]; } },
    sessionStorage: options.storage || { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: {}, window: { isSecureContext: true },
    console: { log() {}, warn() {} },
    setTimeout(callback, ms) { const id = ++nextTimer; timers.set(id, { callback, ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
    setInterval(callback, ms) { const id = ++nextTimer; intervals.set(id, { callback, ms }); return id; },
    clearInterval: (id) => intervals.delete(id),
    fetch: async (url, init = {}) => {
      requests.push({ url, init });
      if (options.fetch) return options.fetch(url, init);
      if (url === '/api/auth/status') return response({ authRequired: false, authenticated: true });
      if (url === '/api/bookmarks' || url === '/api/history') return response([]);
      return response({});
    },
    applyTheme() {}, applyZoom() {}, resetFindState() {}, syncZoomIndicators() {}, updateHttpsSection() {},
    updateEngineBadge() {}, renderSidebarPanel() {}, installFramePopupGuards() {},
    renderTabStrip() { renderCount++; },
    renderBookmarkBar() { bookmarkRenders++; },
    renderNewTabPage(pane, tabId) { pane.innerHTML = `newtab:${tabId}`; },
    resolveUserInput: (input) => input,
    buildProxySrc: async (target) => '/lite-proxy/' + encodeURIComponent(target),
    loadEpoxyModule: async () => ({ default: class EpoxyTransport {} })
  });
  const stateStart = source.indexOf('const state = ');
  vm.runInContext(source.slice(stateStart, source.indexOf('// Base64URL', stateStart)), context);
  context.state = vm.runInContext('state', context);
  context.state.startup.authenticated = options.authenticated !== false;
  vm.runInContext('let latestDiagnostics = [];', context);
  vm.runInContext(source.slice(source.indexOf("let auroraToken = ''"), source.indexOf('function authHeaders')), context);
  vm.runInContext('const scriptLoads = new Map(); const closedTabUrls = [];', context);
  const names = ['authHeaders', 'withToken', 'withTimeout', 'fetchJson', 'setStartupIssue', 'loadScriptTag',
    'bootScramjet', 'canUseScramjet', 'isIntranetUrl', 'onScramjetUrlChange', 'isCurrentNavigation', 'clearTabFrameWatch', 'disposeTabFrame',
    'watchTabFrame', 'navigateWithScramjet', 'navigateWithLite', 'createTab', 'closeTab', 'switchTab',
    'getActiveTab', 'navigateTab', 'syncLoadingIndicator', 'showLoading', 'syncToolbarWithActiveTab',
    'loadBookmarks', 'refreshHistoryCache', 'ensureAuthenticated', 'refreshNewTabPages',
    'loadStartupStatus', 'loadStartupSettings', 'init', 'onFrameNavigationMessage',
    'buildDiagnosticReport', 'copyDiagnosticText', 'copyDiagnostics'];
  for (const name of names) vm.runInContext(applicationFunction(name), context, { filename: `index.html:${name}` });

  function addTab(id, url = `https://${id}.test/`) {
    const tab = { id, title: id, url, history: [url], historyIndex: 0, navigationSeq: 0, loading: false, zoom: 1 };
    context.state.tabs.push(tab);
    const pane = element(`pane-${id}`);
    nodes.get('viewportContainer').appendChild(pane);
    context.state.activeTabId = id;
    return { tab, pane };
  }
  function fire(ms) {
    const due = [...timers].filter(([, timer]) => timer.ms === ms);
    for (const [id, timer] of due) { timers.delete(id); timer.callback(); }
  }
  return { context, state: context.state, nodes, timers, intervals, requests, scripts, addTab, fire,
    get renderCount() { return renderCount; }, get bookmarkRenders() { return bookmarkRenders; } };
}

function installKernel(h, options = {}) {
  const worker = { postMessage() {} };
  h.context.navigator.serviceWorker = {
    controller: worker,
    register: async () => ({ active: worker }),
    ready: Promise.resolve({ active: worker }),
    addEventListener() {}, removeEventListener() {},
    ...options.serviceWorker
  };
  h.context.$scramjetController = { Controller: class Controller {
    wait() { return options.wait ? options.wait() : Promise.resolve(); }
    destroy() { h.controllerDestroyed = (h.controllerDestroyed || 0) + 1; }
  } };
}

// Mirrors the public 0.1.0 implementation: createFrame pushes a Frame with
// controller/element/plugins into controller.frames; Frame has no destroy().
// https://unpkg.com/@mercuryworkshop/scramjet-controller@0.1.0/src/index.ts
function installFrameRegistry(h) {
  h.context.$scramjetUtils = { UrlWatcherPlugin: class UrlWatcherPlugin {
    constructor(callback) { this.onUrlChange = callback; }
  } };
  const controller = { frames: [], createFrame(element, options = {}) {
    const frame = { controller: this, element, options, plugins: options.plugins || [],
      go(url) { element.src = '/scramjet/' + encodeURIComponent(url); } };
    this.frames.push(frame);
    return frame;
  } };
  h.state.sj.ready = true;
  h.state.sj.controller = controller;
  return controller;
}

test('complete inline application script parses', () => {
  assert.doesNotThrow(() => new vm.Script(source));
});

test('diagnostic export uses an allowlist and omits URLs, host details and browser identifiers', () => {
  const h = harness();
  const report = h.context.buildDiagnosticReport([
    { key: 'ctx', ok: true, detail: 'https://private.example/path?token=secret', origin: 'https://192.168.1.8' },
    { key: 'sw', ok: false, detail: 'Cookie: private-cookie' },
    { key: 'tls', ok: true, status: 204, detail: 'https://192.168.1.8:18921/healthz' },
    { key: 'ws', ok: null, detail: 'AUTH_TOKEN=secret', userAgent: 'Private full browser UA' }
  ]);

  assert.match(report, /安全上下文: 正常/);
  assert.match(report, /Service Worker: 异常/);
  assert.match(report, /HTTPS 入口: 正常 \(HTTP 204\)/);
  assert.match(report, /Wisp WebSocket: 检测中/);
  for (const privateValue of ['private.example', '192.168.1.8', 'secret', 'private-cookie', 'Private full browser UA', '/healthz']) {
    assert.equal(report.includes(privateValue), false, `Diagnostic export leaked ${privateValue}`);
  }
  assert.match(report, /不会自动上传/);
});

test('diagnostic copy supports the clipboard API and legacy fallback, then reports the result', async () => {
  let legacyCopiedText = '';
  const h = harness({ execCommand(document) {
    legacyCopiedText = document.body.children.find((child) => child.tagName === 'TEXTAREA')?.value || '';
    return Boolean(legacyCopiedText);
  } });
  let copiedText = '';
  h.context.navigator.clipboard = { async writeText(text) { copiedText = text; } };
  assert.equal(await h.context.copyDiagnosticText('safe summary'), true);
  assert.equal(copiedText, 'safe summary');

  delete h.context.navigator.clipboard;
  assert.equal(await h.context.copyDiagnosticText('legacy summary'), true);
  assert.equal(legacyCopiedText, 'legacy summary');
  assert.equal(h.nodes.get('body').children.length, 0);

  h.context.navigator.clipboard = { async writeText(text) { copiedText = text; } };
  h.context.testDiagnosticData = [{ key: 'ctx', ok: true }];
  vm.runInContext('latestDiagnostics = testDiagnosticData', h.context);
  await h.context.copyDiagnostics();
  assert.equal(h.nodes.get('diagCopyStatus').textContent, '已复制');
  assert.match(copiedText, /安全上下文: 正常/);

  h.context.navigator.clipboard = undefined;
  h.context.document.execCommand = () => false;
  await h.context.copyDiagnostics();
  assert.equal(h.nodes.get('diagCopyStatus').textContent, '复制失败，请检查浏览器权限');
});

test('frame popup links open Aurora tabs across click phases while downloads stay native', () => {
  const h = harness();
  const listeners = new Map();
  const opened = [];
  const frameWindow = { open() {} };
  const frameDocument = { addEventListener(name, callback, capture = false) {
    if (!listeners.has(name)) listeners.set(name, []);
    listeners.get(name).push({ callback, capture });
  } };
  h.context.openTabFromFramePopup = (url) => opened.push(url);
  vm.runInContext(applicationFunction('installFramePopupGuards'), h.context);
  h.context.installFramePopupGuards({ contentWindow: frameWindow, contentDocument: frameDocument });
  assert.equal(frameWindow.__auroraOpenWrapped, true);
  assert.equal(listeners.get('click').length, 2);
  assert.equal(listeners.get('auxclick').length, 2);

  function followLink({ download = false, target = '_blank', type = 'click', button = 0,
    ctrlKey = false, metaKey = false, targetAfterCapture = null } = {}) {
    let prevented = false;
    let stopped = false;
    let targetAttr = target;
    const anchor = {
      href: 'https://files.test/report.pdf',
      getAttribute(name) { return name === 'href' ? '/report.pdf' : name === 'target' ? targetAttr : ''; },
      hasAttribute(name) { return name === 'download' && download; }
    };
    const event = {
      type, button, ctrlKey, metaKey,
      target: { closest: () => anchor },
      preventDefault() { prevented = true; },
      stopPropagation() { stopped = true; },
      stopImmediatePropagation() { stopped = true; }
    };
    for (const capture of [true, false]) {
      if (capture === false && targetAfterCapture !== null) targetAttr = targetAfterCapture;
      for (const listener of listeners.get(type) || []) {
        if (listener.capture === capture && !stopped) listener.callback(event);
      }
    }
    return { prevented, stopped };
  }

  assert.deepEqual(followLink({ download: true }), { prevented: false, stopped: false });
  assert.deepEqual(followLink({ download: true, ctrlKey: true }), { prevented: false, stopped: false });
  assert.deepEqual(followLink({ target: '', targetAfterCapture: '_blank' }), { prevented: true, stopped: true });
  assert.deepEqual(followLink({ target: '', type: 'auxclick', button: 1 }), { prevented: true, stopped: true });
  assert.deepEqual(followLink({ target: '', ctrlKey: true }), { prevented: true, stopped: true });
  assert.deepEqual(followLink({ target: '_blank' }), { prevented: true, stopped: true });
  assert.deepEqual(opened, [
    'https://files.test/report.pdf',
    'https://files.test/report.pdf',
    'https://files.test/report.pdf',
    'https://files.test/report.pdf'
  ]);
  assert.equal(h.requests.length, 0);
});

test('live iframe installs popup guards on its load event', () => {
  const h = harness();
  const { tab, pane } = h.addTab('popup-test');
  pane.innerHTML = '<iframe class="proxy-frame" id="frame-popup-test"></iframe>';
  const frame = pane.querySelector('.proxy-frame');
  vm.runInContext(applicationFunction('installFramePopupGuards'), h.context);
  h.context.watchTabFrame(tab, pane, frame, tab.navigationSeq);
  frame.dispatch('load');
  assert.equal(frame.contentWindow.__auroraOpenWrapped, true);
  assert.equal(frame.contentDocument.listeners.get('click').length, 2);
  assert.equal(frame.contentDocument.listeners.get('auxclick').length, 2);
});

test('download shortcut is left to the host browser after NAS management is removed', () => {
  const h = harness();
  let onKeydown;
  h.context.window.addEventListener = (name, callback) => { if (name === 'keydown') onKeydown = callback; };
  const start = source.indexOf('// 快捷键支持');
  const end = source.indexOf('// 系统主题变化时', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), h.context);
  for (const modifier of ['ctrlKey', 'metaKey']) {
    let prevented = false;
    onKeydown({ key: 'j', [modifier]: true, preventDefault() { prevented = true; } });
    assert.equal(prevented, false);
  }
  assert.equal(h.requests.length, 0);
});

test('blocked sessionStorage retains URL token and strips the address before authentication', async () => {
  const denied = () => { throw new Error('Storage denied'); };
  const h = harness({ authenticated: false, href: 'https://aurora.test/?_aurora_token=secret&keep=1#top',
    storage: { getItem: denied, setItem: denied, removeItem: denied },
    fetch: async (url) => url === '/api/auth/status'
      ? response({ authRequired: true, authenticated: true }) : response({ ok: true }) });
  assert.equal(h.context.replacedUrl, '/?keep=1#top');
  assert.equal(h.requests.length, 0);
  assert.throws(() => h.context.authHeaders(), /请先完成访问验证/);
  assert.equal(await h.context.ensureAuthenticated(), true);
  assert.equal(h.requests[0].init.headers['X-Aurora-Token'], 'secret');
  assert.equal(h.requests[1].url, '/api/auth/session');
  h.state.startup.authenticated = true;
  assert.equal(h.context.authHeaders()['X-Aurora-Token'], 'secret');
  assert.equal(new URL(h.context.withToken('/lite-proxy/test')).searchParams.get('_aurora_token'), 'secret');
});

test('fetchJson rejects HTTP failures, malformed JSON and a stalled body with a deadline', async () => {
  const badHttp = harness({ fetch: async () => response({}, 503) });
  await assert.rejects(badHttp.context.fetchJson('/bad'), /HTTP 503/);
  const badJson = harness({ fetch: async () => ({ ok: true, json: async () => { throw new SyntaxError('bad JSON'); } }) });
  await assert.rejects(badJson.context.fetchJson('/bad'), /bad JSON/);
  const body = deferred();
  const stalled = harness({ fetch: async () => ({ ok: true, json: () => body.promise }) });
  const request = stalled.context.fetchJson('/stalled');
  await flush();
  stalled.fire(6000);
  await assert.rejects(request, /请求超时/);
  assert.equal(stalled.requests[0].init.signal.aborted, true);
  assert.equal(stalled.timers.size, 0);
});

test('authentication HTTP, network, schema and JSON failures never start business requests', async () => {
  const failures = [
    async () => response({}, 502),
    async () => { throw new Error('offline'); },
    async () => response({}),
    async () => ({ ok: true, json: async () => { throw new SyntaxError('bad JSON'); } })
  ];
  for (const fetch of failures) {
    const h = harness({ authenticated: false, fetch });
    await h.context.init();
    assert.deepEqual(h.requests.map((request) => request.url), ['/api/auth/status']);
    assert.equal(h.state.tabs.length, 0);
    assert.equal(h.state.startup.authenticated, false);
    assert.match(h.nodes.get('startupNotice').textContent, /无法验证访问权限/);
    assert.equal(h.nodes.get('startupRetryBtn').hidden, false);
    await h.context.loadBookmarks();
    await h.context.refreshHistoryCache();
    assert.equal(h.requests.length, 1);
  }
});

test('stalled authentication fails closed and remains retryable', async () => {
  let offline = true;
  const h = harness({ authenticated: false, fetch: async (url) => {
    if (offline) return new Promise(() => {});
    if (url === '/api/auth/status') return response({ authRequired: false, authenticated: true });
    return response(url === '/api/bookmarks' || url === '/api/history' ? [] : {});
  } });
  const first = h.context.init();
  await flush();
  h.fire(6000);
  await first;
  assert.equal(h.state.tabs.length, 0);
  assert.equal(h.requests.length, 1);
  offline = false;
  await h.context.init();
  assert.equal(h.state.tabs.length, 1);
  assert.equal(h.nodes.get('startupRetryBtn').hidden, true);
});

test('login waits for successful session exchange and wrong passwords allow another attempt', async () => {
  let correct = false;
  const h = harness({ authenticated: false, fetch: async (url) => {
    if (url === '/api/auth/status') return response({ authRequired: true, authenticated: false });
    if (url === '/api/auth/session') return response(correct ? { ok: true } : {}, correct ? 200 : 401);
    return response(url === '/api/bookmarks' || url === '/api/history' ? [] : {});
  } });
  const starting = h.context.init();
  await flush();
  assert.equal(h.nodes.get('authLockModal').classList.contains('open'), true);
  assert.equal(h.requests.length, 1);
  h.nodes.get('authLockInput').value = 'wrong';
  await h.nodes.get('authLockSubmitBtn').onclick();
  assert.equal(h.state.tabs.length, 0);
  assert.match(h.nodes.get('authLockErr').textContent, /密码错误/);
  assert.equal(h.nodes.get('authLockSubmitBtn').disabled, false);
  correct = true;
  h.nodes.get('authLockInput').value = 'correct';
  await h.nodes.get('authLockSubmitBtn').onclick();
  await starting;
  assert.equal(h.state.startup.authenticated, true);
  assert.equal(h.state.tabs.length, 1);
  assert.equal(h.nodes.get('authLockModal').classList.contains('open'), false);
  assert.equal(h.nodes.get('authLockInput').value, '');
});

test('home renders before independent startup data and failed data can be retried without duplicate tabs', async () => {
  const pending = Object.fromEntries(['/api/status', '/api/settings', '/api/bookmarks', '/api/history'].map((url) => [url, deferred()]));
  let retry = false;
  const h = harness({ authenticated: false, fetch: async (url) => {
    if (url === '/api/auth/status') return response({ authRequired: false, authenticated: true });
    if (!retry) return pending[url].promise;
    if (url === '/api/bookmarks') return response([{ title: 'Example', url: 'https://example.test/' }]);
    return response(url === '/api/history' ? [] : {});
  } });
  const starting = h.context.init();
  await flush();
  assert.equal(h.state.tabs.length, 1);
  assert.match(h.nodes.get(`pane-${h.state.tabs[0].id}`).innerHTML, /^newtab:/);
  assert.equal(h.requests.length, 5);
  pending['/api/settings'].resolve(response({ theme: 'dark', showBookmarksBar: false }));
  pending['/api/bookmarks'].resolve({ ok: true, json: async () => { throw new SyntaxError('broken bookmarks'); } });
  pending['/api/history'].resolve(response({}, 503));
  await flush();
  assert.equal(h.state.settings.theme, 'dark');
  h.fire(6000); // status never returned; it cannot hold the homepage hostage.
  await starting;
  assert.equal(h.state.tabs.length, 1);
  assert.equal(h.state.bookmarks.length, 0);
  assert.match(h.nodes.get('startupNotice').textContent, /书签加载失败/);
  assert.match(h.nodes.get('startupNotice').textContent, /历史记录加载失败/);
  retry = true;
  await h.context.init();
  assert.equal(h.state.tabs.length, 1);
  assert.equal(h.state.bookmarks[0].title, 'Example');
  assert.equal(h.nodes.get('startupRetryBtn').hidden, true);
});

test('script loading is bounded, cleans failed nodes and caches only successful loads', async () => {
  const h = harness({ autoLoadScripts: false });
  const first = h.context.loadScriptTag('/stalled.js');
  h.fire(4000);
  await assert.rejects(first, /脚本加载超时/);
  assert.equal(h.scripts[0].removed, true);
  const second = h.context.loadScriptTag('/stalled.js');
  assert.equal(h.scripts.length, 2);
  h.scripts[1].onload();
  await second;
  await h.context.loadScriptTag('/stalled.js');
  assert.equal(h.scripts.length, 2);
});

test('Scramjet has bounded activation and controller waits and a failed boot is retryable', async () => {
  for (const stall of ['ready', 'controller']) {
    const h = harness();
    const gate = deferred();
    installKernel(h, stall === 'ready'
      ? { serviceWorker: { ready: gate.promise } }
      : { wait: () => gate.promise });
    const first = h.context.bootScramjet();
    await flush();
    h.fire(4000);
    assert.equal(await first, false);
    assert.equal(h.state.sj.bootPromise, null);
    assert.equal(h.state.sj.ready, false);
    installKernel(h);
    assert.equal(await h.context.bootScramjet(), true);
    assert.equal(h.state.sj.ready, true);
    assert.equal(h.intervals.size, 1);
    assert.equal(await h.context.bootScramjet(), true);
    assert.equal(h.intervals.size, 1);
    gate.resolve({});
    await flush();
    assert.equal(h.state.sj.ready, true);
  }
});

test('total boot deadline invalidates late work before another attempt publishes its controller', async () => {
  const h = harness();
  const lateModule = deferred();
  installKernel(h);
  h.context.loadEpoxyModule = () => lateModule.promise;
  const first = h.context.bootScramjet();
  await flush();
  h.fire(12000);
  assert.equal(await first, false);
  assert.equal(h.state.sj.bootPromise, null);
  h.context.loadEpoxyModule = async () => ({ default: class EpoxyTransport {} });
  assert.equal(await h.context.bootScramjet(), true);
  const controller = h.state.sj.controller;
  lateModule.resolve({ default: class OldTransport {} });
  await flush();
  assert.equal(h.state.sj.controller, controller);
  assert.equal(h.intervals.size, 1);
});

test('rapid lite navigation ignores an old asynchronous proxy URL and records only the live navigation', async () => {
  const h = harness();
  const { tab, pane } = h.addTab('a');
  const firstUrl = deferred();
  h.context.buildProxySrc = (url) => url.includes('first') ? firstUrl.promise : Promise.resolve('/lite-proxy/second');
  const first = h.context.navigateTab('a', 'https://first.test/');
  const second = h.context.navigateTab('a', 'https://second.test/');
  await second;
  const frame = h.nodes.get('frame-a');
  firstUrl.resolve('/lite-proxy/first');
  await first;
  assert.equal(h.nodes.get('frame-a'), frame);
  assert.equal(pane.querySelector('.proxy-frame').src, '/lite-proxy/second');
  assert.equal(tab.url, 'https://second.test/');
  assert.deepEqual(h.requests.map((request) => JSON.parse(request.init.body).url), ['https://second.test/']);
  assert.equal(frame.getAttribute('sandbox'), 'allow-scripts allow-forms allow-downloads');
  assert.equal(frame.getAttribute('referrerpolicy'), 'no-referrer');
});

test('late kernel startup cannot replace a newer home navigation', async () => {
  const h = harness();
  const { tab, pane } = h.addTab('a');
  const boot = deferred();
  h.state.engineMode = 'scramjet';
  h.context.bootScramjet = () => boot.promise;
  const first = h.context.navigateTab('a', 'https://pending-kernel.test/');
  await h.context.navigateTab('a', 'fn://newtab');
  boot.resolve(false);
  await first;
  assert.equal(tab.url, 'fn://newtab');
  assert.equal(pane.innerHTML, 'newtab:a');
  assert.equal(h.nodes.get('frame-a'), undefined);
  assert.equal(h.requests.length, 0);
});

test('closing a tab invalidates pending work and its load callbacks without changing the active tab', async () => {
  const h = harness();
  const { tab, pane } = h.addTab('a');
  const { tab: active } = h.addTab('b');
  active.loading = true;
  const target = deferred();
  h.context.buildProxySrc = () => target.promise;
  const navigation = h.context.navigateTab('a', 'https://pending.test/');
  h.context.closeTab('a');
  const markupAtClose = pane.innerHTML;
  target.resolve('/lite-proxy/late');
  await navigation;
  assert.equal(h.state.tabs.includes(tab), false);
  assert.equal(pane.innerHTML, markupAtClose);
  assert.equal(h.nodes.get('frame-a'), undefined);
  assert.equal(active.loading, true);
  assert.equal(h.requests.length, 0);
});

test('returning from Scramjet to newtab destroys the old frame and later navigation creates a live frame', async () => {
  const h = harness();
  const { tab, pane } = h.addTab('a');
  let destroys = 0;
  let creates = 0;
  const watchers = [];
  h.context.$scramjetUtils = { UrlWatcherPlugin: class UrlWatcherPlugin { constructor(callback) { watchers.push(callback); } } };
  h.state.sj.ready = true;
  h.state.sj.controller = { createFrame() { creates++; return { go() {}, destroy() { destroys++; } }; } };
  h.context.canUseScramjet = () => true;
  await h.context.navigateTab('a', 'https://first.test/');
  const oldFrame = h.nodes.get('frame-a');
  const oldLoad = oldFrame.callbacks('load')[0];
  await h.context.navigateTab('a', 'fn://newtab');
  assert.equal(tab.sjFrame, null);
  assert.equal(destroys, 1);
  assert.equal(oldFrame.src, 'about:blank');
  assert.equal(oldFrame.removed, true);
  assert.equal(tab.loadTimer, null);
  oldLoad();
  watchers[0]('https://stale.test/');
  assert.equal(tab.url, 'fn://newtab');
  assert.equal(tab.title, '新标签页');
  assert.equal(pane.innerHTML, 'newtab:a');
  await h.context.navigateTab('a', 'https://next.test/');
  assert.equal(creates, 2);
  assert.notEqual(h.nodes.get('frame-a'), oldFrame);
});

test('explicit Scramjet A to B navigation rejects late A watcher and loading callbacks and releases its frame', async () => {
  const h = harness();
  const { tab } = h.addTab('a', 'fn://newtab');
  const watchers = [];
  const controllers = [];
  h.context.$scramjetUtils = { UrlWatcherPlugin: class UrlWatcherPlugin { constructor(callback) { watchers.push(callback); } } };
  h.state.sj.ready = true;
  h.state.sj.controller = { createFrame() {
    const frame = { go() {}, destroyed: false, destroy() { frame.destroyed = true; } };
    controllers.push(frame);
    return frame;
  } };
  await h.context.navigateTab('a', 'https://a.test/');
  const frameA = h.nodes.get('frame-a');
  const oldLoad = frameA.callbacks('load')[0];
  const oldError = frameA.callbacks('error')[0];
  const oldTimerId = tab.loadTimer;
  const oldTimeout = h.timers.get(oldTimerId).callback;
  await h.context.navigateTab('a', 'https://b.test/');
  const frameB = h.nodes.get('frame-a');
  const timerB = tab.loadTimer;
  const expected = { url: tab.url, title: tab.title, history: Array.from(tab.history),
    historyIndex: tab.historyIndex, expectedUrl: tab.sjExpectUrl, requests: h.requests.length };

  watchers[0]('https://a.test/');
  assert.deepEqual({ url: tab.url, title: tab.title, history: Array.from(tab.history),
    historyIndex: tab.historyIndex, expectedUrl: tab.sjExpectUrl, requests: h.requests.length }, expected);
  oldLoad();
  oldError();
  oldTimeout();
  assert.equal(tab.loading, true);
  assert.equal(tab.loadError, '');
  assert.equal(tab.loadTimer, timerB);
  assert.equal(h.timers.has(timerB), true);
  assert.equal(h.timers.has(oldTimerId), false);
  assert.notEqual(frameB, frameA);
  assert.equal(controllers.length, 2);
  assert.equal(controllers[0].destroyed, true);
  assert.equal(frameA.removed, true);
  assert.equal(frameA.src, 'about:blank');
  assert.equal(frameA.callbacks('load').length, 0);
  assert.equal(frameA.callbacks('error').length, 0);
  assert.equal(frameB.callbacks('load').length, 1);
  assert.equal(frameB.callbacks('error').length, 1);
});

test('the current Scramjet frame keeps programmatic URL, in-page clicks and redirects in history', async () => {
  const h = harness();
  const { tab } = h.addTab('a', 'fn://newtab');
  const watchers = [];
  h.context.$scramjetUtils = { UrlWatcherPlugin: class UrlWatcherPlugin { constructor(callback) { watchers.push(callback); } } };
  h.state.sj.ready = true;
  h.state.sj.controller = { createFrame() { return { go() {}, destroy() {} }; } };
  await h.context.navigateTab('a', 'https://a.test/');
  await h.context.navigateTab('a', 'https://b.test/');
  const watcher = watchers[watchers.length - 1];
  const frameB = h.nodes.get('frame-a');
  const historyWrites = h.requests.length;
  watcher('https://b.test/');
  assert.equal(tab.sjExpectUrl, null);
  assert.equal(tab.history.length, 3);
  assert.equal(h.requests.length, historyWrites);
  watcher('https://b.test/clicked');
  watcher('https://redirected.test/final');
  assert.equal(tab.url, 'https://redirected.test/final');
  assert.equal(tab.title, 'redirected.test');
  assert.deepEqual(Array.from(tab.history), ['fn://newtab', 'https://a.test/', 'https://b.test/',
    'https://b.test/clicked', 'https://redirected.test/final']);
  assert.equal(tab.historyIndex, 4);
  assert.equal(h.requests.length, historyWrites + 2);
  assert.equal(h.nodes.get('frame-a'), frameB);
  frameB.dispatch('load');
  assert.equal(tab.loading, false);
  assert.equal(tab.loadTimer, null);

  // A redirect may be the first watcher event after an explicit go().
  await h.context.navigateTab('a', 'https://next.test/start');
  watchers[watchers.length - 1]('https://next.test/redirected');
  assert.equal(tab.url, 'https://next.test/redirected');
  assert.equal(tab.sjExpectUrl, null);
  assert.deepEqual(Array.from(tab.history).slice(-2), ['https://next.test/start', 'https://next.test/redirected']);
});

test('Scramjet 0.1.0 frames registry stays bounded without destroy across navigation, home, lite and close', async () => {
  const h = harness();
  const { tab: a, pane: paneA } = h.addTab('a', 'fn://newtab');
  const { tab: b } = h.addTab('b', 'fn://newtab');
  const controller = installFrameRegistry(h);
  const registry = controller.frames;
  await h.context.navigateTab('b', 'https://background.test/');
  const frameB = b.sjFrame;
  for (let i = 0; i < 12; i++) {
    const previous = a.sjFrame;
    await h.context.navigateTab('a', `https://a.test/page-${i}`);
    assert.equal(typeof a.sjFrame.destroy, 'undefined');
    assert.equal(controller.frames, registry);
    assert.equal(registry.length, 2);
    assert.equal(registry[0], frameB);
    assert.equal(registry[1], a.sjFrame);
    if (previous) {
      assert.equal(previous.element.removed, true);
      assert.equal(previous.element.src, 'about:blank');
      assert.equal(previous.element.callbacks('load').length, 0);
      assert.equal(previous.element.callbacks('error').length, 0);
    }
  }
  await h.context.navigateTab('a', 'fn://newtab');
  assert.deepEqual(registry, [frameB]);
  h.context.disposeTabFrame(a, paneA);
  assert.deepEqual(registry, [frameB]);
  await h.context.navigateTab('a', 'https://a.test/again');
  assert.equal(registry.length, 2);
  await h.context.navigateTab('a', 'https://192.168.1.1/');
  assert.equal(a.kernel, 'lite');
  assert.deepEqual(registry, [frameB]);
  h.context.closeTab('b');
  assert.deepEqual(registry, []);
  await h.context.navigateTab('a', 'https://a.test/final');
  assert.equal(registry.length, 1);
  h.context.closeTab('a');
  assert.deepEqual(registry, []);
  assert.equal(h.timers.size, 0);
});

test('frame release uses its owning controller and preserves native destroy and failure cleanup', async () => {
  for (const mode of ['absent', 'native', 'throw']) {
    const h = harness();
    const { tab, pane } = h.addTab('a', 'fn://newtab');
    const owner = installFrameRegistry(h);
    await h.context.navigateTab('a', 'https://a.test/');
    const frame = tab.sjFrame;
    const element = frame.element;
    let destroys = 0;
    if (mode !== 'absent') frame.destroy = () => {
      destroys++;
      if (mode === 'throw') throw new Error('native destroy failed');
      owner.frames.splice(owner.frames.indexOf(frame), 1);
      frame.controller = null;
    };
    const unrelatedFrame = {};
    const replacement = { frames: [unrelatedFrame] };
    h.state.sj.controller = replacement;
    h.context.disposeTabFrame(tab, pane);
    h.context.disposeTabFrame(tab, pane);
    assert.deepEqual(owner.frames, []);
    assert.deepEqual(replacement.frames, [unrelatedFrame]);
    assert.equal(destroys, mode === 'absent' ? 0 : 1);
    assert.equal(tab.sjFrame, null);
    assert.equal(tab.sjExpectUrl, null);
    assert.equal(tab.loadTimer, null);
    assert.equal(element.removed, true);
    assert.equal(element.callbacks('load').length, 0);
    assert.equal(element.callbacks('error').length, 0);
  }
});

test('background load events and timeouts update only their owning navigation and switching tabs restores loading UI', async () => {
  const h = harness();
  h.context.canUseScramjet = () => false;
  const { tab: a } = h.addTab('a');
  const { tab: b } = h.addTab('b');
  await h.context.navigateTab('a', 'https://a.test/');
  await h.context.navigateTab('b', 'https://b.test/');
  const staleLoadB = h.nodes.get('frame-b').callbacks('load')[0];
  const timeoutA = h.timers.get(a.loadTimer).callback;
  h.nodes.get('frame-a').contentDocument.title = 'Background A';
  h.nodes.get('frame-a').dispatch('load');
  assert.equal(a.loading, false);
  assert.equal(a.title, 'Background A');
  assert.equal(b.loading, true);
  assert.equal(h.nodes.get('loadingBar').classList.contains('active'), true);
  h.fire(15000);
  assert.equal(b.loading, false);
  assert.match(b.loadError, /加载超时/);
  await h.context.navigateTab('b', 'https://b-new.test/');
  staleLoadB();
  assert.equal(b.loading, true);
  await h.context.navigateTab('a', 'fn://newtab');
  timeoutA();
  assert.equal(a.loading, false);
  assert.equal(a.loadError, '');
  h.context.switchTab('a');
  assert.equal(h.nodes.get('loadingBar').classList.contains('active'), false);
  h.context.switchTab('b');
  assert.equal(h.nodes.get('loadingBar').classList.contains('active'), true);
});

test('Scramjet frame failure preserves the lite fallback', async () => {
  const h = harness();
  h.addTab('a');
  h.state.sj.ready = true;
  h.state.sj.controller = { createFrame() { throw new Error('frame unavailable'); } };
  h.context.canUseScramjet = () => true;
  await h.context.navigateTab('a', 'https://fallback.test/');
  assert.equal(h.state.tabs[0].kernel, 'lite');
  assert.ok(h.nodes.get('frame-a').src.startsWith('/lite-proxy/'));
});

test('navigation messages reject forged sources, origins and mismatched tab ids and accept the real opaque frame', async () => {
  const h = harness();
  h.context.canUseScramjet = () => false;
  const { tab: a } = h.addTab('a');
  const { tab: b } = h.addTab('b');
  await h.context.navigateTab('a', 'https://a.test/');
  await h.context.navigateTab('b', 'https://b.test/');
  const frameA = h.nodes.get('frame-a');
  const send = (origin, eventSource, tabId) => h.context.onFrameNavigationMessage({ origin, source: eventSource,
    data: { type: 'fn-browser-nav', title: 'New title', url: 'https://updated.test/', tabId } });
  const snapshot = JSON.stringify([a, b], (key, value) => key === 'frameCleanup' ? undefined : value);
  send('null', {}, 'a');
  send('https://evil.test', frameA.contentWindow, 'a');
  send('null', frameA.contentWindow, 'b');
  send('null', frameA.contentWindow, 'closed-tab');
  assert.equal(JSON.stringify([a, b], (key, value) => key === 'frameCleanup' ? undefined : value), snapshot);
  send('null', frameA.contentWindow, 'a');
  assert.equal(a.url, 'https://updated.test/');
  assert.equal(a.title, 'New title');
  assert.equal(b.url, 'https://b.test/');
  h.context.closeTab('a');
  send('null', frameA.contentWindow, 'a');
  assert.equal(b.url, 'https://b.test/');
});
