const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { URL } = require('url');

const PORT = parseInt(process.env.PORT || '18920', 10);
const HOST = process.env.HOST || '0.0.0.0';
const WWW_DIR = process.env.WWW_DIR || path.resolve(__dirname, '../www');
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '../../data');
const CACHE_DIR = process.env.CACHE_DIR || path.join(DATA_DIR, 'sessions');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(CACHE_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// 1. 本地持久化存储（书签 / 历史记录 / 设置）
// ---------------------------------------------------------------------------
const BOOKMARKS_FILE = path.join(DATA_DIR, 'bookmarks.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULT_BOOKMARKS = [
    { id: 'bm-1', title: '路由器后台', url: 'http://192.168.1.1', category: '内网设备', color: '#165DFF' },
    { id: 'bm-2', title: '光猫管理', url: 'http://192.168.1.1:8080', category: '内网设备', color: '#00B42A' },
    { id: 'bm-3', title: 'PVE / 虚拟化', url: 'https://192.168.1.2:8006', category: '内网设备', color: '#FF7D00' },
    { id: 'bm-4', title: '必应搜索', url: 'https://cn.bing.com', category: '常用网站', color: '#0FC6C2' },
    { id: 'bm-5', title: 'GitHub', url: 'https://github.com', category: '常用网站', color: '#24292F' },
    { id: 'bm-6', title: '哔哩哔哩', url: 'https://www.bilibili.com', category: '常用网站', color: '#FB7299' },
    { id: 'bm-7', title: '飞牛官网', url: 'https://www.fnnas.com', category: '飞牛生态', color: '#3491FA' }
];

const DEFAULT_SETTINGS = {
    searchEngine: 'bing',
    theme: 'system',
    homepageMode: 'dashboard',
    maxHistory: 200
};

function readJson(filePath, fallback) {
    try {
        if (!fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, JSON.stringify(fallback, null, 2), 'utf8');
            return JSON.parse(JSON.stringify(fallback));
        }
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
        return JSON.parse(JSON.stringify(fallback));
    }
}

function writeJson(filePath, data) {
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
}

// 初始化默认数据
readJson(BOOKMARKS_FILE, DEFAULT_BOOKMARKS);
readJson(HISTORY_FILE, []);
readJson(SETTINGS_FILE, DEFAULT_SETTINGS);

// ---------------------------------------------------------------------------
// 2. 加载代理内核：Scramjet（Mercury Workshop）+ Wisp 服务端
//    Scramjet 是纯前端拦截式内核：服务端只需 (a) 托管其静态资源
//    (b) 在 /wisp/ 上处理 WebSocket 升级（Wisp 协议负责实际出站连接）。
//    若依赖缺失则自动降级为内置轻量代理（engineMode = 'lite'）。
// ---------------------------------------------------------------------------
let engineMode = 'lite';
let sjAssetDirs = null; // { scramjet, controller, utils, epoxy } 绝对目录
let wispRouteRequest = null;

try {
    const { scramjetPath } = require('@mercuryworkshop/scramjet/path');
    const { controllerPath } = require('@mercuryworkshop/scramjet-controller/path');
    const utilsDir = path.dirname(require.resolve('@mercuryworkshop/scramjet-utils'));
    const epoxyDir = path.dirname(require.resolve('@mercuryworkshop/epoxy-transport'));
    const wispServer = require('@mercuryworkshop/wisp-js/server').server;
    if (typeof wispServer.routeRequest !== 'function') {
        throw new Error('wisp-js server routeRequest unavailable');
    }
    sjAssetDirs = {
        scramjet: scramjetPath,
        controller: controllerPath,
        utils: utilsDir,
        epoxy: epoxyDir
    };
    // Wisp 目标过滤策略：上游默认拒绝一切「私网/保留」段目标 IP，但在使用
    // fake-IP 模式 DNS（OpenWrt/Clash 等）的网络里，公网域名会被解析到
    // 198.18.0.0/15 保留段，默认策略会误杀全部外网站点。本应用是个人 NAS
    // 浏览器（轻量直连代理本就可达整个内网），故放行私网/保留段；
    // 回环与未指定地址（NAS 本机服务）仍保持拒绝。
    if (wispServer.options) {
        wispServer.options.allow_private_ips = true;
        wispServer.options.allow_loopback_ips = false;
    }
    wispRouteRequest = wispServer.routeRequest;
    engineMode = 'scramjet';
    console.log('[fn-browser] Scramjet 内核已就绪（静态资源 + Wisp 服务端）');
} catch (err) {
    console.log(`[fn-browser] 未检测到 Scramjet 依赖，启用内置零依赖轻量代理内核（${err.message}）`);
}

