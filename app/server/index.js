const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { URL } = require('url');

// Version comes from the package manifest so it never drifts from the FPK.
const APP_VERSION = (() => {
    try {
        const manifest = fs.readFileSync(path.resolve(__dirname, '../../manifest'), 'utf8');
        const line = manifest.split(/\r?\n/).find((l) => /^version\s*=/.test(l));
        return line ? line.split('=')[1].trim() : '1.0.2';
    } catch {
        return '1.0.2';
    }
})();

// Optional shared secret. When set, the API, the lite proxy and the Wisp
// upgrade endpoint all require it. The shell page stays public so the token
// can be supplied once via ?_aurora_token=... and cached in sessionStorage.
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
const TOKEN_PARAM = '_aurora_token';

function isAuthorized(req, parsedUrl) {
    if (!AUTH_TOKEN) return true;
    const headerToken = req.headers['x-aurora-token'];
    const queryToken = parsedUrl && parsedUrl.searchParams
        ? parsedUrl.searchParams.get(TOKEN_PARAM)
        : null;
    return headerToken === AUTH_TOKEN || queryToken === AUTH_TOKEN;
}

// Rammerhead 路由与轻量代理执行同一套令牌保护（X-Aurora-Token 头或
// ?_aurora_token= 参数）；但其帧内子请求（脚本/图片/XHR 的地址由
// hammerhead 在服务端改写）无法携带头或参数，故额外接受外壳在同源下
// 种的 aurora_token cookie 作为凭据（与该内核自用的 origin_proxy
// cookie 是同一模式）。
function isRhAuthorized(req, parsedUrl) {
    if (!AUTH_TOKEN) return true;
    if (isAuthorized(req, parsedUrl)) return true;
    const match = /(?:^|;\s*)aurora_token=([^;]+)/.exec(req.headers.cookie || '');
    if (!match) return false;
    try {
        return decodeURIComponent(match[1]) === AUTH_TOKEN;
    } catch {
        return match[1] === AUTH_TOKEN;
    }
}

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
    { id: 'bm-1', title: '必应搜索', url: 'https://cn.bing.com', category: '常用网站', color: '#0FC6C2' },
    { id: 'bm-2', title: 'Bilibili', url: 'https://www.bilibili.com', category: '常用网站', color: '#FB7299' },
    { id: 'bm-3', title: 'GitHub', url: 'https://github.com', category: '常用网站', color: '#24292F' },
    { id: 'bm-4', title: 'OpenAI', url: 'https://openai.com', category: '常用网站', color: '#10A37F' },
    { id: 'bm-5', title: 'Gemini', url: 'https://gemini.google.com', category: '常用网站', color: '#4796E3' },
    { id: 'bm-6', title: 'Muse', url: 'https://muse.ai', category: '常用网站', color: '#7B61FF' }
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

// ---------------------------------------------------------------------------
// 2b. Rammerhead 内核（@rubynetwork/rammerhead 1.3.x，Ruby Network 维护版）
//     服务端会话式代理：不依赖 Service Worker，专供以 HTTP（非安全上下文）
//     打开应用时的外网页面；HTTPS 下仍由 Scramjet 担任主内核，内网地址
//     始终走轻量直连。其作用域位于站点根路径（/newsession、/messaging、
//     /<32 位会话 id>/... 等），与 /wisp/、/scramjet/ 等路径互不重叠。
//     依赖缺失或初始化失败时仅回退轻量代理，绝不阻断应用启动。
// ---------------------------------------------------------------------------
let rhAvailable = false;
let rhCore = null; // { instance, shouldRouteRh, routeRhRequest, routeRhUpgrade }
const RH_SESSION_DIR = path.join(DATA_DIR, 'rammerhead-sessions');
fs.mkdirSync(RH_SESSION_DIR, { recursive: true });

// Rammerhead 页面桥接脚本：hammerhead 会把 target=_blank / window.open 的
// 新窗口导航虚拟化成真实浏览器窗口，在外壳 iframe 里表现为「弹出一个裸
// 会话地址的独立窗口」。本脚本经会话的 injectable.scripts 注入每个被
// 代理页面（脚本地址由本服务在站点根路径直接提供，见下方路由），在捕
// 获阶段拦截新窗口手势并 postMessage 通知外壳改开新标签页。
const RH_BRIDGE_SCRIPT_PATH = '/aurora-rh-bridge.js';
const RH_BRIDGE_SCRIPT = `/* aurora-rh-bridge */
(function () {
  if (window.__auroraRhBridge) return;
  window.__auroraRhBridge = true;

  function reportOpen(url) {
    try {
      var target = window.parent && window.parent !== window ? window.parent : window.top;
      target.postMessage({ source: 'fn-browser-rh', type: 'open', url: String(url) }, '*');
    } catch (e) {}
  }

  function popupAnchor(e) {
    var t = e.target;
    var a = t && t.closest ? t.closest('a[href], area[href]') : null;
    if (!a) return null;
    var raw = a.getAttribute('href') || '';
    if (/^(javascript:|data:|blob:|mailto:|tel:|#)/i.test(raw)) return null;
    var targetAttr = (a.getAttribute('target') || '').toLowerCase();
    if (targetAttr === '_blank' || e.button === 1 || e.ctrlKey || e.metaKey) return a;
    return null;
  }

  document.addEventListener(
    'click',
    function (e) {
      var a = popupAnchor(e);
      if (!a) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      if (a.href) reportOpen(a.href);
    },
    true
  );

  var nativeOpen = window.open;
  try {
    window.open = function (url) {
      if (url != null && String(url) !== '') {
        var resolved = String(url);
        try {
          resolved = new URL(resolved, window.location.href).href;
        } catch (err) {}
        reportOpen(resolved);
        return null;
      }
      return nativeOpen ? nativeOpen.apply(window, arguments) : null;
    };
  } catch (e) {}
})();
`;

