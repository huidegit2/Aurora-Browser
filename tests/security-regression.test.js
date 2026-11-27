'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { createRequire } = require('node:module');
const { isTrustedBrowserRequest, safeCookieValue } = require('../app/server/request-security');
const { createLiteProxy } = require('../app/server/lite-proxy');

const browserRequest = (headers = {}, encrypted = false) => ({
    headers: { host: 'nas.local:18920', ...headers }, socket: { encrypted }
});

test('management request origins: real origin allowed, foreign and opaque origins denied', () => {
    assert.equal(isTrustedBrowserRequest(browserRequest({ origin: 'http://nas.local:18920' })), true);
    for (const origin of ['null', 'https://evil.example', 'http://nas.local:18921', 'http://nas.local:18920.evil.test', 'garbage']) {
        assert.equal(isTrustedBrowserRequest(browserRequest({ origin })), false, origin);
    }
    assert.equal(isTrustedBrowserRequest(browserRequest({ 'sec-fetch-site': 'cross-site' })), false);
    assert.equal(isTrustedBrowserRequest(browserRequest({ 'sec-fetch-site': 'same-site' })), false);
    assert.equal(isTrustedBrowserRequest(browserRequest({ referer: 'http://evil.test/page' })), false);
    assert.equal(isTrustedBrowserRequest(browserRequest({ referer: 'http://nas.local:18920/' })), true);
});

test('reverse proxy respects preserved Host/protocol and ignores forged forwarded host', () => {
    assert.equal(isTrustedBrowserRequest(browserRequest({ host: 'aurora.example', 'x-forwarded-proto': 'https', origin: 'https://aurora.example' })), true);
    assert.equal(isTrustedBrowserRequest(browserRequest({ 'x-forwarded-host': 'evil.test', origin: 'http://evil.test' })), false);
    assert.equal(isTrustedBrowserRequest(browserRequest({ host: 'nas.local/evil' })), false);
});

test('WebSocket origin is mandatory and malformed cookies fail closed without throwing', () => {
    assert.equal(isTrustedBrowserRequest(browserRequest(), { requireOrigin: true }), false);
    assert.equal(isTrustedBrowserRequest(browserRequest({ origin: 'http://nas.local:18920' }), { requireOrigin: true }), true);
    assert.equal(safeCookieValue('a=1; aurora_session=abc%20d', 'aurora_session'), 'abc d');
    assert.equal(safeCookieValue('aurora_session=%E0%A4%A', 'aurora_session'), '');
});

async function listen(server) {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return `http://127.0.0.1:${server.address().port}`;
}
function close(server) {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
}
function request(url, { method = 'GET', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request(url, { method, headers }, (res) => {
            const parts = [];
            res.on('data', c => parts.push(c));
            res.on('error', reject);
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts).toString() }));
        });
        req.on('error', reject);
        req.setTimeout(3000, () => req.destroy(new Error('test request timed out')));
        req.end(body);
    });
}

// Load the real request/upgrade handlers without listening on a public port,
// loading native proxy dependencies or creating system certificates.
function loadApp(t, auth = '') {
    const fixture = fs.mkdtempSync(path.join(__dirname, '.security-test-'));
    t.after(() => {
        assert.equal(path.dirname(fixture), __dirname);
        fs.rmSync(fixture, { recursive: true, force: true });
    });
    const filename = path.resolve(__dirname, '../app/server/index.js');
    const nativeRequire = createRequire(filename);
    const fakeServer = { on() { return this; }, listen() { return this; } };
    const sandbox = {
        require(name) {
            if (name === 'http') return { ...http, createServer: () => fakeServer };
            if (name === './tls') return { createTlsManager: () => ({
                httpsStatus: { enabled: false, port: 0, mode: 'ca' }, initTlsMaterials: () => null, getCaCertDer: () => null
            }) };
            if (name.startsWith('@mercuryworkshop/')) throw new Error('optional engine omitted in handler tests');
            return nativeRequire(name);
        },
        process: { ...process, env: { DATA_DIR: fixture, HOST: '127.0.0.1', PORT: '0', HTTPS_PORT: '0', AUTH_TOKEN: auth } },
        __dirname: path.dirname(filename), Buffer, URL, URLSearchParams, setTimeout, clearTimeout,
        console: { log() {}, error() {} }
    };
    const context = vm.createContext(sandbox);
    const handlers = vm.runInContext(fs.readFileSync(filename, 'utf8') + '\n;({requestHandler, upgradeHandler});', context, { filename });
    return { ...handlers, context, fixture };
}

test('real API handler denies sandbox/foreign calls and accepts authenticated same-origin calls', async t => {
    const app = loadApp(t, 'fixture-pass');
    const server = http.createServer(app.requestHandler);
    const origin = await listen(server);
    t.after(() => close(server));
    for (const badOrigin of ['null', 'http://evil.test']) {
        const result = await request(origin + '/api/settings', { headers: { origin: badOrigin, 'x-aurora-token': 'fixture-pass' } });
        assert.equal(result.status, 403);
    }
    const anonymous = await request(origin + '/api/settings', { headers: { origin } });
    assert.equal(anonymous.status, 401);
    const result = await request(origin + '/api/settings', { headers: { origin, 'x-aurora-token': 'fixture-pass' } });
    assert.equal(result.status, 200);
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.equal(result.headers['referrer-policy'], 'no-referrer');
    assert.equal(Object.hasOwn(JSON.parse(result.body), 'authPassword'), false);
    const malformed = await request(origin + '/api/auth/status', { headers: { cookie: 'aurora_session=%E0%A4%A' } });
    assert.equal(malformed.status, 200);
    assert.equal(JSON.parse(malformed.body).authenticated, false);
});

