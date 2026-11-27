'use strict';

// Browser Origin/Fetch Metadata checks supplement authentication. Never infer a
// public hostname from X-Forwarded-Host supplied by an arbitrary client.
function isTrustedBrowserRequest(req, { requireOrigin = false } = {}) {
    const headers = req.headers || {};
    const origin = headers.origin;
    const site = headers['sec-fetch-site'];
    if (site === 'cross-site' || site === 'same-site') return false;
    const protocol = (req.socket && req.socket.encrypted) || headers['x-forwarded-proto'] === 'https'
        ? 'https:' : 'http:';
    let expected;
    try {
        if (typeof headers.host !== 'string' || /[\s/@\\]/.test(headers.host)) return false;
        expected = new URL(`${protocol}//${headers.host}`).origin;
    } catch {
        return false;
    }
    if (origin !== undefined) {
        if (typeof origin !== 'string' || origin === 'null') return false;
        try {
            const parsed = new URL(origin);
            return parsed.origin === expected && parsed.pathname === '/' && !parsed.search && !parsed.hash
                && !parsed.username && !parsed.password;
        } catch {
            return false;
        }
    }
    if (requireOrigin) return false;
    // Older WebViews may omit Fetch Metadata and Origin on a same-origin GET.
    // When Referer is present, it must still name our actual origin.
    if (headers.referer !== undefined) {
        try {
            return new URL(headers.referer).origin === expected;
        } catch {
            return false;
        }
    }
    return true; // Non-browser clients still pass the independent auth check.
}

function safeCookieValue(raw, name) {
    if (typeof raw !== 'string') return '';
    for (const part of raw.split(';')) {
        const eq = part.indexOf('=');
        if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
        try {
            return decodeURIComponent(part.slice(eq + 1).trim());
        } catch {
            return ''; // A malformed cookie must not turn every request into 500.
        }
    }
    return '';
}

module.exports = { isTrustedBrowserRequest, safeCookieValue };
