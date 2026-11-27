'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { createDownloadManager } = require('../app/server/downloads');
const storage = require('../app/server/storage');

async function waitUntil(check, message = 'condition', timeoutMs = 4_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const result = check();
        if (result) return result;
        await delay(10);
    }
    assert.fail(`Timed out waiting for ${message}`);
}

async function withFixture(run, timeoutOptions = {}) {
    // Every fixture, including the JSON database and output files, stays inside this checkout.
    const root = fs.mkdtempSync(path.join(__dirname, '.downloads-regression-'));
    const defaultDownloadDir = path.join(root, 'files');
    fs.mkdirSync(defaultDownloadDir);
    const downloadsFile = path.join(root, 'downloads.json');
    const servers = [];
    const managers = [];
    const terminalWrites = [];
    let previous = new Map();
    const writeJson = (file, items) => {
        storage.writeJson(file, items);
        for (const item of items) {
            if (item.status !== 'downloading' && previous.get(item.id) !== JSON.stringify(item)) {
                terminalWrites.push({ id: item.id, status: item.status });
            }
        }
        previous = new Map(items.map((item) => [item.id, JSON.stringify(item)]));
    };
    const options = {
        downloadsFile,
        defaultDownloadDir,
        readJson: storage.readJson,
        writeJson,
        isDirWritable: storage.isDirWritable,
        connectTimeoutMs: 1_000,
        stallTimeoutMs: 1_000,
        ...timeoutOptions
    };
    const createManager = (overrides = {}) => {
        const manager = createDownloadManager({ ...options, ...overrides });
        managers.push(manager);
        return manager;
    };
    const manager = createManager();
    const fixture = {
        manager,
        createManager,
        root,
        dir: defaultDownloadDir,
        downloadsFile,
        seed: (items) => writeJson(downloadsFile, items),
        events: (id) => terminalWrites.filter((item) => item.id === id).map((item) => item.status),
        terminal: (record) => waitUntil(() => {
            const item = manager.findDownload(record.id);
            return item && item.status !== 'downloading' ? item : null;
        }, `terminal state for ${record.id}`),
        async serve(handler) {
            const sockets = new Set();
            const server = http.createServer(handler);
            server.on('connection', (socket) => {
                sockets.add(socket);
                socket.on('close', () => sockets.delete(socket));
            });
            servers.push({ server, sockets });
            await new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(0, '127.0.0.1', resolve);
            });
            return `http://127.0.0.1:${server.address().port}`;
        }
    };
    try {
        await run(fixture);
    } finally {
        try {
            for (const current of managers) {
                for (const item of current.getDownloadsList()) {
                    if (item.status === 'downloading') current.cancelDownload(item.id);
                }
            }
            await Promise.all(servers.map(({ server, sockets }) => {
                for (const socket of sockets) socket.destroy();
                return new Promise((resolve) => server.close(resolve));
            }));
            await waitUntil(() => managers.every((current) => (
                current.getDownloadsList().every((item) => item.status !== 'downloading')
            )), 'fixture download cleanup');
        } finally {
            assert.equal(path.dirname(root), __dirname, 'only remove a fixture below tests');
            fs.rmSync(root, { recursive: true, force: true });
        }
    }
}

function assertNoPartial(fixture, record) {
    assert.deepEqual(fs.readdirSync(fixture.dir), []);
    assert.equal(record.speedBps, 0);
    assert.ok(record.finishedAt);
}

test('successful download follows a relative redirect and completes only once', async () => {
    await withFixture(async (f) => {
        const payload = Buffer.from('Aurora local download \u2600\ufe0f');
        const base = await f.serve((req, res) => {
            if (req.url === '/start') {
                res.writeHead(302, { Location: '/payload' });
                res.end('redirect body is discarded');
                return;
            }
            res.writeHead(200, {
                'Content-Length': payload.length,
                'Content-Disposition': "attachment; filename*=UTF-8''local%20file.bin"
            });
            res.end(payload);
        });
        const started = f.manager.startNasDownload(`${base}/start`);
        const done = await f.terminal(started);
        assert.equal(done.status, 'completed');
        assert.equal(done.filename, 'local file.bin');
        assert.equal(done.receivedBytes, payload.length);
        assert.equal(done.totalBytes, payload.length);
        assert.equal(done.error, '');
        assert.deepEqual(fs.readFileSync(done.filePath), payload);
        assert.deepEqual(fs.readdirSync(f.dir), ['local file.bin']);
        f.manager.cancelDownload(done.id);
        f.manager.cancelDownload(done.id);
        await delay(40);
        assert.deepEqual(f.manager.findDownload(done.id), done);
        assert.deepEqual(f.events(done.id), ['completed']);
    });
});