// Scramjet 静态资源挂载点（路径与 controller 默认配置保持一致）
//   /scramjet/scramjet.js, /scramjet/scramjet.wasm
//   /controller/controller.api.js, /controller/controller.inject.js, /controller/controller.sw.js
//   /utils/scramjet-utils.js
//   /epoxy/index.mjs
const SJ_MIME_TYPES = {
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

function serveFileFromDir(req, res, baseDir, relPath, extraHeaders) {
    const normalized = path.normalize(relPath).replace(/^(\.\.[\/\\])+/, '');
    const filePath = path.join(baseDir, normalized);
    if (!filePath.startsWith(baseDir)) {
        res.writeHead(403);
        return res.end('Forbidden');
    }
    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end('404 Not Found');
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, {
            'Content-Type': SJ_MIME_TYPES[ext] || 'application/octet-stream',
            ...(extraHeaders || {})
        });
        fs.createReadStream(filePath).pipe(res);
    });
}

// Scramjet 需要跨源隔离头（与官方接线指南一致），仅加在外壳与内核资源上，
// 不影响 /lite-proxy/ 的内网页面（它们可能引用局域网绝对地址资源）。
const CROSS_ORIGIN_ISOLATION_HEADERS = {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp'
};

function serveScramjetAsset(req, res, pathname) {
    if (!sjAssetDirs) return false;
    const mounts = [
        ['/scramjet/', sjAssetDirs.scramjet],
        ['/controller/', sjAssetDirs.controller],
        ['/utils/', sjAssetDirs.utils],
        ['/epoxy/', sjAssetDirs.epoxy]
    ];
    for (const [prefix, dir] of mounts) {
        if (pathname.startsWith(prefix)) {
            serveFileFromDir(req, res, dir, pathname.slice(prefix.length), CROSS_ORIGIN_ISOLATION_HEADERS);
            return true;
        }
    }
    return false;
}

// ---------------------------------------------------------------------------
// 3. 内置零依赖轻量反向代理（支持内网设备与常规网页无依赖直连）
// ---------------------------------------------------------------------------
function encodeLiteTarget(targetUrl) {
    return Buffer.from(targetUrl, 'utf8').toString('base64url');
}

function decodeLiteTarget(encoded) {
    return Buffer.from(encoded, 'base64url').toString('utf8');
}

function rewriteHtmlForLiteProxy(html, baseUrl) {
    const base = new URL(baseUrl);
    const wrapUrl = (raw) => {
        if (!raw || /^(data:|javascript:|mailto:|tel:|blob:|#)/i.test(raw.trim())) {
            return raw;
        }
        try {
            const resolved = new URL(raw.trim(), base).toString();
            return `/lite-proxy/${encodeLiteTarget(resolved)}`;
        } catch {
            return raw;
        }
    };

    // 注入导航状态同步脚本，通知外层浏览器地址栏更新 URL 与标题
    const bridgeScript = `
<script>
(function() {
  try {
    window.parent.postMessage({
      type: 'fn-browser-nav',
      url: ${JSON.stringify(baseUrl)},
      title: document.title || ${JSON.stringify(base.hostname)}
    }, '*');
    window.addEventListener('load', function() {
      window.parent.postMessage({
        type: 'fn-browser-nav',
        url: ${JSON.stringify(baseUrl)},
        title: document.title || ${JSON.stringify(base.hostname)}
      }, '*');
    });
  } catch (e) {}
})();
</script>`;

    let out = html
        .replace(/\b(href|src|action)\s*=\s*(["'])(.*?)\2/gi, (match, attr, quote, val) => {
            return `${attr}=${quote}${wrapUrl(val)}${quote}`;
        })
        .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote, val) => {
            return `url(${quote}${wrapUrl(val)}${quote})`;
        });

    if (/<\/head>/i.test(out)) {
        out = out.replace(/<\/head>/i, `${bridgeScript}</head>`);
    } else {
        out = bridgeScript + out;
    }
    return out;
}

