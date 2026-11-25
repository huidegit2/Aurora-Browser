const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
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
const DOWNLOADS_FILE = path.join(DATA_DIR, 'downloads.json');
const DEFAULT_DOWNLOAD_DIR = path.join(DATA_DIR, 'downloads');
fs.mkdirSync(DEFAULT_DOWNLOAD_DIR, { recursive: true });

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
    maxHistory: 200,
    downloadDir: DEFAULT_DOWNLOAD_DIR
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
readJson(DOWNLOADS_FILE, []);

// ---------------------------------------------------------------------------
// 1a. 飞牛存储目录探测 & 服务端下载管理器
// ---------------------------------------------------------------------------
const activeDownloads = new Map(); // id -> { req, stream, tmpPath, cancelled }

function isDirWritable(dirPath) {
    try {
        fs.accessSync(dirPath, fs.constants.W_OK);
        return true;
    } catch {
        return false;
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

    pushRoot(DEFAULT_DOWNLOAD_DIR, '默认下载目录 (应用数据)');
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

function uniqueFilePath(dir, filename) {
    const ext = path.extname(filename);
    const base = ext ? filename.slice(0, -ext.length) : filename;
    let candidate = path.join(dir, filename);
    let idx = 1;
    while (fs.existsSync(candidate) || fs.existsSync(`${candidate}.part`)) {
        candidate = path.join(dir, `${base} (${idx})${ext}`);
        idx += 1;
    }
    return candidate;
}

function getDownloadsList() {
    const saved = readJson(DOWNLOADS_FILE, []);
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
    const list = readJson(DOWNLOADS_FILE, []);
    const idx = list.findIndex((d) => d.id === id);
    if (idx === -1) return;
    list[idx] = { ...list[idx], ...patch };
    writeJson(DOWNLOADS_FILE, list);
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

    const dir = path.resolve(targetDir || DEFAULT_DOWNLOAD_DIR);
    fs.mkdirSync(dir, { recursive: true });
    if (!isDirWritable(dir)) {
        throw new Error('目标目录不可写，请在飞牛应用设置中授权文件夹权限');
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

    const list = readJson(DOWNLOADS_FILE, []);
    list.unshift(record);
    if (list.length > 100) list.length = 100;
    writeJson(DOWNLOADS_FILE, list);

    const stateObj = {
        req: null,
        stream: null,
        tmpPath: '',
        cancelled: false,
        receivedBytes: 0,
        totalBytes: 0,
        speedBps: 0,
        lastBytes: 0,
        lastTick: Date.now()
    };
    activeDownloads.set(id, stateObj);

    const fetchUrl = (currentUrl, redirectsLeft) => {
        if (stateObj.cancelled) return;
        let u;
        try {
            u = new URL(currentUrl);
        } catch {
            activeDownloads.delete(id);
            return updateDownloadRecord(id, { status: 'failed', error: '重定向地址无效' });
        }
        const mod = u.protocol === 'https:' ? https : http;
        const req = mod.get(
            u,
            {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AuroraBrowser/1.0'
                },
                rejectUnauthorized: false
            },
            (resp) => {
                if ([301, 302, 303, 307, 308].includes(resp.statusCode) && resp.headers.location) {
                    resp.resume();
                    if (redirectsLeft <= 0) {
                        activeDownloads.delete(id);
                        return updateDownloadRecord(id, { status: 'failed', error: '重定向次数过多' });
                    }
                    const nextUrl = new URL(resp.headers.location, u).href;
                    return fetchUrl(nextUrl, redirectsLeft - 1);
                }
                if (resp.statusCode >= 400) {
                    resp.resume();
                    activeDownloads.delete(id);
                    return updateDownloadRecord(id, {
                        status: 'failed',
                        error: `HTTP ${resp.statusCode}`
                    });
                }

                const dispName = filenameFromDisposition(resp.headers['content-disposition']);
                const finalName = dispName || fallbackName;
                const finalPath = uniqueFilePath(dir, finalName);
                const tmpPath = `${finalPath}.part`;
                stateObj.tmpPath = tmpPath;
                stateObj.totalBytes = parseInt(resp.headers['content-length'] || '0', 10) || 0;
                updateDownloadRecord(id, {
                    filename: path.basename(finalPath),
                    filePath: finalPath,
                    totalBytes: stateObj.totalBytes
                });

                const ws = fs.createWriteStream(tmpPath);
                stateObj.stream = ws;

                resp.on('data', (chunk) => {
                    stateObj.receivedBytes += chunk.length;
                    const now = Date.now();
                    const dt = now - stateObj.lastTick;
                    if (dt >= 500) {
                        stateObj.speedBps = Math.round(((stateObj.receivedBytes - stateObj.lastBytes) * 1000) / dt);
                        stateObj.lastBytes = stateObj.receivedBytes;
                        stateObj.lastTick = now;
                    }
                });

                resp.pipe(ws);

                ws.on('finish', () => {
                    activeDownloads.delete(id);
                    if (stateObj.cancelled) {
                        try { fs.unlinkSync(tmpPath); } catch {}
                        return;
                    }
                    try {
                        fs.renameSync(tmpPath, finalPath);
                        updateDownloadRecord(id, {
                            status: 'completed',
                            receivedBytes: stateObj.receivedBytes,
                            totalBytes: stateObj.totalBytes || stateObj.receivedBytes,
                            speedBps: 0,
                            finishedAt: new Date().toISOString()
                        });
                    } catch (err) {
                        updateDownloadRecord(id, { status: 'failed', error: err.message });
                    }
                });

                ws.on('error', (err) => {
                    activeDownloads.delete(id);
                    try { fs.unlinkSync(tmpPath); } catch {}
                    if (!stateObj.cancelled) {
                        updateDownloadRecord(id, { status: 'failed', error: err.message });
                    }
                });

                resp.on('error', (err) => {
                    activeDownloads.delete(id);
                    try { ws.destroy(); } catch {}
                    try { fs.unlinkSync(tmpPath); } catch {}
                    if (!stateObj.cancelled) {
                        updateDownloadRecord(id, { status: 'failed', error: err.message });
                    }
                });
            }
        );
        stateObj.req = req;
        req.on('error', (err) => {
            activeDownloads.delete(id);
            if (!stateObj.cancelled) {
                updateDownloadRecord(id, { status: 'failed', error: err.message });
            }
        });
    };

    fetchUrl(parsed.href, 5);
    return record;
}

// ---------------------------------------------------------------------------
// 1b. 自带 HTTPS（本地 CA）：Scramjet 需要安全上下文，经局域网 IP 以
//     HTTP 打开时永远无法启动。本服务在 DATA_DIR/tls 下维护一个本地
//     根 CA，为本机全部网卡地址签发服务器证书，并在 HTTPS_PORT（默认
//     18921）上以与 HTTP 完全相同的请求/升级处理器提供 HTTPS 入口。
//     用户在每台设备上一次性安装并信任该根证书后，用
//     https://<NAS-IP>:18921 打开即是受信任的安全上下文。
//     TLS 初始化的任何失败都只记录日志，绝不影响 HTTP 服务启动。
// ---------------------------------------------------------------------------
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || '18921', 10);
const TLS_DIR = path.join(DATA_DIR, 'tls');
const httpsStatus = { enabled: false, port: HTTPS_PORT, mode: 'ca' };
let caCertDerBuffer = null; // 根证书 DER（公开材料），供下载端点使用
let caProfileUuid = null; // .mobileconfig 外层 PayloadUUID（由证书指纹派生）
let caCertUuid = null; // .mobileconfig 内层证书 PayloadUUID

function parseCertNames(raw) {
    const list = [];
    const push = (v) => {
        const name = String(v || '').trim().toLowerCase();
        if (name && !list.includes(name)) list.push(name);
    };
    if (Array.isArray(raw)) raw.forEach(push);
    else if (typeof raw === 'string') raw.split(',').forEach(push);
    return list;
}

// 服务器证书应覆盖的 SAN 集合：全部非内网卡地址（IPv4/IPv6）+ 回环 +
// localhost + 环境变量/设置里登记的额外域名（修改后重启应用生效）
function collectServerCertSans() {
    const ips = new Set(['127.0.0.1', '::1']);
    const dnsNames = new Set(['localhost']);
    try {
        for (const entries of Object.values(os.networkInterfaces())) {
            for (const entry of entries || []) {
                if (!entry.internal && entry.address) ips.add(entry.address.toLowerCase());
            }
        }
    } catch {}
    parseCertNames(process.env.AURORA_CERT_NAMES).forEach((n) => dnsNames.add(n));
    try {
        const settings = readJson(SETTINGS_FILE, DEFAULT_SETTINGS);
        parseCertNames(settings.certNames).forEach((n) => dnsNames.add(n));
    } catch {}
    return { ips: [...ips], dnsNames: [...dnsNames] };
}

function forgeSerialNumber(forge) {
    let hex = forge.util.bytesToHex(forge.random.getBytesSync(16));
    // DER INTEGER 为有符号数：首字节最高位为 1 时补 00 保持正数
    if (parseInt(hex.slice(0, 2), 16) >= 0x80) hex = `00${hex}`;
    return hex;
}

function forgeCreateCa(forge) {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = forgeSerialNumber(forge);
    cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
    cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000);
    const attrs = [
        { name: 'commonName', value: 'Aurora Local CA' },
        { name: 'organizationName', value: 'Aurora' }
    ];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([
        { name: 'basicConstraints', cA: true, critical: true },
        { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
        { name: 'subjectKeyIdentifier' }
    ]);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    return { cert, privateKey: keys.privateKey, fresh: true };
}

// 已存 CA 可解析且未临近过期则复用（永不无故重签，否则所有设备要重装）
function loadOrCreateCa(forge) {
    const keyPath = path.join(TLS_DIR, 'ca.key.pem');
    const crtPath = path.join(TLS_DIR, 'ca.crt.pem');
    try {
        if (fs.existsSync(keyPath) && fs.existsSync(crtPath)) {
            const privateKey = forge.pki.privateKeyFromPem(fs.readFileSync(keyPath, 'utf8'));
            const cert = forge.pki.certificateFromPem(fs.readFileSync(crtPath, 'utf8'));
            if (cert.validity.notAfter.getTime() - Date.now() > 30 * 24 * 3600 * 1000) {
                return { cert, privateKey, fresh: false };
            }
            console.log('[fn-browser] 已存 CA 临近过期，将重新生成');
        }
    } catch (err) {
        console.log(`[fn-browser] 已存 CA 无法解析，将重新生成（${err.message}）`);
    }
    const ca = forgeCreateCa(forge);
    fs.writeFileSync(keyPath, forge.pki.privateKeyToPem(ca.privateKey), { mode: 0o600 });
    fs.chmodSync(keyPath, 0o600); // 已存在文件时 writeFile 的 mode 不生效，显式收紧
    fs.writeFileSync(crtPath, forge.pki.certificateToPem(ca.cert), { mode: 0o644 });
    return ca;
}

function certSansOf(forgeCert) {
    const ips = new Set();
    const dns = new Set();
    try {
        const ext = forgeCert.getExtension('subjectAltName');
        if (ext && Array.isArray(ext.altNames)) {
            for (const alt of ext.altNames) {
                if (alt.type === 7 && alt.ip) ips.add(String(alt.ip).toLowerCase());
                else if (alt.type === 2 && alt.value) dns.add(String(alt.value).toLowerCase());
            }
        }
    } catch {}
    return { ips, dns };
}

function forgeIssueServerCert(forge, ca, sans) {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = forgeSerialNumber(forge);
    cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
    cert.validity.notAfter = new Date(Date.now() + 800 * 24 * 3600 * 1000);
    cert.setSubject([
        { name: 'commonName', value: 'Aurora' },
        { name: 'organizationName', value: 'Aurora' }
    ]);
    cert.setIssuer(ca.cert.subject.attributes);
    cert.setExtensions([
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
        { name: 'extKeyUsage', serverAuth: true },
        {
            name: 'subjectAltName',
            altNames: [
                ...sans.dnsNames.map((v) => ({ type: 2, value: v })),
                ...sans.ips.map((ip) => ({ type: 7, ip }))
            ]
        },
        { name: 'subjectKeyIdentifier' }
    ]);
    cert.sign(ca.privateKey, forge.md.sha256.create());
    return { cert, privateKey: keys.privateKey };
}

// 已存服务器证书若覆盖当前全部 SAN 且 30 天内不过期则复用，否则重签
function loadOrIssueServerCert(forge, ca, sans) {
    const keyPath = path.join(TLS_DIR, 'server.key.pem');
    const crtPath = path.join(TLS_DIR, 'server.crt.pem');
    if (!ca.fresh) {
        try {
            const cert = forge.pki.certificateFromPem(fs.readFileSync(crtPath, 'utf8'));
            const privateKey = forge.pki.privateKeyFromPem(fs.readFileSync(keyPath, 'utf8'));
            const have = certSansOf(cert);
            const missing =
                sans.ips.some((ip) => !have.ips.has(ip)) ||
                sans.dnsNames.some((n) => !have.dns.has(n));
            const expiresSoon =
                cert.validity.notAfter.getTime() - Date.now() < 30 * 24 * 3600 * 1000;
            if (!missing && !expiresSoon) return { cert, privateKey };
        } catch {}
    }
    const issued = forgeIssueServerCert(forge, ca, sans);
    fs.writeFileSync(keyPath, forge.pki.privateKeyToPem(issued.privateKey), { mode: 0o600 });
    fs.chmodSync(keyPath, 0o600);
    fs.writeFileSync(crtPath, forge.pki.certificateToPem(issued.cert), { mode: 0o644 });
    return issued;
}

function uuidFromHex(hex, offset) {
    const h = (hex.slice(offset, offset + 32) + '00000000000000000000000000000000').slice(0, 32);
    return (
        `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-` +
        `${h.slice(16, 20)}-${h.slice(20, 32)}`
    ).toUpperCase();
}

// 准备 TLS 材料并填充 CA 下载端点所需数据；失败时返回 null（仅 HTTP 运行）
function initTlsMaterials() {
    // 优先使用外部提供的受信任证书（环境变量或 DATA_DIR/tls/custom.{crt,key}.pem）
    const customCertPath = process.env.TLS_CERT_PATH || path.join(TLS_DIR, 'custom.crt.pem');
    const customKeyPath = process.env.TLS_KEY_PATH || path.join(TLS_DIR, 'custom.key.pem');
    if (fs.existsSync(customCertPath) && fs.existsSync(customKeyPath)) {
        try {
            const certPem = fs.readFileSync(customCertPath, 'utf8');
            const keyPem = fs.readFileSync(customKeyPath, 'utf8');
            if (certPem.trim() && keyPem.trim()) {
                httpsStatus.mode = 'custom';
                console.log(`[fn-browser] 已加载自定义外部 TLS 证书: ${customCertPath}`);
                return { keyPem, certPem };
            }
        } catch (err) {
            console.log(`[fn-browser] 读取自定义 TLS 证书失败，将回退本地 CA（${err.message}）`);
        }
    }

    let forge;
    try {
        forge = require('node-forge');
    } catch (err) {
        console.log(`[fn-browser] node-forge 不可用，HTTPS 未启用（${err.message}）`);
        return null;
    }
    fs.mkdirSync(TLS_DIR, { recursive: true });
    const ca = loadOrCreateCa(forge);
    const sans = collectServerCertSans();
    const serverCert = loadOrIssueServerCert(forge, ca, sans);

    const derBytes = forge.asn1.toDer(forge.pki.certificateToAsn1(ca.cert)).getBytes();
    caCertDerBuffer = Buffer.from(derBytes, 'binary');
    const sha1 = forge.md.sha1.create();
    sha1.update(derBytes);
    const fingerprint = sha1.digest().toHex();
    caCertUuid = uuidFromHex(fingerprint, 0);
    const sha256 = forge.md.sha256.create();
    sha256.update(derBytes);
    caProfileUuid = uuidFromHex(sha256.digest().toHex(), 0);
    console.log(
        `[fn-browser] 本地 CA 就绪（指纹 SHA1 ${fingerprint.slice(0, 16)}…，` +
            `${ca.fresh ? '新生成' : '复用已存'}），服务器证书 SAN: ` +
            `${sans.dnsNames.join(', ')} / ${sans.ips.join(', ')}`
    );
    return {
        keyPem: forge.pki.privateKeyToPem(serverCert.privateKey),
        // 叶子证书 + 根证书链一并提供，方便个别严格客户端补全信任链
        certPem:
            forge.pki.certificateToPem(serverCert.cert) + forge.pki.certificateToPem(ca.cert)
    };
}

// Apple 配置描述文件：内嵌根证书（com.apple.security.root），iOS 上经
// Safari 下载后可在「设置 - 通用 - VPN 与设备管理」中一键安装
function buildCaMobileConfig() {
    const b64 = caCertDerBuffer.toString('base64').replace(/.{64}/g, '$&\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>PayloadContent</key>
	<array>
		<dict>
			<key>PayloadType</key>
			<string>com.apple.security.root</string>
			<key>PayloadVersion</key>
			<integer>1</integer>
			<key>PayloadIdentifier</key>
			<string>com.aurora.ca.certificate</string>
			<key>PayloadUUID</key>
			<string>${caCertUuid}</string>
			<key>PayloadDisplayName</key>
			<string>极光 Aurora 根证书</string>
			<key>PayloadContent</key>
			<data>
${b64}
			</data>
		</dict>
	</array>
	<key>PayloadType</key>
	<string>Configuration</string>
	<key>PayloadVersion</key>
	<integer>1</integer>
	<key>PayloadIdentifier</key>
	<string>com.aurora.ca</string>
	<key>PayloadUUID</key>
	<string>${caProfileUuid}</string>
	<key>PayloadDisplayName</key>
	<string>极光 Aurora 根证书</string>
	<key>PayloadOrganization</key>
	<string>Aurora</string>
	<key>PayloadDescription</key>
	<string>安装极光 Aurora 的本地根证书，以便通过 HTTPS 安全打开极光并启用 Scramjet 内核。</string>
</dict>
</plist>
`;
}

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
        return sendJson(res, 200, {
            ok: true,
            engine: engineMode,
            https: { enabled: httpsStatus.enabled, port: httpsStatus.port, mode: httpsStatus.mode },
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
            const current = readJson(SETTINGS_FILE, DEFAULT_SETTINGS);
            if (!current.downloadDir) current.downloadDir = DEFAULT_DOWNLOAD_DIR;
            return sendJson(res, 200, current);
        }
        if (req.method === 'PUT') {
            const patch = await parseBody(req);
            const current = readJson(SETTINGS_FILE, DEFAULT_SETTINGS);
            if (typeof patch.downloadDir === 'string') {
                const targetDir = path.resolve(patch.downloadDir.trim() || DEFAULT_DOWNLOAD_DIR);
                try {
                    fs.mkdirSync(targetDir, { recursive: true });
                    if (!isDirWritable(targetDir)) {
                        return sendJson(res, 400, {
                            error: '该目录不可写，请在飞牛「应用设置 -> 文件夹权限」中授权，或选择应用默认目录'
                        });
                    }
                    patch.downloadDir = targetDir;
                } catch (err) {
                    return sendJson(res, 400, { error: `无法访问目录: ${err.message}` });
                }
            }
            const updated = { ...current, ...patch };
            writeJson(SETTINGS_FILE, updated);
            return sendJson(res, 200, updated);
        }
    }

    // 飞牛存储目录浏览
    if (pathname === '/api/fs/roots' && req.method === 'GET') {
        return sendJson(res, 200, {
            defaultDir: DEFAULT_DOWNLOAD_DIR,
            roots: getFnOsRoots()
        });
    }

    if (pathname === '/api/fs/list' && req.method === 'GET') {
        const target = path.resolve(parsedUrl.searchParams.get('dir') || DEFAULT_DOWNLOAD_DIR);
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
            return sendJson(res, 200, {
                dir: target,
                parent: parent !== target ? parent : null,
                writable: isDirWritable(target),
                dirs
            });
        } catch (err) {
            return sendJson(res, 400, { error: `无法读取目录: ${err.message}` });
        }
    }

    if (pathname === '/api/fs/mkdir' && req.method === 'POST') {
        const body = await parseBody(req);
        const parent = path.resolve(String(body.parent || DEFAULT_DOWNLOAD_DIR));
        const name = sanitizeFilename(body.name || '');
        if (!name) return sendJson(res, 400, { error: '请输入文件夹名称' });
        const target = path.join(parent, name);
        try {
            fs.mkdirSync(target, { recursive: true });
            return sendJson(res, 201, { path: target, name, writable: isDirWritable(target) });
        } catch (err) {
            return sendJson(res, 400, { error: `创建失败: ${err.message}` });
        }
    }

    // NAS 下载管理
    if (pathname === '/api/downloads') {
        if (req.method === 'GET') {
            const settings = readJson(SETTINGS_FILE, DEFAULT_SETTINGS);
            return sendJson(res, 200, {
                downloadDir: settings.downloadDir || DEFAULT_DOWNLOAD_DIR,
                items: getDownloadsList()
            });
        }
        if (req.method === 'POST') {
            const body = await parseBody(req);
            const settings = readJson(SETTINGS_FILE, DEFAULT_SETTINGS);
            const dir = body.dir || settings.downloadDir || DEFAULT_DOWNLOAD_DIR;
            try {
                const record = startNasDownload(body.url, body.filename, dir);
                return sendJson(res, 201, record);
            } catch (err) {
                return sendJson(res, 400, { error: err.message });
            }
        }
        if (req.method === 'DELETE') {
            const remaining = readJson(DOWNLOADS_FILE, []).filter((d) => activeDownloads.has(d.id));
            writeJson(DOWNLOADS_FILE, remaining);
            return sendJson(res, 200, { ok: true });
        }
    }

    if (pathname.startsWith('/api/downloads/')) {
        const rest = pathname.slice('/api/downloads/'.length);
        if (rest.endsWith('/cancel') && req.method === 'POST') {
            const id = decodeURIComponent(rest.slice(0, -'/cancel'.length));
            const active = activeDownloads.get(id);
            if (active) {
                active.cancelled = true;
                try { if (active.req) active.req.destroy(); } catch {}
                try { if (active.stream) active.stream.destroy(); } catch {}
                try { if (active.tmpPath) fs.unlinkSync(active.tmpPath); } catch {}
                activeDownloads.delete(id);
            }
            updateDownloadRecord(id, { status: 'cancelled', speedBps: 0 });
            return sendJson(res, 200, { ok: true });
        }
        if (rest.endsWith('/file') && req.method === 'GET') {
            const id = decodeURIComponent(rest.slice(0, -'/file'.length));
            const item = readJson(DOWNLOADS_FILE, []).find((d) => d.id === id);
            if (!item || !item.filePath || !fs.existsSync(item.filePath)) {
                return sendJson(res, 404, { error: '文件不存在或已被移动' });
            }
            const stat = fs.statSync(item.filePath);
            res.writeHead(200, {
                'Content-Type': 'application/octet-stream',
                'Content-Length': stat.size,
                'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(item.filename)}`
            });
            return fs.createReadStream(item.filePath).pipe(res);
        }
        if (req.method === 'DELETE') {
            const id = decodeURIComponent(rest);
            const list = readJson(DOWNLOADS_FILE, []);
            const item = list.find((d) => d.id === id);
            if (item && parsedUrl.searchParams.get('deleteFile') === '1' && item.filePath) {
                try { fs.unlinkSync(item.filePath); } catch {}
            }
            writeJson(DOWNLOADS_FILE, list.filter((d) => d.id !== id));
            return sendJson(res, 200, { ok: true });
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
// HTTP 与 HTTPS 共用同一套处理器，保证两个入口行为完全一致
const requestHandler = async (req, res) => {
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

        // 本地 CA 根证书下载（DER 证书 / Apple 配置描述文件）。这里只
        // 提供证书本身——纯公钥材料，可以公开分发；任何私钥永不经
        // HTTP(S) 输出。与外壳页一样不设令牌门槛：用户必须先在设备
        // 上取证并安装信任，才能首次通过 HTTPS 打开应用。
        if (pathname === '/aurora-ca.crt' && caCertDerBuffer) {
            res.writeHead(200, {
                'Content-Type': 'application/x-x509-ca-cert',
                'Content-Disposition': 'attachment; filename="aurora-ca.crt"',
                'Cache-Control': 'no-cache'
            });
            return res.end(caCertDerBuffer);
        }
        if (pathname === '/aurora-ca.mobileconfig' && caCertDerBuffer) {
            res.writeHead(200, {
                'Content-Type': 'application/x-apple-aspen-config',
                'Content-Disposition': 'attachment; filename="aurora-ca.mobileconfig"',
                'Cache-Control': 'no-cache'
            });
            return res.end(buildCaMobileConfig());
        }

        // Scramjet 内核静态资源
        if (serveScramjetAsset(req, res, pathname)) {
            return;
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
};

// WebSocket 升级入口：/wisp/ 交给 Wisp 服务端（Scramjet 的出站传输通道）
const upgradeHandler = (req, socket, head) => {
    try {
        const parsed = new URL(req.url || '/', 'http://localhost');
        if (parsed.pathname === '/wisp/' && wispRouteRequest) {
            if (!isAuthorized(req, parsed)) {
                return socket.destroy();
            }
            req.url = parsed.pathname;
            return wispRouteRequest(req, socket, head);
        }
    } catch (err) {
        console.error('[fn-browser] WebSocket upgrade error:', err);
    }
    socket.destroy();
};

const server = http.createServer(requestHandler);
server.on('upgrade', upgradeHandler);

server.listen(PORT, HOST, () => {
    console.log(`[fn-browser] 飞牛原生浏览器已启动: http://${HOST}:${PORT} (内核: ${engineMode})`);
});

// HTTPS 入口：与 HTTP 共用处理器；初始化或监听失败只降级，不阻断 HTTP
try {
    const tlsMaterials = initTlsMaterials();
    if (tlsMaterials) {
        const httpsServer = https.createServer(
            { key: tlsMaterials.keyPem, cert: tlsMaterials.certPem },
            requestHandler
        );
        httpsServer.on('upgrade', upgradeHandler);
        httpsServer.on('error', (err) => {
            httpsStatus.enabled = false;
            console.log(`[fn-browser] HTTPS 监听异常，HTTPS 入口不可用（${err.message}）`);
        });
        httpsServer.listen(HTTPS_PORT, HOST, () => {
            httpsStatus.enabled = true;
            const certHint = httpsStatus.mode === 'custom'
                ? '使用自定义外部证书'
                : '根证书下载: /aurora-ca.crt';
            console.log(
                `[fn-browser] HTTPS 入口已启动: https://${HOST}:${HTTPS_PORT}（${certHint}）`
            );
        });
    }
} catch (err) {
    console.log(`[fn-browser] HTTPS 初始化失败，继续仅提供 HTTP（${err.message}）`);
}