test('empty and chunked responses both complete with accurate lengths', async () => {
    await withFixture(async (f) => {
        const base = await f.serve((req, res) => {
            if (req.url === '/empty') {
                res.writeHead(200, { 'Content-Length': '0' });
                res.end();
            } else {
                res.write('one');
                res.end('two');
            }
        });
        for (const [route, payload] of [['empty', ''], ['chunked', 'onetwo']]) {
            const done = await f.terminal(f.manager.startNasDownload(`${base}/${route}`));
            assert.equal(done.status, 'completed');
            assert.equal(done.receivedBytes, Buffer.byteLength(payload));
            assert.equal(done.totalBytes, Buffer.byteLength(payload));
            assert.equal(fs.readFileSync(done.filePath, 'utf8'), payload);
            assert.deepEqual(f.events(done.id), ['completed']);
        }
    });
});

test('connection/response timeout destroys a request that never sends headers', async () => {
    await withFixture(async (f) => {
        let closed = false;
        const base = await f.serve((req, res) => {
            res.on('close', () => { closed = true; });
        });
        const done = await f.terminal(f.manager.startNasDownload(`${base}/no-headers`));
        assert.equal(done.status, 'failed');
        assert.match(done.error, /连接或响应超时/);
        assertNoPartial(f, done);
        await waitUntil(() => closed, 'timed-out request to close');
        f.manager.cancelDownload(done.id);
        assert.deepEqual(f.events(done.id), ['failed']);
    }, { connectTimeoutMs: 150, stallTimeoutMs: 500 });
});

test('body stall timeout closes the response and removes the partial file', async () => {
    await withFixture(async (f) => {
        let closed = false;
        const base = await f.serve((req, res) => {
            res.on('close', () => { closed = true; });
            res.writeHead(200, { 'Content-Length': '100' });
            res.write('partial');
        });
        const done = await f.terminal(f.manager.startNasDownload(`${base}/stall`));
        assert.equal(done.status, 'failed');
        assert.match(done.error, /停滞超时/);
        assert.equal(done.receivedBytes, 7);
        assert.equal(done.totalBytes, 100);
        assertNoPartial(f, done);
        await waitUntil(() => closed, 'stalled response to close');
        assert.deepEqual(f.events(done.id), ['failed']);
    }, { stallTimeoutMs: 150 });
});

test('regular data resets the stall deadline instead of imposing a total transfer limit', async () => {
    await withFixture(async (f) => {
        const base = await f.serve((req, res) => {
            res.writeHead(200, { 'Content-Length': '6' });
            res.write('x');
            let sent = 1;
            const timer = setInterval(() => {
                sent += 1;
                if (sent === 6) res.end('x');
                else res.write('x');
            }, 50);
            res.on('close', () => clearInterval(timer));
        });
        const done = await f.terminal(f.manager.startNasDownload(`${base}/slow`));
        assert.equal(done.status, 'completed');
        assert.equal(fs.readFileSync(done.filePath, 'utf8'), 'xxxxxx');
        assert.deepEqual(f.events(done.id), ['completed']);
    }, { stallTimeoutMs: 180 });
});

for (const framing of ['content-length', 'chunked']) {
    test(`premature ${framing} response fails once and removes its partial file`, async () => {
        await withFixture(async (f) => {
            let response;
            const base = await f.serve((req, res) => {
                response = res;
                res.writeHead(200, framing === 'content-length' ? { 'Content-Length': '100' } : {});
                res.write('short');
            });
            const started = f.manager.startNasDownload(`${base}/truncated`);
            await waitUntil(() => f.manager.getDownloadsList()[0].receivedBytes === 5, 'partial bytes');
            response.destroy();
            const done = await f.terminal(started);
            assert.equal(done.status, 'failed');
            assert.match(done.error, /中断|提前关闭|不完整|长度/);
            assert.equal(done.receivedBytes, 5);
            assert.equal(done.totalBytes, framing === 'content-length' ? 100 : 0);
            assertNoPartial(f, done);
            await delay(40);
            f.manager.cancelDownload(done.id);
            assert.deepEqual(f.events(done.id), ['failed']);
        });
    });
}

