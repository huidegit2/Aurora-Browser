'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');

function ipv4ToNumber(address) {
    const parts = address.split('.').map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

function inIpv4Range(value, network, prefix) {
    const base = ipv4ToNumber(network);
    return base !== null && (value >>> (32 - prefix)) === (base >>> (32 - prefix));
}

function isNonPublicIpv4(address) {
    const value = ipv4ToNumber(address);
    if (value === null) return true;
    return [
        ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
        ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
        ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
        ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
    ].some(([network, prefix]) => inIpv4Range(value, network, prefix));
}

function ipv6Words(address) {
    let value = address.toLowerCase();
    if (value.includes('.')) {
        const separator = value.lastIndexOf(':');
        const ipv4 = ipv4ToNumber(value.slice(separator + 1));
        if (separator < 0 || ipv4 === null) return null;
        const high = ((ipv4 >>> 16) & 0xffff).toString(16);
        const low = (ipv4 & 0xffff).toString(16);
        value = `${value.slice(0, separator + 1)}${high}:${low}`;
    }
    const halves = value.split('::');
    if (halves.length > 2) return null;
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    const missing = 8 - left.length - right.length;
    if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
    const words = [...left, ...Array(missing).fill('0'), ...right].map((part) => parseInt(part || '0', 16));
    return words.length === 8 && words.every((part) => Number.isInteger(part) && part >= 0 && part <= 0xffff) ? words : null;
}

function isNonPublicAddress(address) {
    const value = String(address || '').split('%')[0].replace(/^\[|\]$/g, '');
    const family = net.isIP(value);
    if (family === 4) return isNonPublicIpv4(value);
    if (family !== 6) return true;
    const words = ipv6Words(value);
    if (!words) return true;
    if (words.slice(0, 5).every((part) => part === 0) && words[5] === 0xffff) {
        const mapped = `${words[6] >>> 8}.${words[6] & 255}.${words[7] >>> 8}.${words[7] & 255}`;
        return isNonPublicIpv4(mapped);
    }
    if (words.every((part) => part === 0) || (words.slice(0, 7).every((part) => part === 0) && words[7] === 1)) return true;
    if ((words[0] & 0xfe00) === 0xfc00 || (words[0] & 0xffc0) === 0xfe80 || (words[0] & 0xff00) === 0xff00) return true;
    // Permit only IPv6 global-unicast space and reject documentation/transition ranges.
    if ((words[0] & 0xe000) !== 0x2000) return true;
    if (words[0] === 0x2001 && (words[1] <= 0x01ff || words[1] === 0x0db8)) return true;
    if (words[0] === 0x2002) return true;
    if (words[0] === 0x3fff && (words[1] & 0xfff0) === 0) return true;
    return false;
}

function pinnedLookup(addresses) {
    return (_hostname, options, callback) => {
        if (typeof options === 'function') {
            callback = options;
            options = {};
        }
        const matching = options && options.family
            ? addresses.filter((entry) => entry.family === options.family)
            : addresses;
        const candidates = matching.length ? matching : addresses;
        process.nextTick(() => {
            if (options && options.all) callback(null, candidates);
            else callback(null, candidates[0].address, candidates[0].family);
        });
    };
}

async function resolveTargetAddresses(hostname, { allowPrivateNetworkProxy = false, lookup = dns.lookup } = {}) {
    const host = String(hostname || '').replace(/^\[|\]$/g, '');
    const literalFamily = net.isIP(host);
    let addresses;
    try {
        addresses = literalFamily
            ? [{ address: host, family: literalFamily }]
            : await lookup(host, { all: true, verbatim: true });
    } catch (cause) {
        const error = new Error('目标域名解析失败');
        error.code = 'TARGET_DNS_FAILED';
        error.cause = cause;
        throw error;
    }
    if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some((entry) => !entry || net.isIP(entry.address) === 0)) {
        const error = new Error('目标域名没有有效地址');
        error.code = 'TARGET_DNS_FAILED';
        throw error;
    }
    if (!allowPrivateNetworkProxy && addresses.some((entry) => isNonPublicAddress(entry.address))) {
        const error = new Error('局域网目标访问默认关闭');
        error.code = 'PRIVATE_NETWORK_DISABLED';
        throw error;
    }
    const normalized = addresses.map((entry) => ({ address: entry.address, family: entry.family || net.isIP(entry.address) }));
    return { addresses: normalized, lookup: pinnedLookup(normalized) };
}

function configureWispPrivateNetwork(wispServer, enabled) {
    if (!wispServer || !wispServer.options || typeof wispServer.options !== 'object') {
        throw new Error('当前 Wisp 版本不支持局域网目标访问策略');
    }
    wispServer.options.allow_private_ips = Boolean(enabled);
}

module.exports = { configureWispPrivateNetwork, isNonPublicAddress, resolveTargetAddresses };