function shouldRouteRhSafe(req) {
    if (!rhAvailable || !rhCore) return false;
    try {
        return rhCore.shouldRouteRh(req);
    } catch {
        return false;
    }
}

const rhReady = (async () => {
    try {
        // 必须先于 createRammerhead 改写 @rubynetwork/rh 的默认配置：
        //  - 会话文件默认写进包内 node_modules 目录，改为落盘 DATA_DIR，
        //    避免应用升级覆盖或目录只读导致会话不可用；
        //  - JS 重写磁盘缓存默认写在包内且上限 5GB，改为 64MB 内存缓存；
        //  - 默认 getServerInfo 缺 cookie 时硬编码 https 协议且会把整个
        //    socket 对象打进日志，改为「origin_proxy cookie 优先（外壳种下
        //    的真实源）、Host 头推导兜底」。
        const rhConfig = (await import('@rubynetwork/rh/src/config.js')).default;
        const { default: RammerheadJSMemCache } = await import(
            '@rubynetwork/rh/src/classes/RammerheadJSMemCache.js'
        );
        rhConfig.jsCache = new RammerheadJSMemCache(64 * 1024 * 1024);
        rhConfig.fileCacheSessionConfig.saveDirectory = RH_SESSION_DIR;
        rhConfig.getServerInfo = (req) => {
            let origin = null;
            try {
                const match = /(?:^|;\s*)origin_proxy=([^;]+)/.exec(req.headers.cookie || '');
                if (match) origin = new URL(decodeURIComponent(match[1]));
            } catch {}
            if (!origin) {
                try {
                    origin = new URL(`http://${req.headers.host || 'localhost'}`);
                } catch {}
            }
            if (!origin) {
                return { hostname: 'localhost', port: '', crossDomainPort: '', protocol: 'http:' };
            }
            return {
                hostname: origin.hostname,
                port: origin.port,
                crossDomainPort: origin.port,
                protocol: origin.protocol
            };
        };

        // 把桥接脚本挂进每个会话的 injectable.scripts（hammerhead 会在
        // 每个被代理页面的 <head> 里按顺序注入这些脚本）。会话在本进程
        // 内的唯一物化入口是 RammerheadSession.DeserializeSession：
        // /newsession 经 addSerializedSession、磁盘恢复经 FileCache.get，
        // 都 funnel 过它。在此包装一层，会话（含旧版本已落盘的）都会带上
        // 桥接脚本；includes 去重，重复反序列化不会叠加。
        const { default: RammerheadSession } = await import(
            '@rubynetwork/rh/src/classes/RammerheadSession.js'
        );
        const origDeserializeSession = RammerheadSession.DeserializeSession;
        if (typeof origDeserializeSession === 'function' && !origDeserializeSession.__auroraBridgePatched) {
            const patchedDeserializeSession = function (id, serializedSession) {
                const session = origDeserializeSession.call(this, id, serializedSession);
                try {
                    const scripts = session && session.injectable && session.injectable.scripts;
                    if (Array.isArray(scripts) && !scripts.includes(RH_BRIDGE_SCRIPT_PATH)) {
                        scripts.push(RH_BRIDGE_SCRIPT_PATH);
                    }
                } catch {}
                return session;
            };
            patchedDeserializeSession.__auroraBridgePatched = true;
            RammerheadSession.DeserializeSession = patchedDeserializeSession;
        }

        const rhPkg = await import('@rubynetwork/rammerhead');
        const instance = rhPkg.createRammerhead({
            logLevel: 'warn',
            reverseProxy: false,
            disableLocalStorageSync: false,
            disableHttp2: false
        });
        rhCore = {
            instance,
            shouldRouteRh: rhPkg.shouldRouteRh,
            routeRhRequest: rhPkg.routeRhRequest,
            routeRhUpgrade: rhPkg.routeRhUpgrade
        };
        rhAvailable = true;
        console.log(`[fn-browser] Rammerhead 内核已就绪（HTTP 模式外网代理，会话目录: ${RH_SESSION_DIR}）`);
    } catch (err) {
        console.log(`[fn-browser] Rammerhead 内核不可用，HTTP 模式继续使用轻量代理（${err.message}）`);
    }
})();

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