function handleLiteProxy(req, res, encodedPart, extraSearch) {
    let targetUrl;
    try {
        targetUrl = decodeLiteTarget(encodedPart);
        if (extraSearch && !targetUrl.includes('?')) {
            targetUrl += extraSearch;
        }
    } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Invalid proxy target URL');
    }

    let parsed;
    try {
        parsed = new URL(targetUrl);
    } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Malformed target URL');
    }

    const client = parsed.protocol === 'https:' ? https : http;
    const headers = { ...req.headers };
    delete headers.host;
    delete headers['accept-encoding'];
    headers['host'] = parsed.host;
    headers['user-agent'] = headers['user-agent'] || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36';

    const proxyReq = client.request(
        {
            protocol: parsed.protocol,
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method: req.method,
            headers,
            rejectUnauthorized: false, // 允许访问自签名证书的内网设备（如 PVE / 路由器）
            timeout: 20000
        },
        (proxyRes) => {
            const resHeaders = { ...proxyRes.headers };
            delete resHeaders['x-frame-options'];
            delete resHeaders['content-security-policy'];
            delete resHeaders['content-security-policy-report-only'];
            delete resHeaders['strict-transport-security'];
            resHeaders['access-control-allow-origin'] = '*';

            // 处理 301/302 重定向
            if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode) && resHeaders.location) {
                try {
                    const nextUrl = new URL(resHeaders.location, parsed).toString();
                    resHeaders.location = `/lite-proxy/${encodeLiteTarget(nextUrl)}`;
                } catch {}
                res.writeHead(proxyRes.statusCode, resHeaders);
                return res.end();
            }

            const contentType = (resHeaders['content-type'] || '').toLowerCase();
            if (contentType.includes('text/html')) {
                delete resHeaders['content-length'];
                const chunks = [];
                proxyRes.on('data', (c) => chunks.push(c));
                proxyRes.on('end', () => {
                    const rawHtml = Buffer.concat(chunks).toString('utf8');
                    const rewritten = rewriteHtmlForLiteProxy(rawHtml, parsed.toString());
                    resHeaders['content-type'] = 'text/html; charset=utf-8';
                    res.writeHead(proxyRes.statusCode || 200, resHeaders);
                    res.end(rewritten);
                });
            } else {
                res.writeHead(proxyRes.statusCode || 200, resHeaders);
                proxyRes.pipe(res);
            }
        }
    );

    proxyReq.on('timeout', () => {
        proxyReq.destroy();
        if (!res.headersSent) {
            res.writeHead(504, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<h3>请求超时</h3><p>无法在规定时间内连接到：${parsed.toString()}</p>`);
        }
    });

    proxyReq.on('error', (err) => {
        if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<h3>连接目标站点失败</h3><p>${parsed.toString()}</p><pre>${err.message}</pre>`);
        }
    });

    req.pipe(proxyReq);
}

// ---------------------------------------------------------------------------
// 4. 静态资源与 REST API 路由
// ---------------------------------------------------------------------------
const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

function sendJson(res, status, payload) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
}

function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
            if (body.length > 1024 * 1024) {
                reject(new Error('Payload too large'));
            }
        });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (e) {
                reject(e);
            }
        });
        req.on('error', reject);
    });
}