test('cancellation before a response is idempotent and closes the request', async () => {
    await withFixture(async (f) => {
        let response;
        let closed = false;
        const base = await f.serve((req, res) => {
            response = res;
            res.on('close', () => { closed = true; });
        });
        const started = f.manager.startNasDownload(`${base}/waiting`);
        await waitUntil(() => response, 'server request');
        f.manager.cancelDownload(started.id);
        f.manager.cancelDownload(started.id);
        const done = await f.terminal(started);
        assert.equal(done.status, 'cancelled');
        assertNoPartial(f, done);
        await waitUntil(() => closed, 'cancelled request to close');
        assert.deepEqual(f.events(done.id), ['cancelled']);
    });
});

test('cancellation wins over a racing successful end and later aborted/error events', async () => {
    await withFixture(async (f) => {
        let response;
        let closed = false;
        const base = await f.serve((req, res) => {
            response = res;
            res.on('close', () => { closed = true; });
            res.writeHead(200, { 'Content-Length': '12' });
            res.write('first-');
        });
        const started = f.manager.startNasDownload(`${base}/cancel`);
        await waitUntil(() => f.manager.getDownloadsList()[0].receivedBytes === 6, 'partial bytes');
        response.end('second');
        f.manager.cancelDownload(started.id);
        f.manager.cancelDownload(started.id);
        const done = await f.terminal(started);
        assert.equal(done.status, 'cancelled');
        assertNoPartial(f, done);
        await waitUntil(() => closed, 'cancelled response to close');
        await delay(40);
        assert.deepEqual(f.manager.findDownload(done.id), done);
        assert.deepEqual(f.events(done.id), ['cancelled']);
    });
});

for (const location of ['file:///tmp/aurora', 'ftp://127.0.0.1/file', 'http://[invalid', 'http://%E0%A4%A@127.0.0.1/file']) {
    test(`redirect target ${location} fails without an uncaught URL/protocol error`, async () => {
        await withFixture(async (f) => {
            let closed = false;
            const base = await f.serve((req, res) => {
                res.on('close', () => { closed = true; });
                res.writeHead(302, { Location: location });
                res.write('redirect body stays open');
            });
            const done = await f.terminal(f.manager.startNasDownload(`${base}/redirect`));
            assert.equal(done.status, 'failed');
            assert.match(done.error, /http \/ https|重定向地址无效|URI malformed/);
            assertNoPartial(f, done);
            await waitUntil(() => closed, 'discarded redirect to close');
            assert.deepEqual(f.events(done.id), ['failed']);
        });
    });
}

test('each redirect hop is validated, including a later unsupported protocol', async () => {
    await withFixture(async (f) => {
        let requests = 0;
        const base = await f.serve((req, res) => {
            requests += 1;
            res.writeHead(302, { Location: req.url === '/one' ? '/two' : 'data:text/plain,bad' });
            res.end();
        });
        const done = await f.terminal(f.manager.startNasDownload(`${base}/one`));
        assert.equal(done.status, 'failed');
        assert.match(done.error, /http \/ https/);
        assert.equal(requests, 2);
        assertNoPartial(f, done);
        assert.deepEqual(f.events(done.id), ['failed']);
    });
});

test('a redirect loop fails after the existing five-hop limit', async () => {
    await withFixture(async (f) => {
        let requests = 0;
        const base = await f.serve((req, res) => {
            requests += 1;
            res.writeHead(302, { Location: '/loop' });
            res.end();
        });
        const done = await f.terminal(f.manager.startNasDownload(`${base}/loop`));
        assert.equal(done.status, 'failed');
        assert.match(done.error, /重定向次数过多/);
        assert.equal(requests, 6);
        assertNoPartial(f, done);
        assert.deepEqual(f.events(done.id), ['failed']);
    });
});

