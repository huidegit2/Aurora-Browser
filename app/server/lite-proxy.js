const http = require('http');
const https = require('https');
const { URL } = require('url');

function encodeLiteTarget(targetUrl) {
    return Buffer.from(targetUrl, 'utf8').toString('base64url');
}

function decodeLiteTarget(encoded) {
    return Buffer.from(encoded, 'base64url').toString('utf8');
}

function stripTokenFromSearch(search, tokenParam) {
    if (!search) return '';
    try {
        const params = new URLSearchParams(search);
        params.delete(tokenParam);
        const rest = params.toString();
        return rest ? `?${rest}` : '';
    } catch {
        return '';
    }
}

function rewriteHtmlForLiteProxy(html, baseUrl) {
    const base = new URL(baseUrl);
    const jsString = (value) => JSON.stringify(value).replace(/</g, '\\u003c');
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

    const bridgeScript = `
<script>
(function() {
  try {
    var tabId = (window.name || '').replace(/^aurora-/, '');
    window.parent.postMessage({
      type: 'fn-browser-nav',
      tabId: tabId,
      url: ${jsString(baseUrl)},
      title: document.title || ${jsString(base.hostname)}
    }, window.location.origin);
    window.addEventListener('load', function() {
      window.parent.postMessage({
        type: 'fn-browser-nav',
        tabId: tabId,
        url: ${jsString(baseUrl)},
        title: document.title || ${jsString(base.hostname)}
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

const LITE_SANDBOX = 'sandbox allow-scripts allow-forms allow-downloads';

function createLiteProxy({ tokenParam, timeoutMs = 20000, maxHtmlBytes = 8 * 1024 * 1024 }) {
    return function handleLiteProxy(req, res, encodedPart, extraSearch) {
        // Response-level sandbox also protects a directly opened proxy URL.
        // Omitting allow-same-origin separates page scripts from our management UI.
        res.setHeader('Content-Security-Policy', LITE_SANDBOX);
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'no-store');
        let targetUrl;
        try {
            targetUrl = decodeLiteTarget(encodedPart);
            const cleanSearch = stripTokenFromSearch(extraSearch, tokenParam);
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
        delete headers.cookie;
        delete headers.authorization;
        delete headers['proxy-authorization'];
        delete headers[tokenParam];
        delete headers['x-aurora-token'];
        delete headers.referer;
        delete headers.origin;
        delete headers.forwarded;
        for (const name of Object.keys(headers)) {
            if (name.startsWith('x-forwarded-') || name.startsWith('x-trim-')) delete headers[name];
        }
        headers['host'] = parsed.host;
        headers['user-agent'] =
            headers['user-agent'] ||
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36';

        let settled = false;
        let proxyResponse;
        const fail = (status, message) => {
            if (settled || res.writableEnded || res.destroyed) return;
            settled = true;
            proxyReq.destroy();
            if (proxyResponse) proxyResponse.destroy();
            if (res.headersSent) return res.destroy();
            res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(message);
        };
        const proxyReq = client.request(
            {
                protocol: parsed.protocol,
                hostname: parsed.hostname.replace(/^\[|\]$/g, ''),
                port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
                path: parsed.pathname + parsed.search,
                method: req.method,
                headers,
                timeout: timeoutMs
            },
            (proxyRes) => {
                proxyResponse = proxyRes;
                if (settled || res.destroyed) return proxyRes.destroy();
                proxyRes.on('error', () => fail(502, '目标站点响应中断，请重试。'));
                proxyRes.on('aborted', () => fail(502, '目标站点响应不完整，请重试。'));
                const resHeaders = { ...proxyRes.headers };
                delete resHeaders['x-frame-options'];
                delete resHeaders['content-security-policy'];
                delete resHeaders['content-security-policy-report-only'];
                delete resHeaders['cross-origin-opener-policy'];
                delete resHeaders['cross-origin-embedder-policy'];
                delete resHeaders['cross-origin-resource-policy'];
                delete resHeaders['strict-transport-security'];
                for (const name of ['set-cookie', 'set-cookie2', 'clear-site-data', 'service-worker-allowed',
                    'refresh', 'report-to', 'nel', 'access-control-allow-credentials']) {
                    delete resHeaders[name];
                }
                resHeaders['content-security-policy'] = LITE_SANDBOX;
                resHeaders['referrer-policy'] = 'no-referrer';
                resHeaders['cache-control'] = 'no-store';
                resHeaders['x-content-type-options'] = 'nosniff';
                resHeaders['access-control-allow-origin'] = '*';
                resHeaders['cross-origin-resource-policy'] = 'cross-origin';
                resHeaders['cross-origin-embedder-policy'] = 'credentialless';

                if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode) && resHeaders.location) {
                    try {
                        const next = new URL(resHeaders.location, parsed);
                        if (!['http:', 'https:'].includes(next.protocol)) throw new Error('Unsupported redirect');
                        resHeaders.location = `/lite-proxy/${encodeLiteTarget(next.toString())}`;
                    } catch {
                        return fail(502, '目标站点返回了无效的跳转地址。');
                    }
                    delete resHeaders['content-length'];
                    delete resHeaders['transfer-encoding'];
                    settled = true;
                    proxyRes.destroy();
                    res.writeHead(proxyRes.statusCode, resHeaders);
                    return res.end();
                }

                const contentType = (resHeaders['content-type'] || '').toLowerCase();
                if (contentType.includes('text/html')) {
                    delete resHeaders['content-length'];
                    const chunks = [];
                    let htmlBytes = 0;
                    proxyRes.on('data', (c) => {
                        if (settled) return;
                        htmlBytes += c.length;
                        if (htmlBytes > maxHtmlBytes) return fail(502, '页面内容过大，基础代理已停止加载。');
                        chunks.push(c);
                    });
                    proxyRes.on('end', () => {
                        if (settled || res.destroyed) return;
                        settled = true;
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

        proxyReq.on('timeout', () => fail(504, '请求超时，请检查目标地址或稍后重试。'));
        proxyReq.on('error', () => fail(502, '连接目标站点失败，请检查地址、网络或站点证书。'));
        req.on('aborted', () => proxyReq.destroy());
        res.on('close', () => {
            if (!res.writableEnded) {
                settled = true;
                proxyReq.destroy();
                if (proxyResponse) proxyResponse.destroy();
            }
        });

        if (req.method !== 'GET' && req.method !== 'HEAD') {
            req.pipe(proxyReq);
        } else {
            proxyReq.end();
        }
    };
}

module.exports = { createLiteProxy };
