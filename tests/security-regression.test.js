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
const { configureWispPrivateNetwork, isNonPublicAddress, resolveTargetAddresses } = require('../app/server/network-policy');

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

test('private target classification rejects special IPv4/IPv6 ranges and mapped private IPv4', () => {
    for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.1.1', '100.64.0.1', '::', '::1', 'fc00::1', 'fd00::1', 'fe80::1', 'ff02::1', '::ffff:192.168.1.1', '2001:db8::1']) {
        assert.equal(isNonPublicAddress(address), true, address);
    }
    for (const address of ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111']) {
        assert.equal(isNonPublicAddress(address), false, address);
    }
});

test('target DNS results are checked and the selected addresses are pinned for connection', async () => {
    await assert.rejects(
        resolveTargetAddresses('mixed.example', { lookup: async () => [
            { address: '93.184.216.34', family: 4 }, { address: '10.0.0.8', family: 4 }
        ] }),
        { code: 'PRIVATE_NETWORK_DISABLED' }
    );
    const resolved = await resolveTargetAddresses('public.example', {
        lookup: async () => [{ address: '93.184.216.34', family: 4 }]
    });
    const pinned = await new Promise((resolve, reject) => resolved.lookup('public.example', { all: true }, (error, addresses) => error ? reject(error) : resolve(addresses)));
    assert.deepEqual(pinned, [{ address: '93.184.216.34', family: 4 }]);
    const explicitlyAllowed = await resolveTargetAddresses('router.local', {
        allowPrivateNetworkProxy: true,
        lookup: async () => [{ address: '192.168.1.1', family: 4 }]
    });
    assert.equal(explicitlyAllowed.addresses[0].address, '192.168.1.1');
});