test('HTTP errors abort the response instead of leaving an error body downloading', async () => {
    await withFixture(async (f) => {
        let closed = false;
        const base = await f.serve((req, res) => {
            res.on('close', () => { closed = true; });
            res.writeHead(503);
            res.write('unending error body');
        });
        const done = await f.terminal(f.manager.startNasDownload(`${base}/error`));
        assert.equal(done.status, 'failed');
        assert.equal(done.error, 'HTTP 503');
        assertNoPartial(f, done);
        await waitUntil(() => closed, 'error response to close');
        assert.deepEqual(f.events(done.id), ['failed']);
    });
});

for (const [statusCode, headers] of [
    [206, { 'Content-Range': 'bytes 0-3/100' }],
    [206, {}],
    [200, { 'Content-Range': 'bytes 0-3/100' }]
]) {
    test(`unsolicited partial response ${statusCode} ${Object.keys(headers).join()} is rejected`, async () => {
        await withFixture(async (f) => {
            let requestRange;
            let closed = false;
            const base = await f.serve((req, res) => {
                requestRange = req.headers.range;
                res.on('close', () => { closed = true; });
                res.writeHead(statusCode, { ...headers, 'Content-Length': '100' });
                res.write('part');
            });
            const done = await f.terminal(f.manager.startNasDownload(`${base}/partial`));
            assert.equal(requestRange, undefined);
            assert.equal(done.status, 'failed');
            assert.match(done.error, /拒绝部分响应/);
            assert.equal(done.receivedBytes, 0);
            assert.equal(done.filePath, '');
            assertNoPartial(f, done);
            await waitUntil(() => closed, 'partial response to close');
            assert.deepEqual(f.events(done.id), ['failed']);
        });
    });
}

test('TLS request errors enter one failed state and leave no partial file', async () => {
    await withFixture(async (f) => {
        // A plain loopback HTTP server makes the TLS handshake fail without any external site.
        // Certificate-chain rejection itself needs a local certificate fixture and is not covered here.
        const base = await f.serve((req, res) => res.end('http only'));
        const done = await f.terminal(f.manager.startNasDownload(base.replace('http:', 'https:')));
        assert.equal(done.status, 'failed');
        assert.match(done.error, /SSL|TLS|EPROTO|wrong version|packet length/i);
        assertNoPartial(f, done);
        f.manager.cancelDownload(done.id);
        assert.deepEqual(f.events(done.id), ['failed']);
    });
});

test('exclusive partial files preserve existing files and separate concurrent equal filenames', async () => {
    await withFixture(async (f) => {
        fs.writeFileSync(path.join(f.dir, 'same.bin'), 'existing final');
        fs.writeFileSync(path.join(f.dir, 'same (1).bin.part'), 'existing partial');
        const base = await f.serve((req, res) => res.end(req.url));
        const first = f.manager.startNasDownload(`${base}/first`, 'same.bin');
        const second = f.manager.startNasDownload(`${base}/second`, 'same.bin');
        const results = await Promise.all([f.terminal(first), f.terminal(second)]);
        assert.ok(results.every((item) => item.status === 'completed'));
        assert.equal(new Set(results.map((item) => item.filePath)).size, 2);
        assert.equal(fs.readFileSync(path.join(f.dir, 'same.bin'), 'utf8'), 'existing final');
        assert.equal(fs.readFileSync(path.join(f.dir, 'same (1).bin.part'), 'utf8'), 'existing partial');
        assert.equal(fs.readFileSync(results[0].filePath, 'utf8'), '/first');
        assert.equal(fs.readFileSync(results[1].filePath, 'utf8'), '/second');
        for (const done of results) assert.deepEqual(f.events(done.id), ['completed']);
    });
});

test('deleting an active record cancels its request and removes its owned partial file', async () => {
    await withFixture(async (f) => {
        let closed = false;
        const base = await f.serve((req, res) => {
            res.on('close', () => { closed = true; });
            res.write('partial');
        });
        const started = f.manager.startNasDownload(`${base}/delete`);
        await waitUntil(() => f.manager.getDownloadsList()[0].receivedBytes === 7, 'partial bytes');
        const tmpPath = `${f.manager.findDownload(started.id).filePath}.part`;
        f.manager.deleteDownload(started.id, true);
        await waitUntil(() => closed && !fs.existsSync(tmpPath), 'deleted request and file cleanup');
        assert.equal(f.manager.findDownload(started.id), undefined);
        assert.deepEqual(fs.readdirSync(f.dir), []);
    });
});

