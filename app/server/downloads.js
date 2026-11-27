const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { URL } = require('url');

function sanitizeFilename(name) {
    const cleaned = String(name || '')
        .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
        .replace(/^\.+/, '')
        .trim();
    return cleaned.slice(0, 180) || `download-${Date.now()}`;
}

function filenameFromDisposition(headerVal) {
    if (!headerVal) return '';
    const utf8Match = /filename\*\s*=\s*(?:UTF-8''|utf-8'')([^;]+)/i.exec(headerVal);
    if (utf8Match) {
        try {
            return sanitizeFilename(decodeURIComponent(utf8Match[1].trim().replace(/^["']|["']$/g, '')));
        } catch {}
    }
    const plainMatch = /filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/i.exec(headerVal);
    if (plainMatch) {
        return sanitizeFilename((plainMatch[1] || plainMatch[2] || '').trim());
    }
    return '';
}

function reserveDownloadFile(dir, filename) {
    const ext = path.extname(filename);
    const base = ext ? filename.slice(0, -ext.length) : filename;
    for (let idx = 0; ; idx += 1) {
        const candidate = path.join(dir, idx ? `${base} (${idx})${ext}` : filename);
        if (fs.existsSync(candidate)) continue;
        const tmpPath = `${candidate}.part`;
        try {
            // Reserve before creating the stream so concurrent downloads cannot share a part file.
            const fd = fs.openSync(tmpPath, 'wx');
            return { finalPath: candidate, tmpPath, fd };
        } catch (err) {
            if (err.code !== 'EEXIST') throw err;
        }
    }
}

function createDownloadManager({
    downloadsFile,
    defaultDownloadDir,
    readJson,
    writeJson,
    isDirWritable,
    connectTimeoutMs = 30_000,
    stallTimeoutMs = 60_000
}) {
    for (const timeout of [connectTimeoutMs, stallTimeoutMs]) {
        if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2_147_483_647) {
            throw new Error('下载超时必须是有效的正毫秒数');
        }
    }
    const activeDownloads = new Map();
    const terminalPatches = new Map();
    let recordsErrorReported = false;
    function readDownloadRecords(strict = false) {
        const records = readJson(downloadsFile, []);
        const valid = Array.isArray(records) && records.every((item) => (
            item !== null && typeof item === 'object' && !Array.isArray(item)
        ));
        if (valid) {
            recordsErrorReported = false;
            return records.map((item) => {
                const patch = terminalPatches.get(item.id);
                return patch && item.status === 'downloading' && !activeDownloads.has(item.id)
                    ? { ...item, ...patch }
                    : item;
            });
        }
        const err = new Error('下载记录文件格式异常，已保留原文件，请修复后重试');
        err.code = 'DOWNLOADS_CORRUPT';
        if (!recordsErrorReported) {
            console.error(err.message, downloadsFile);
            recordsErrorReported = true;
        }
        // Keep read APIs and service startup available, but never overwrite an invalid store.
        if (strict) throw err;
        return [];
    }
    function writeDownloadRecords(records) {
        writeJson(downloadsFile, records);
        // Every normal write includes pending terminal patches (or intentionally removes the record).
        terminalPatches.clear();
    }
    const savedDownloads = readDownloadRecords();
    let recovered = false;
    const recoveredDownloads = savedDownloads.map((item) => {
        if (item.status !== 'downloading') return item;
        recovered = true;
        if (item.filePath) {
            try { fs.unlinkSync(`${item.filePath}.part`); } catch {}
        }
        const patch = {
            status: 'failed',
            speedBps: 0,
            error: '下载因服务重启而中断',
            finishedAt: new Date().toISOString()
        };
        terminalPatches.set(item.id, patch);
        return { ...item, ...patch };
    });
    if (recovered) {
        try {
            writeDownloadRecords(recoveredDownloads);
        } catch (err) {
            // Keep terminal patches in memory; later normal writes can persist them.
            console.error('保存启动下载恢复状态失败，暂用内存状态:', err.code || '', err.message);
        }
    }

    function getFnOsRoots() {
        const roots = [];
        const seen = new Set();
        const pushRoot = (p, label) => {
            const resolved = path.resolve(p);
            if (seen.has(resolved)) return;
            try {
                if (!fs.statSync(resolved).isDirectory()) return;
            } catch {
                return;
            }
            seen.add(resolved);
            roots.push({ path: resolved, label, writable: isDirWritable(resolved) });
        };

        pushRoot(defaultDownloadDir, '默认下载目录 (应用数据)');
        const sharePaths = String(process.env.TRIM_DATA_SHARE_PATHS || '')
            .split(':')
            .map((s) => s.trim())
            .filter(Boolean);
        sharePaths.forEach((p, idx) => pushRoot(p, `飞牛授权目录${sharePaths.length > 1 ? ` ${idx + 1}` : ''}`));

        for (let i = 1; i <= 9; i++) {
            pushRoot(`/vol${i}`, `存储空间 ${i} (/vol${i})`);
        }
        pushRoot('/mnt', '挂载目录 (/mnt)');
        return roots;
    }

    function listDir(rawDir) {
        const target = path.resolve(rawDir || defaultDownloadDir);
        try {
            const entries = fs.readdirSync(target, { withFileTypes: true });
            const dirs = entries
                .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
                .map((e) => {
                    const full = path.join(target, e.name);
                    return { name: e.name, path: full, writable: isDirWritable(full) };
                })
                .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
            const parent = path.dirname(target);
            return {
                ok: true,
                dir: target,
                parent: parent !== target ? parent : null,
                writable: isDirWritable(target),
                dirs
            };
        } catch (err) {
            if (err && (err.code === 'EACCES' || err.code === 'EPERM')) {
                const probeDirs = [];
                const seenProbe = new Set();
                const tryProbe = (p, label) => {
                    const resolved = path.resolve(p);
                    if (seenProbe.has(resolved)) return;
                    if (resolved !== target && !resolved.startsWith(target + path.sep) && target !== '/') return;
                    try {
                        if (fs.statSync(resolved).isDirectory()) {
                            seenProbe.add(resolved);
                            probeDirs.push({
                                name: label || path.basename(resolved) || resolved,
                                path: resolved,
                                writable: isDirWritable(resolved)
                            });
                        }
                    } catch {}
                };
                String(process.env.TRIM_DATA_SHARE_PATHS || '')
                    .split(':')
                    .map((s) => s.trim())
                    .filter(Boolean)
                    .forEach((p) => tryProbe(p));
                tryProbe(path.join(target, '1000'), '1000 (默认用户目录)');
                tryProbe(path.join(target, '1000', 'Downloads'), '1000/Downloads');
                tryProbe(path.join(target, '1000', 'Download'), '1000/Download');

                const parent = path.dirname(target);
                return {
                    ok: true,
                    dir: target,
                    parent: parent !== target ? parent : null,
                    writable: false,
                    restricted: true,
                    code: 'EACCES_SHARE_PATH',
                    dirs: probeDirs
                };
            }
            return { ok: false, error: `无法读取目录: ${err.message}` };
        }
    }

    function makeDir(parentRaw, nameRaw) {
        const parent = path.resolve(String(parentRaw || defaultDownloadDir));
        const name = sanitizeFilename(nameRaw || '');
        if (!name) return { ok: false, error: '请输入文件夹名称' };
        const target = path.join(parent, name);
        try {
            fs.mkdirSync(target, { recursive: true });
            return { ok: true, path: target, name, writable: isDirWritable(target) };
        } catch (err) {
            const code = err && (err.code === 'EACCES' || err.code === 'EPERM') ? 'EACCES_SHARE_PATH' : 'MKDIR_FAILED';
            return { ok: false, code, error: `创建失败: ${err.message}` };
        }
    }

    function getDownloadsList() {
        const saved = readDownloadRecords();
        return saved.map((item) => {
            const active = activeDownloads.get(item.id);
            if (active) {
                return {
                    ...item,
                    status: 'downloading',
                    receivedBytes: active.receivedBytes,
                    totalBytes: active.totalBytes,
                    speedBps: active.speedBps
                };
            }
            return item;
        });
    }

    function updateDownloadRecord(id, patch) {
        const list = readDownloadRecords(true);
        const idx = list.findIndex((d) => d.id === id);
        if (idx === -1) return;
        list[idx] = { ...list[idx], ...patch };
        writeDownloadRecords(list);
    }

    function startNasDownload(rawUrl, preferredName, targetDir) {
        let parsed;
        try {
            parsed = new URL(String(rawUrl || '').trim());
        } catch {
            throw new Error('无效的下载地址');
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error('仅支持 http / https 下载地址');
        }
        const list = readDownloadRecords(true);

        const dir = path.resolve(targetDir || defaultDownloadDir);
        fs.mkdirSync(dir, { recursive: true });
        if (!isDirWritable(dir)) {
            const err = new Error('目标目录不可写，请在飞牛「应用设置 -> 文件夹权限」中授权该目录');
            err.code = 'EACCES_SHARE_PATH';
            throw err;
        }

        let fallbackName = preferredName ? sanitizeFilename(preferredName) : '';
        if (!fallbackName) {
            try {
                const base = path.basename(decodeURIComponent(parsed.pathname));
                if (base && base !== '/') fallbackName = sanitizeFilename(base);
            } catch {}
        }
        if (!fallbackName) fallbackName = `download-${Date.now()}`;

        const id = `dl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const record = {
            id,
            url: parsed.href,
            filename: fallbackName,
            dir,
            filePath: '',
            status: 'downloading',
            receivedBytes: 0,
            totalBytes: 0,
            speedBps: 0,
            error: '',
            createdAt: new Date().toISOString()
        };

        list.unshift(record);
        if (list.length > 100) list.length = 100;
        writeDownloadRecords(list);

        const stateObj = {
            hop: null,
            stream: null,
            tmpPath: '',
            terminal: false,
            receivedBytes: 0,
            totalBytes: 0,
            speedBps: 0,
            lastBytes: 0,
            lastTick: Date.now()
        };
        activeDownloads.set(id, stateObj);

        const stopHop = () => {
            const hop = stateObj.hop;
            stateObj.hop = null;
            if (!hop) return;
            clearTimeout(hop.connectTimer);
            clearTimeout(hop.stallTimer);
            if (hop.resp) {
                hop.resp.unpipe();
                hop.resp.destroy();
            }
            if (hop.req) hop.req.destroy();
        };

        // Claim the outcome before destroying anything: destroy() emits more error/close events.
        const finish = (status, error = '') => {
            if (stateObj.terminal) return;
            stateObj.terminal = true;
            stopHop();
            const persist = () => {
                if (stateObj.tmpPath) {
                    try {
                        fs.unlinkSync(stateObj.tmpPath);
                    } catch (err) {
                        if (err.code !== 'ENOENT') error = `${error}${error ? '; ' : ''}临时文件清理失败: ${err.message}`;
                    }
                    stateObj.tmpPath = '';
                }
                const patch = {
                    status,
                    error,
                    receivedBytes: stateObj.receivedBytes,
                    totalBytes: status === 'completed' ? stateObj.receivedBytes : stateObj.totalBytes,
                    speedBps: 0,
                    finishedAt: new Date().toISOString()
                };
                try {
                    updateDownloadRecord(id, patch);
                } catch (err) {
                    terminalPatches.set(id, patch);
                    console.error('保存下载状态失败，暂用内存状态:', err.code || '', err.message);
                } finally {
                    activeDownloads.delete(id);
                }
            };
            const ws = stateObj.stream;
            if (ws && !ws.closed) {
                // Windows cannot unlink an open file; also wait for pending writes to release it.
                ws.once('close', persist);
                ws.destroy();
            } else {
                persist();
            }
        };
        stateObj.finish = finish;

        const fetchUrl = (currentUrl, redirectsLeft) => {
            if (stateObj.terminal) return;
            let u;
            try {
                u = new URL(currentUrl);
                if (u.protocol !== 'http:' && u.protocol !== 'https:') {
                    return finish('failed', '仅支持 http / https 下载地址');
                }
            } catch {
                return finish('failed', '重定向地址无效');
            }
            stopHop();
            const hop = { req: null, resp: null, connectTimer: null, stallTimer: null };
            stateObj.hop = hop;
            const isCurrent = () => !stateObj.terminal && stateObj.hop === hop;
            const fail = (err) => {
                if (isCurrent()) finish('failed', err.message);
            };
            const resetStallTimer = () => {
                clearTimeout(hop.stallTimer);
                hop.stallTimer = setTimeout(() => {
                    if (isCurrent()) finish('failed', '下载传输停滞超时');
                }, stallTimeoutMs);
            };
            hop.connectTimer = setTimeout(() => {
                if (isCurrent()) finish('failed', '下载连接或响应超时');
            }, connectTimeoutMs);

            try {
                const mod = u.protocol === 'https:' ? https : http;
                const req = mod.get(u, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AuroraBrowser/1.0' }
                }, (resp) => {
                    // Keep an error listener even on discarded hops so a late socket error is harmless.
                    resp.on('error', fail);
                    if (!isCurrent()) {
                        resp.destroy();
                        return;
                    }
                    hop.resp = resp;
                    clearTimeout(hop.connectTimer);
                    resp.on('aborted', () => fail(new Error('下载响应被中断')));
                    resp.on('close', () => {
                        if (!resp.complete) fail(new Error('下载响应提前关闭'));
                    });

                    if ([301, 302, 303, 307, 308].includes(resp.statusCode)) {
                        if (!resp.headers.location) return finish('failed', '重定向缺少目标地址');
                        if (redirectsLeft <= 0) return finish('failed', '重定向次数过多');
                        let nextUrl;
                        try {
                            nextUrl = new URL(resp.headers.location, u).href;
                        } catch {
                            return finish('failed', '重定向地址无效');
                        }
                        return fetchUrl(nextUrl, redirectsLeft - 1);
                    }
                    if (resp.statusCode < 200 || resp.statusCode >= 300) {
                        return finish('failed', `HTTP ${resp.statusCode}`);
                    }
                    if (resp.statusCode === 206 || resp.headers['content-range'] !== undefined) {
                        return finish('failed', '未请求分段下载，拒绝部分响应 (206 / Content-Range)');
                    }

                    let expectedLength = null;
                    const lengthHeader = resp.headers['content-length'];
                    if (lengthHeader !== undefined) {
                        expectedLength = Number(lengthHeader);
                        if (!/^\d+$/.test(lengthHeader) || !Number.isSafeInteger(expectedLength)) {
                            return finish('failed', '无效的 Content-Length');
                        }
                    }
                    stateObj.totalBytes = expectedLength === null ? 0 : expectedLength;
                    let ws;
                    let finalPath;
                    try {
                        const finalName = filenameFromDisposition(resp.headers['content-disposition']) || fallbackName;
                        const reserved = reserveDownloadFile(dir, finalName);
                        finalPath = reserved.finalPath;
                        stateObj.tmpPath = reserved.tmpPath;
                        try {
                            ws = fs.createWriteStream(reserved.tmpPath, { fd: reserved.fd });
                        } catch (err) {
                            fs.closeSync(reserved.fd);
                            throw err;
                        }
                        stateObj.stream = ws;
                        // Attach before persistence, which can fail and destroy the stream as well.
                        ws.on('error', fail);
                        updateDownloadRecord(id, {
                            filename: path.basename(finalPath),
                            filePath: finalPath,
                            totalBytes: stateObj.totalBytes
                        });
                    } catch (err) {
                        return finish('failed', err.message);
                    }

                    let responseEnded = false;
                    let streamFinished = false;
                    resp.on('data', (chunk) => {
                        if (!isCurrent()) return;
                        stateObj.receivedBytes += chunk.length;
                        resetStallTimer();
                        if (expectedLength !== null && stateObj.receivedBytes > expectedLength) {
                            return finish('failed', '下载长度与 Content-Length 不符');
                        }
                        const now = Date.now();
                        const dt = now - stateObj.lastTick;
                        if (dt >= 500) {
                            stateObj.speedBps = Math.round(((stateObj.receivedBytes - stateObj.lastBytes) * 1000) / dt);
                            stateObj.lastBytes = stateObj.receivedBytes;
                            stateObj.lastTick = now;
                        }
                    });
                    resp.on('end', () => {
                        if (!isCurrent()) return;
                        responseEnded = true;
                        if (!resp.complete || (expectedLength !== null && stateObj.receivedBytes !== expectedLength)) {
                            finish('failed', '下载响应不完整或长度与 Content-Length 不符');
                        }
                    });
                    ws.on('finish', () => { streamFinished = true; });
                    ws.on('close', () => {
                        if (!isCurrent()) return;
                        if (!streamFinished || !responseEnded || !resp.complete) {
                            return finish('failed', '下载文件提前关闭');
                        }
                        try {
                            if (fs.existsSync(finalPath)) throw new Error('目标文件已存在');
                            fs.renameSync(stateObj.tmpPath, finalPath);
                            stateObj.tmpPath = '';
                            finish('completed');
                        } catch (err) {
                            finish('failed', err.message);
                        }
                    });
                    resetStallTimer();
                    resp.pipe(ws);
                });
                hop.req = req;
                req.on('error', fail);
            } catch (err) {
                fail(err);
            }
        };

        fetchUrl(parsed.href, 5);
        return record;
    }

    function cancelDownload(id) {
        const active = activeDownloads.get(id);
        if (active) active.finish('cancelled');
    }

    function clearFinished() {
        const remaining = readDownloadRecords(true).filter((d) => activeDownloads.has(d.id));
        writeDownloadRecords(remaining);
    }

    function deleteDownload(id, deleteFile) {
        cancelDownload(id);
        const list = readDownloadRecords(true);
        const item = list.find((d) => d.id === id);
        if (item && deleteFile && item.filePath) {
            try { fs.unlinkSync(item.filePath); } catch {}
        }
        writeDownloadRecords(list.filter((d) => d.id !== id));
    }

    function findDownload(id) {
        return readDownloadRecords().find((d) => d.id === id);
    }

    return {
        getFnOsRoots,
        listDir,
        makeDir,
        getDownloadsList,
        startNasDownload,
        cancelDownload,
        clearFinished,
        deleteDownload,
        findDownload
    };
}

module.exports = { createDownloadManager };