test('Wisp private-network access follows explicit configuration and fails closed when unsupported', () => {
    const server = { options: { allow_private_ips: true } };
    configureWispPrivateNetwork(server, false);
    assert.equal(server.options.allow_private_ips, false);
    configureWispPrivateNetwork(server, true);
    assert.equal(server.options.allow_private_ips, true);
    assert.throws(() => configureWispPrivateNetwork({}, false), /不支持局域网目标访问策略/);
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
function loadApp(t, auth = '', options = {}) {
    const fixture = fs.mkdtempSync(path.join(__dirname, '.security-test-'));
    t.after(() => {
        assert.equal(path.dirname(fixture), __dirname);
        fs.rmSync(fixture, { recursive: true, force: true });
    });
    if (options.prepare) options.prepare(fixture);
    const filename = path.resolve(__dirname, '../app/server/index.js');
    const nativeRequire = createRequire(filename);
    const fakeServer = { on() { return this; }, listen() { return this; } };
    const sandbox = {
        require(name) {
            if (name === 'http') return { ...http, createServer: () => fakeServer };
            if (name === './storage') return { ...nativeRequire(name), ...options.storage };
            if (name === './tls') return { createTlsManager: () => ({
                httpsStatus: { enabled: false, port: 0, mode: 'ca' }, initTlsMaterials: () => null,
                getCaCertDer: () => options.caDer || null,
                buildCaMobileConfig: () => '<plist>fixture certificate profile</plist>'
            }) };
            if (name.startsWith('@mercuryworkshop/')) throw new Error('optional engine omitted in handler tests');
            return nativeRequire(name);
        },
        process: { ...process, env: { ...process.env, ...(options.env || {}), DATA_DIR: fixture, HOST: '127.0.0.1', PORT: '0', HTTPS_PORT: '0', AUTH_TOKEN: auth, ALLOW_PRIVATE_NETWORK_PROXY: (options.env && options.env.ALLOW_PRIVATE_NETWORK_PROXY) || '' } },
        __dirname: path.dirname(filename), Buffer, URL, URLSearchParams, setTimeout, clearTimeout,
        console: { log() {}, error() {} }
    };
    const context = vm.createContext(sandbox);
    const handlers = vm.runInContext(fs.readFileSync(filename, 'utf8') + '\n;({requestHandler, upgradeHandler});', context, { filename });
    return { ...handlers, context, fixture };
}

test('API status reports private-network proxy policy and lite proxy blocks private targets by default', async t => {
    const app = loadApp(t, '', { env: { ALLOW_PRIVATE_NETWORK_PROXY: '0' } });
    const server = http.createServer(app.requestHandler);
    const origin = await listen(server);
    t.after(() => close(server));
    const status = await request(origin + '/api/status', { headers: { origin } });
    assert.equal(status.status, 200);
    assert.equal(JSON.parse(status.body).privateNetworkProxy, false);

    const upstream = http.createServer((_req, res) => res.end('must not be reached'));
    const target = await listen(upstream);
    t.after(() => close(upstream));
    const encoded = Buffer.from(target, 'utf8').toString('base64url');
    const blocked = await request(origin + '/lite-proxy/' + encoded);
    assert.equal(blocked.status, 403);
    assert.match(blocked.body, /局域网目标访问默认关闭/);
});

test('explicit private-network proxy opt-in is reflected by the authenticated status endpoint', async t => {
    const app = loadApp(t, '', { env: { ALLOW_PRIVATE_NETWORK_PROXY: '1' } });
    const server = http.createServer(app.requestHandler);
    const origin = await listen(server);
    t.after(() => close(server));
    const status = await request(origin + '/api/status', { headers: { origin } });
    assert.equal(status.status, 200);
    assert.equal(JSON.parse(status.body).privateNetworkProxy, true);

    const upstream = http.createServer((_req, res) => res.end('private target allowed by explicit opt-in'));
    const target = await listen(upstream);
    t.after(() => close(upstream));
    const encoded = Buffer.from(target, 'utf8').toString('base64url');
    const proxied = await request(origin + '/lite-proxy/' + encoded);
    assert.equal(proxied.status, 200);
    assert.equal(proxied.body, 'private target allowed by explicit opt-in');
});

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

test('failed settings persistence does not activate an unpersisted password', async t => {
    const app = loadApp(t, '', { storage: { writeJson() { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } } });
    const server = http.createServer(app.requestHandler);
    const origin = await listen(server);
    t.after(() => close(server));
    const settingsBefore = fs.readFileSync(path.join(app.fixture, 'settings.json'));
    const result = await request(origin + '/api/settings', {
        method: 'PUT', headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ authPassword: 'uncommitted-password' })
    });
    assert.equal(result.status, 500);
    assert.equal(result.headers['set-cookie'], undefined);
    const auth = await request(origin + '/api/auth/status');
    assert.equal(JSON.parse(auth.body).authRequired, false);
    assert.deepEqual(fs.readFileSync(path.join(app.fixture, 'settings.json')), settingsBefore);
});

test('fresh startup creates no NAS download directory or records', t => {
    const app = loadApp(t);
    assert.equal(fs.existsSync(path.join(app.fixture, 'downloads')), false);
    assert.equal(fs.existsSync(path.join(app.fixture, 'downloads.json')), false);
    assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(path.join(app.fixture, 'settings.json'))), 'downloadDir'), false);
});

test('removed download and directory APIs return 404 even to an authenticated caller', async t => {
    const app = loadApp(t, 'fixture-pass');
    const server = http.createServer(app.requestHandler);
    const origin = await listen(server);
    t.after(() => close(server));
    const cases = [
        ['GET', '/api/downloads'], ['POST', '/api/downloads'], ['DELETE', '/api/downloads'],
        ['POST', '/api/downloads/old/cancel'], ['GET', '/api/downloads/old/file'],
        ['DELETE', '/api/downloads/old?deleteFile=1'], ['GET', '/api/fs/roots'],
        ['GET', '/api/fs/list?dir=/'], ['POST', '/api/fs/mkdir']
    ];
    for (const [method, route] of cases) {
        const result = await request(origin + route, {
            method, headers: { origin, 'x-aurora-token': 'fixture-pass', 'content-type': 'application/json' },
            body: method === 'POST' ? JSON.stringify({ url: 'http://127.0.0.1:1/unused', parent: app.fixture, name: 'unexpected' }) : undefined
        });
        assert.equal(result.status, 404, method + ' ' + route);
        assert.equal(JSON.parse(result.body).error, 'API route not found');
    }
    assert.equal(fs.existsSync(path.join(app.fixture, 'unexpected')), false);
    assert.equal(fs.existsSync(path.join(app.fixture, 'downloads')), false);
});