async function handleApi(req, res, pathname) {
    // 系统状态与内核信息
    if (pathname === '/api/status' && req.method === 'GET') {
        return sendJson(res, 200, {
            ok: true,
            engine: engineMode,
            version: '1.0.2',
            uptime: Math.floor(process.uptime()),
            memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024)
        });
    }

    // 书签管理
    if (pathname === '/api/bookmarks') {
        if (req.method === 'GET') {
            return sendJson(res, 200, readJson(BOOKMARKS_FILE, DEFAULT_BOOKMARKS));
        }
        if (req.method === 'POST') {
            const data = await parseBody(req);
            const list = readJson(BOOKMARKS_FILE, DEFAULT_BOOKMARKS);
            const item = {
                id: `bm-${Date.now()}`,
                title: String(data.title || '未命名网页').slice(0, 40),
                url: String(data.url || '').trim(),
                category: String(data.category || '常用网站').slice(0, 20),
                color: String(data.color || '#165DFF')
            };
            if (!item.url) return sendJson(res, 400, { error: 'URL is required' });
            list.push(item);
            writeJson(BOOKMARKS_FILE, list);
            return sendJson(res, 201, item);
        }
    }

    if (pathname.startsWith('/api/bookmarks/') && req.method === 'DELETE') {
        const id = decodeURIComponent(pathname.slice('/api/bookmarks/'.length));
        const list = readJson(BOOKMARKS_FILE, DEFAULT_BOOKMARKS).filter((b) => b.id !== id);
        writeJson(BOOKMARKS_FILE, list);
        return sendJson(res, 200, { ok: true });
    }

    // 历史记录管理
    if (pathname === '/api/history') {
        if (req.method === 'GET') {
            return sendJson(res, 200, readJson(HISTORY_FILE, []));
        }
        if (req.method === 'POST') {
            const data = await parseBody(req);
            if (!data.url || data.url.startsWith('fn://')) {
                return sendJson(res, 200, { ok: true });
            }
            const settings = readJson(SETTINGS_FILE, DEFAULT_SETTINGS);
            let list = readJson(HISTORY_FILE, []);
            list = list.filter((h) => h.url !== data.url);
            list.unshift({
                id: `his-${Date.now()}`,
                title: String(data.title || data.url).slice(0, 80),
                url: String(data.url),
                visitedAt: new Date().toISOString()
            });
            if (list.length > (settings.maxHistory || 200)) {
                list = list.slice(0, settings.maxHistory || 200);
            }
            writeJson(HISTORY_FILE, list);
            return sendJson(res, 201, { ok: true });
        }
        if (req.method === 'DELETE') {
            writeJson(HISTORY_FILE, []);
            return sendJson(res, 200, { ok: true });
        }
    }

    // 浏览器设置
    if (pathname === '/api/settings') {
        if (req.method === 'GET') {
            return sendJson(res, 200, readJson(SETTINGS_FILE, DEFAULT_SETTINGS));
        }
        if (req.method === 'PUT') {
            const patch = await parseBody(req);
            const current = readJson(SETTINGS_FILE, DEFAULT_SETTINGS);
            const updated = { ...current, ...patch };
            writeJson(SETTINGS_FILE, updated);
            return sendJson(res, 200, updated);
        }
    }

    return sendJson(res, 404, { error: 'API route not found' });
}

function serveStatic(req, res, pathname) {
    let relPath = pathname === '/' ? '/index.html' : pathname;
    relPath = path.normalize(relPath).replace(/^(\.\.[\/\\])+/, '');
    const filePath = path.join(WWW_DIR, relPath);

    if (!filePath.startsWith(WWW_DIR)) {
        res.writeHead(403);
        return res.end('Forbidden');
    }

    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end('404 Not Found');
        }
        const ext = path.extname(filePath).toLowerCase();
        const headers = { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' };
        // 浏览器外壳页需要跨源隔离头以启用 Scramjet 的完整能力
        if (relPath === '/index.html') {
            Object.assign(headers, CROSS_ORIGIN_ISOLATION_HEADERS);
        }
        res.writeHead(200, headers);
        fs.createReadStream(filePath).pipe(res);
    });
}

// ---------------------------------------------------------------------------
// 5. 统一 HTTP & WebSocket 入口
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
    try {
        const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const pathname = parsedUrl.pathname;

        // Scramjet 服务工作线程（必须位于站点根路径以获得全局 scope）
        if (pathname === '/sw.js') {
            return serveFileFromDir(req, res, WWW_DIR, 'sw.js', {
                'Cache-Control': 'no-cache',
                ...CROSS_ORIGIN_ISOLATION_HEADERS
            });
        }

        // Scramjet 内核静态资源
        if (serveScramjetAsset(req, res, pathname)) {
            return;
        }

        // 内置轻量代理路由
        if (pathname.startsWith('/lite-proxy/')) {
            const encoded = pathname.slice('/lite-proxy/'.length);
            return handleLiteProxy(req, res, encoded, parsedUrl.search);
        }

        // REST API 路由
        if (pathname.startsWith('/api/')) {
            return await handleApi(req, res, pathname);
        }

        // 浏览器外壳静态资源
        return serveStatic(req, res, pathname);
    } catch (err) {
        console.error('[fn-browser] Request error:', err);
        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Internal Server Error');
        }
    }
});

// WebSocket 升级入口：/wisp/ 交给 Wisp 服务端（Scramjet 的出站传输通道）
server.on('upgrade', (req, socket, head) => {
    try {
        const pathname = new URL(req.url || '/', 'http://localhost').pathname;
        if (pathname === '/wisp/' && wispRouteRequest) {
            req.url = pathname;
            return wispRouteRequest(req, socket, head);
        }
    } catch (err) {
        console.error('[fn-browser] WebSocket upgrade error:', err);
    }
    socket.destroy();
});

server.listen(PORT, HOST, () => {
    console.log(`[fn-browser] 飞牛原生浏览器已启动: http://${HOST}:${PORT} (内核: ${engineMode})`);
});