for (const [label, value] of [
    ['object instead of array', { keep: 'original object' }],
    ['null instead of array', null],
    ['null record', [null, { id: 'old', status: 'downloading' }]],
    ['primitive record', ['keep original string']]
]) {
    test(`invalid JSON structure (${label}) keeps startup available and preserves original data`, async (t) => {
        const reports = [];
        t.mock.method(console, 'error', (...args) => reports.push(args.join(' ')));
        await withFixture(async (f) => {
            const original = `${JSON.stringify(value, null, 4)}\n`;
            fs.writeFileSync(f.downloadsFile, original);
            const restarted = f.createManager();
            assert.deepEqual(restarted.getDownloadsList(), []);
            assert.equal(restarted.findDownload('old'), undefined);
            restarted.cancelDownload('old');
            assert.throws(() => restarted.startNasDownload('http://127.0.0.1:1/file'), {
                code: 'DOWNLOADS_CORRUPT'
            });
            assert.throws(() => restarted.clearFinished(), { code: 'DOWNLOADS_CORRUPT' });
            assert.throws(() => restarted.deleteDownload('old', true), { code: 'DOWNLOADS_CORRUPT' });
            assert.equal(fs.readFileSync(f.downloadsFile, 'utf8'), original);
            assert.ok(reports.some((line) => line.includes('已保留原文件')));
            assert.deepEqual(fs.readdirSync(f.dir), []);
            assert.deepEqual(fs.readdirSync(f.root).sort(), ['downloads.json', 'files']);
        });
    });
}

for (const status of ['completed', 'failed', 'cancelled']) {
    for (const code of ['ENOSPC', 'EACCES']) {
        test(`${status} terminal write ${code} retains its outcome and later persists it`, async (t) => {
            const reports = [];
            t.mock.method(console, 'error', (...args) => reports.push(args.join(' ')));
            await withFixture(async (f) => {
                let targetId;
                let rejectTerminalWrites = true;
                const rejectedOutcomes = [];
                const manager = f.createManager({
                    writeJson(file, items) {
                        const target = items.find((item) => item.id === targetId);
                        if (rejectTerminalWrites && target && target.status !== 'downloading') {
                            rejectedOutcomes.push({ ...target });
                            throw Object.assign(new Error(`injected ${code}`), { code });
                        }
                        storage.writeJson(file, items);
                    }
                });
                let response;
                let followupResponse;
                const base = await f.serve((req, res) => {
                    if (req.url === '/followup') followupResponse = res;
                    else response = res;
                    res.writeHead(200, { 'Content-Length': '8' });
                    res.write('new-');
                });
                try {
                    const started = manager.startNasDownload(`${base}/target`, 'target.bin');
                    targetId = started.id;
                    await waitUntil(() => manager.getDownloadsList().some((item) => (
                        item.id === targetId && item.receivedBytes === 4
                    )), 'target partial bytes');
                    const beforeTerminal = fs.readFileSync(f.downloadsFile);
                    if (status === 'completed') response.end('file');
                    else if (status === 'failed') response.destroy();
                    else manager.cancelDownload(targetId);
                    await waitUntil(() => rejectedOutcomes.length === 1, 'injected terminal write failure');
                    assert.equal(rejectedOutcomes[0].status, status);
                    assert.deepEqual(fs.readFileSync(f.downloadsFile), beforeTerminal);
                    assert.equal(storage.readJson(f.downloadsFile, [])[0].status, 'downloading');
                    const ended = manager.findDownload(targetId);
                    assert.equal(ended.status, status);
                    assert.equal(ended.receivedBytes, status === 'completed' ? 8 : 4);
                    assert.equal(ended.totalBytes, 8);
                    assert.equal(ended.speedBps, 0);
                    assert.ok(ended.finishedAt);
                    if (status === 'failed') assert.match(ended.error, /中断|提前关闭|不完整/);
                    else assert.equal(ended.error, '');
                    assert.deepEqual(manager.getDownloadsList().find((item) => item.id === targetId), ended);
                    assert.ok(reports.some((line) => (
                        line.includes('保存下载状态失败') && line.includes(code) && line.includes('暂用内存状态')
                    )));
                    if (status === 'completed') {
                        assert.equal(fs.readFileSync(ended.filePath, 'utf8'), 'new-file');
                        assert.deepEqual(fs.readdirSync(f.dir), ['target.bin']);
                    } else {
                        assert.deepEqual(fs.readdirSync(f.dir), []);
                    }
                    manager.cancelDownload(targetId);
                    manager.cancelDownload(targetId);
                    await delay(30);
                    assert.deepEqual(manager.findDownload(targetId), ended);
                    assert.equal(rejectedOutcomes.length, 1, 'later cancel must not repeat or downgrade the terminal transition');
                    assert.throws(() => manager.startNasDownload(`${base}/still-unavailable`), { code });
                    assert.deepEqual(fs.readFileSync(f.downloadsFile), beforeTerminal);
                    assert.deepEqual(manager.findDownload(targetId), ended);

                    rejectTerminalWrites = false;
                    const followup = manager.startNasDownload(`${base}/followup`, 'followup.bin');
                    await waitUntil(() => followupResponse && manager.getDownloadsList().some((item) => (
                        item.id === followup.id && item.receivedBytes === 4
                    )), 'followup download after storage recovery');
                    assert.equal(manager.findDownload(followup.id).status, 'downloading');
                    assert.deepEqual(storage.readJson(f.downloadsFile, []).find((item) => item.id === targetId), ended);
                    followupResponse.end('file');
                    const finishedFollowup = await waitUntil(() => {
                        const item = manager.findDownload(followup.id);
                        return item.status !== 'downloading' ? item : null;
                    }, 'followup completion');
                    assert.equal(finishedFollowup.status, 'completed');
                    const persisted = storage.readJson(f.downloadsFile, []);
                    assert.deepEqual(persisted.find((item) => item.id === targetId), ended);
                    assert.deepEqual(persisted.find((item) => item.id === followup.id), finishedFollowup);
                    assert.deepEqual(f.createManager().getDownloadsList(), persisted);
                } finally {
                    rejectTerminalWrites = false;
                    manager.clearFinished();
                }
            });
        });
    }
}