test('legacy download files and records are left untouched and removed settings never create a directory', async t => {
    for (const records of ['[{"id":"old","status":"downloading"}]', '{broken legacy records']) {
        let oldDir;
        const app = loadApp(t, 'fixture-pass', { prepare(fixture) {
            oldDir = path.join(fixture, 'downloads');
            fs.mkdirSync(oldDir);
            fs.writeFileSync(path.join(oldDir, 'saved.bin'), 'old completed file');
            fs.writeFileSync(path.join(oldDir, 'pending.bin.part'), 'old partial file');
            fs.writeFileSync(path.join(fixture, 'downloads.json'), records);
            fs.writeFileSync(path.join(fixture, 'settings.json'), JSON.stringify({ downloadDir: oldDir, theme: 'dark' }));
        } });
        const server = http.createServer(app.requestHandler);
        const origin = await listen(server);
        t.after(() => close(server));
        const headers = { origin, 'x-aurora-token': 'fixture-pass', 'content-type': 'application/json' };
        const before = await request(origin + '/api/settings', { headers });
        assert.equal(before.status, 200);
        assert.equal(Object.hasOwn(JSON.parse(before.body), 'downloadDir'), false);
        assert.equal(JSON.parse(before.body).theme, 'dark');
        const unwantedDir = path.join(app.fixture, 'must-not-be-created');
        const saved = await request(origin + '/api/settings', {
            method: 'PUT', headers, body: JSON.stringify({ downloadDir: unwantedDir, theme: 'light' })
        });
        assert.equal(saved.status, 200);
        assert.equal(Object.hasOwn(JSON.parse(saved.body), 'downloadDir'), false);
        assert.equal(JSON.parse(saved.body).theme, 'light');
        assert.equal(fs.existsSync(unwantedDir), false);
        assert.equal(fs.readFileSync(path.join(app.fixture, 'downloads.json'), 'utf8'), records);
        assert.equal(fs.readFileSync(path.join(oldDir, 'saved.bin'), 'utf8'), 'old completed file');
        assert.equal(fs.readFileSync(path.join(oldDir, 'pending.bin.part'), 'utf8'), 'old partial file');
        assert.deepEqual(fs.readdirSync(oldDir).sort(), ['pending.bin.part', 'saved.bin']);
        assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(path.join(app.fixture, 'settings.json'))), 'downloadDir'), false);
    }
});

test('certificate downloads remain available before authentication', async t => {
    const app = loadApp(t, 'fixture-pass', { caDer: Buffer.from('fixture certificate') });
    const server = http.createServer(app.requestHandler);
    const origin = await listen(server);
    t.after(() => close(server));
    const certificate = await request(origin + '/aurora-ca.crt');
    assert.equal(certificate.status, 200);
    assert.equal(certificate.body, 'fixture certificate');
    assert.match(certificate.headers['content-disposition'], /aurora-ca\.crt/);
    const profile = await request(origin + '/aurora-ca.mobileconfig');
    assert.equal(profile.status, 200);
    assert.match(profile.body, /fixture certificate profile/);
    assert.match(profile.headers['content-disposition'], /aurora-ca\.mobileconfig/);
    assert.equal((await request(origin + '/api/settings', { headers: { origin } })).status, 401);
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
    const handler = createLiteProxy({ tokenParam: ['_', 'aurora', '_token'].join(''), allowPrivateNetworkProxy: true, ...options });
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

test('lite proxy bounds target DNS resolution time', async t => {
    const proxy = await withProxy(t, (_req, res) => res.end('must not be reached'), {
        dnsTimeoutMs: 20,
        resolveTarget: () => new Promise(() => {})
    });
    const result = await request(proxy.url('/'));
    assert.equal(result.status, 504);
    assert.match(result.body, /解析超时/);
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