test('rejected settings update does not activate an unpersisted password', async t => {
    const app = loadApp(t);
    const server = http.createServer(app.requestHandler);
    const origin = await listen(server);
    t.after(() => close(server));
    const notDirectory = path.join(app.fixture, 'plain-file');
    fs.writeFileSync(notDirectory, 'fixture');
    const result = await request(origin + '/api/settings', {
        method: 'PUT', headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ authPassword: 'uncommitted-password', downloadDir: notDirectory })
    });
    assert.equal(result.status, 400);
    const auth = await request(origin + '/api/auth/status');
    assert.equal(JSON.parse(auth.body).authRequired, false);
});

test('real WebSocket handler checks origin before invoking Wisp transport', t => {
    const app = loadApp(t);
    vm.runInContext('var transportCalls = 0; wispRouteRequest = () => { transportCalls++; };', app.context);
    for (const origin of [undefined, 'null', 'http://evil.test']) {
        let destroyed = false;
        const req = browserRequest(origin === undefined ? {} : { origin });
        req.url = '/wisp/';
        app.upgradeHandler(req, { destroy() { destroyed = true; } }, Buffer.alloc(0));
        assert.equal(destroyed, true);
    }
    const req = browserRequest({ origin: 'http://nas.local:18920' });
    req.url = '/wisp/';
    app.upgradeHandler(req, { destroy() { assert.fail('valid socket destroyed'); } }, Buffer.alloc(0));
    assert.equal(vm.runInContext('transportCalls', app.context), 1);
});

async function withProxy(t, upstreamHandler, options = {}) {
    const upstream = http.createServer(upstreamHandler);
    const target = await listen(upstream);
    const handler = createLiteProxy({ tokenParam: '_aurora_token', ...options });
    const proxy = http.createServer((req, res) => {
        const parsed = new URL(req.url, 'http://localhost');
        handler(req, res, parsed.pathname.slice(1), parsed.search);
    });
    const origin = await listen(proxy);
    t.after(async () => { await close(proxy); await close(upstream); });
    return { target, url: pathSuffix => `${origin}/${Buffer.from(target + pathSuffix).toString('base64url')}` };
}

test('lite proxy removes management secrets in both directions and applies sandbox even on direct visits', async t => {
    let received;
    const proxy = await withProxy(t, (req, res) => {
        received = req;
        res.writeHead(200, {
            'content-type': 'text/html', 'set-cookie': 'aurora_session=attacker',
            'clear-site-data': '"*"', 'service-worker-allowed': '/',
            'content-security-policy': "default-src *", 'cache-control': 'public'
        });
        res.end('<html><head><title>fixture</title></head><body><a href="/next">next</a></body></html>');
    });
    const result = await request(proxy.url('/') + '?_aurora_token=fixture-secret', { headers: {
        cookie: 'aurora_session=fixture-cookie', authorization: 'Bearer fixture', 'x-aurora-token': 'fixture-secret',
        referer: 'http://nas.local/?_aurora_token=fixture-secret', origin: 'http://nas.local',
        'x-forwarded-host': 'nas.local', 'x-trim-userid': '1234'
    } });
    assert.equal(result.status, 200);
    for (const header of ['cookie', 'authorization', 'x-aurora-token', 'referer', 'origin', 'x-forwarded-host', 'x-trim-userid']) {
        assert.equal(received.headers[header], undefined, header);
    }
    assert.equal(received.url, '/');
    for (const header of ['set-cookie', 'clear-site-data', 'service-worker-allowed']) assert.equal(result.headers[header], undefined);
    assert.equal(result.headers['content-security-policy'], 'sandbox allow-scripts allow-forms allow-downloads');
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.match(result.body, /\/lite-proxy\//);
});

test('lite redirect is rewritten, drained and rejects non-HTTP targets', async t => {
    const proxy = await withProxy(t, (req, res) => {
        res.writeHead(302, { location: req.url === '/bad' ? 'file:///etc/passwd' : '/next', 'content-length': '10' });
        res.end('0123456789');
    });
    const good = await request(proxy.url('/redirect'));
    assert.equal(good.status, 302);
    assert.match(good.headers.location, /^\/lite-proxy\//);
    assert.equal(good.headers['content-length'], undefined);
    assert.equal((await request(proxy.url('/bad'))).status, 502);
});

test('lite buffering is bounded and upstream stalls have a terminal response', async t => {
    const proxy = await withProxy(t, (req, res) => {
        if (req.url === '/hang') return;
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('x'.repeat(512));
    }, { timeoutMs: 80, maxHtmlBytes: 128 });
    assert.equal((await request(proxy.url('/large'))).status, 502);
    assert.equal((await request(proxy.url('/hang'))).status, 504);
});

test('lite partial HTML fails cleanly and never renders a truncated document', async t => {
    const proxy = await withProxy(t, (req, res) => {
        res.writeHead(200, { 'content-type': 'text/html', 'content-length': '999' });
        res.write('<html>partial');
        setTimeout(() => res.destroy(), 10);
    });
    const result = await request(proxy.url('/'));
    assert.equal(result.status, 502);
    assert.doesNotMatch(result.body, /<html>partial/);
});