for (const code of ['ENOSPC', 'EACCES']) {
    test(`startup recovery survives ${code}, keeps original JSON, and persists after storage recovers`, async (t) => {
        const reports = [];
        t.mock.method(console, 'error', (...args) => reports.push(args.join(' ')));
        await withFixture(async (f) => {
            const interrupted = {
                id: 'startup-interrupted', status: 'downloading', receivedBytes: 7, totalBytes: 100,
                speedBps: 55, createdAt: '2026-01-02T00:00:00.000Z', custom: 'retained'
            };
            const completed = { id: 'old-completed', status: 'completed', custom: { retained: true } };
            f.seed([interrupted, completed]);
            const original = fs.readFileSync(f.downloadsFile);
            let rejectWrites = true;
            let restarted;
            const writeJson = (file, items) => {
                if (rejectWrites) throw Object.assign(new Error(`injected ${code}`), { code });
                storage.writeJson(file, items);
            };
            try {
                assert.doesNotThrow(() => { restarted = f.createManager({ writeJson }); });
                const recovered = restarted.getDownloadsList().find((item) => item.id === interrupted.id);
                assert.equal(recovered.status, 'failed');
                assert.equal(recovered.receivedBytes, interrupted.receivedBytes);
                assert.equal(recovered.totalBytes, interrupted.totalBytes);
                assert.equal(recovered.speedBps, 0);
                assert.equal(recovered.custom, interrupted.custom);
                assert.match(recovered.error, /重启.*中断/);
                assert.ok(recovered.finishedAt);
                assert.deepEqual(restarted.findDownload(interrupted.id), recovered);
                assert.deepEqual(restarted.findDownload(completed.id), completed);
                assert.deepEqual(fs.readFileSync(f.downloadsFile), original);
                assert.ok(reports.some((line) => line.includes(code) && line.includes('暂用内存状态')));

                // Only the startup write is caught; normal mutation failures still reach the caller.
                assert.throws(() => restarted.startNasDownload('http://127.0.0.1:1/still-unavailable'), { code });
                assert.throws(() => restarted.clearFinished(), { code });
                assert.deepEqual(fs.readFileSync(f.downloadsFile), original);
                assert.deepEqual(restarted.findDownload(interrupted.id), recovered);

                let response;
                const base = await f.serve((req, res) => {
                    response = res;
                    res.writeHead(200, { 'Content-Length': '8' });
                    res.write('new-');
                });
                rejectWrites = false;
                const started = restarted.startNasDownload(`${base}/recovered`, 'recovered.bin');
                await waitUntil(() => response && restarted.getDownloadsList().some((item) => (
                    item.id === started.id && item.receivedBytes === 4
                )), 'new download after storage recovery');
                assert.equal(restarted.getDownloadsList().find((item) => item.id === started.id).status, 'downloading');
                assert.equal(restarted.findDownload(started.id).status, 'downloading');
                const persistedDuringDownload = storage.readJson(f.downloadsFile, []);
                assert.deepEqual(persistedDuringDownload.find((item) => item.id === interrupted.id), recovered);
                assert.equal(persistedDuringDownload.find((item) => item.id === started.id).status, 'downloading');
                response.end('file');
                const done = await waitUntil(() => {
                    const item = restarted.findDownload(started.id);
                    return item.status !== 'downloading' ? item : null;
                }, 'completed download after storage recovery');
                assert.equal(done.status, 'completed');
                assert.equal(fs.readFileSync(done.filePath, 'utf8'), 'new-file');
                assert.deepEqual(restarted.findDownload(interrupted.id), recovered);
                const persisted = storage.readJson(f.downloadsFile, []);
                assert.deepEqual(persisted.find((item) => item.id === started.id), done);
                assert.deepEqual(persisted.find((item) => item.id === interrupted.id), recovered);
                assert.deepEqual(f.createManager().getDownloadsList(), persisted);
            } finally {
                rejectWrites = false;
                // Also release seeded startup records if an earlier assertion failed.
                (restarted || f.manager).clearFinished();
            }
        });
    });
}