function stripTokenFromSearch(search) {
    if (!search) return '';
    try {
        const params = new URLSearchParams(search);
        params.delete(TOKEN_PARAM);
        const rest = params.toString();
        return rest ? `?${rest}` : '';
    } catch {
        return '';
    }
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
    var tabId = (window.name || '').replace(/^aurora-/, '');
    window.parent.postMessage({
      type: 'fn-browser-nav',
      tabId: tabId,
      url: ${JSON.stringify(baseUrl)},
      title: document.title || ${JSON.stringify(base.hostname)}
    }, window.location.origin);
    window.addEventListener('load', function() {
      window.parent.postMessage({
        type: 'fn-browser-nav',
        tabId: tabId,
        url: ${JSON.stringify(baseUrl)},
        title: document.title || ${JSON.stringify(base.hostname)}
      }, window.location.origin);
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
        const cleanSearch = stripTokenFromSearch(extraSearch);
        if (cleanSearch && !targetUrl.includes('?')) {
            targetUrl += cleanSearch;
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
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Unsupported target protocol');
    }

    const client = parsed.protocol === 'https:' ? https : http;
    const headers = { ...req.headers };
    delete headers.host;
    delete headers['accept-encoding'];
    // Never forward the caller's credentials to an arbitrary target site.
    delete headers.cookie;
    delete headers.authorization;
    delete headers['proxy-authorization'];
    delete headers[TOKEN_PARAM];
    delete headers['x-aurora-token'];
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

    proxyReq.on('error', () => {
        if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<h3>连接目标站点失败</h3><p>请检查目标地址是否可达，或目标站点是否拒绝代理访问。</p>');
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

async function handleApi(req, res, pathname, parsedUrl) {
    if (!isAuthorized(req, parsedUrl)) {
        return sendJson(res, 401, { error: 'Unauthorized' });
    }

    // 系统状态与内核信息
    if (pathname === '/api/status' && req.method === 'GET') {
        // 等待 Rammerhead 初始化收敛（其 Promise 永不 reject），避免外壳在
        // 启动瞬间误判该内核不可用
        await rhReady;
        return sendJson(res, 200, {
            ok: true,
            engine: engineMode,
            rammerhead: rhAvailable,
            version: APP_VERSION,
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

        // Rammerhead 页面桥接脚本（被注入的代理页面从站点根路径取用；
        // 内容为静态脚本、无任何密钥，与外壳页同级公开提供）
        if (pathname === RH_BRIDGE_SCRIPT_PATH) {
            res.writeHead(200, {
                'Content-Type': 'application/javascript; charset=utf-8',
                'Cache-Control': 'no-cache'
            });
            return res.end(RH_BRIDGE_SCRIPT);
        }

        // Scramjet 内核静态资源
        if (serveScramjetAsset(req, res, pathname)) {
            return;
        }

        // Rammerhead 内核路由（根路径作用域，必须先于 /api/ 判断，
        // 因为其作用域包含 /api/shuffleDict）
        if (shouldRouteRhSafe(req)) {
            if (!isRhAuthorized(req, parsedUrl)) {
                res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
                return res.end('Unauthorized');
            }
            return rhCore.routeRhRequest(rhCore.instance, req, res);
        }

        // 内置轻量代理路由
        if (pathname.startsWith('/lite-proxy/')) {
            if (!isAuthorized(req, parsedUrl)) {
                res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
                return res.end('Unauthorized');
            }
            const encoded = pathname.slice('/lite-proxy/'.length);
            return handleLiteProxy(req, res, encoded, parsedUrl.search);
        }

        // REST API 路由
        if (pathname.startsWith('/api/')) {
            return await handleApi(req, res, pathname, parsedUrl);
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

// WebSocket 升级入口：/wisp/ 交给 Wisp 服务端（Scramjet 的出站传输通道），
// Rammerhead 作用域内的升级交给其自身（被代理站点的 WebSocket 连接）
server.on('upgrade', (req, socket, head) => {
    try {
        const parsed = new URL(req.url || '/', 'http://localhost');
        if (parsed.pathname === '/wisp/' && wispRouteRequest) {
            if (!isAuthorized(req, parsed)) {
                return socket.destroy();
            }
            req.url = parsed.pathname;
            return wispRouteRequest(req, socket, head);
        }
        if (shouldRouteRhSafe(req)) {
            if (!isRhAuthorized(req, parsed)) {
                return socket.destroy();
            }
            return rhCore.routeRhUpgrade(rhCore.instance, req, socket, head);
        }
    } catch (err) {
        console.error('[fn-browser] WebSocket upgrade error:', err);
    }
    socket.destroy();
});

server.listen(PORT, HOST, () => {
    console.log(`[fn-browser] 飞牛原生浏览器已启动: http://${HOST}:${PORT} (内核: ${engineMode})`);
});