test('startup marks only leftover downloading records interrupted and preserves JSON metadata', async () => {
    await withFixture(async (f) => {
        const completedPath = path.join(f.dir, 'complete.bin');
        const interruptedPath = path.join(f.dir, 'interrupted.bin');
        fs.writeFileSync(completedPath, 'complete');
        fs.writeFileSync(`${interruptedPath}.part`, 'partial');
        const completed = {
            id: 'completed-record', status: 'completed', filePath: completedPath,
            receivedBytes: 8, totalBytes: 8, finishedAt: '2026-01-01T00:00:00.000Z', custom: { retained: true }
        };
        const cancelled = { id: 'cancelled-record', status: 'cancelled', error: '', receivedBytes: 2 };
        const interrupted = {
            id: 'interrupted-record', status: 'downloading', filename: 'interrupted.bin', filePath: interruptedPath,
            url: 'http://127.0.0.1/old', receivedBytes: 7, totalBytes: 100, speedBps: 55,
            createdAt: '2026-01-02T00:00:00.000Z', custom: 'keep'
        };
        f.seed([interrupted, completed, cancelled]);
        const restarted = f.createManager();
        const recovered = restarted.findDownload(interrupted.id);
        assert.equal(recovered.status, 'failed');
        assert.match(recovered.error, /重启.*中断/);
        assert.equal(recovered.receivedBytes, 7);
        assert.equal(recovered.totalBytes, 100);
        assert.equal(recovered.speedBps, 0);
        assert.equal(recovered.createdAt, interrupted.createdAt);
        assert.equal(recovered.custom, 'keep');
        assert.ok(recovered.finishedAt);
        assert.equal(fs.existsSync(`${interruptedPath}.part`), false);
        assert.deepEqual(restarted.findDownload(completed.id), completed);
        assert.deepEqual(restarted.findDownload(cancelled.id), cancelled);
        assert.equal(fs.readFileSync(completedPath, 'utf8'), 'complete');
        const persisted = storage.readJson(f.downloadsFile, []);
        assert.deepEqual(persisted, restarted.getDownloadsList());
        assert.deepEqual(f.events(interrupted.id), ['failed']);
        const secondRestart = f.createManager();
        assert.deepEqual(secondRestart.getDownloadsList(), persisted);
        assert.deepEqual(f.events(interrupted.id), ['failed']);
    });
});
