'use strict';
/* SSRF protection + URL scope validation. No external deps. */
const dns = require('dns').promises;
const net = require('net');

const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata.google.internal']);
const CLOUD_METADATA_IPS = new Set(['169.254.169.254', 'fd00:ec2::254', '100.100.100.200']);

function isPrivateIP(ip) {
  if (!net.isIP(ip)) return false;
  if (CLOUD_METADATA_IPS.has(ip)) return true;
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    if (p[0] === 10) return true;
    if (p[0] === 127) return true;
    if (p[0] === 169 && p[1] === 254) return true; // link-local incl. cloud metadata
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 0) return true;
    if (p[0] >= 224) return true; // multicast/reserved
    return false;
  }
  // IPv6
  const low = ip.toLowerCase();
  if (low === '::1' || low === '::ffff:127.0.0.1') return true;
  if (low.startsWith('fc') || low.startsWith('fd')) return true; // unique local
  if (low.startsWith('fe80')) return true; // link local
  if (low === '::' || low.startsWith('::ffff:10.') || low.startsWith('::ffff:192.168.') || low.startsWith('::ffff:172.')) return true;
  return false;
}

function parseUrlOrThrow(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw Object.assign(new Error('Invalid URL'), { status: 400, code: 'INVALID_URL' }); }
  if (!['http:', 'https:'].includes(u.protocol)) {
    throw Object.assign(new Error('Only http and https URLs are allowed'), { status: 400, code: 'BAD_SCHEME' });
  }
  if (!u.hostname) throw Object.assign(new Error('URL must include a hostname'), { status: 400, code: 'NO_HOST' });
  if (BLOCKED_HOSTNAMES.has(u.hostname.toLowerCase())) {
    throw Object.assign(new Error('Destination is blocked'), { status: 400, code: 'BLOCKED_HOST' });
  }
  // Block obvious internal hostnames
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(u.hostname)) {
    throw Object.assign(new Error('Internal hostnames are blocked'), { status: 400, code: 'BLOCKED_HOST' });
  }
  // Block credentials in URL
  if (u.username || u.password) throw Object.assign(new Error('URLs with credentials are not allowed'), { status: 400, code: 'USERINFO_BLOCKED' });
  // Block non-default weird ports for internal services? Allow standard ports only + 8080/8443
  return u;
}

// Resolve hostname and ensure no resolved IP is private. Returns list of IPs.
async function assertSafeDestination(rawUrl, { dnsLookup } = {}) {
  const u = parseUrlOrThrow(rawUrl);
  const host = u.hostname;
  if (net.isIP(host)) {
    if (isPrivateIP(host)) throw Object.assign(new Error('Private/internal IP destinations are blocked'), { status: 400, code: 'PRIVATE_IP' });
    return { url: u, ips: [host] };
  }
  const lookup = dnsLookup || dns.lookup;
  let records = [];
  try {
    records = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw Object.assign(new Error('Could not resolve hostname'), { status: 400, code: 'DNS_FAIL' });
  }
  const ips = records.map(r => r.address);
  if (!ips.length) throw Object.assign(new Error('Could not resolve hostname'), { status: 400, code: 'DNS_FAIL' });
  for (const ip of ips) {
    if (isPrivateIP(ip)) throw Object.assign(new Error('Hostname resolves to a private/internal IP and is blocked'), { status: 400, code: 'PRIVATE_IP' });
  }
  return { url: u, ips };
}

function assertSameOriginScope(targetUrl, rootUrl) {
  const t = new URL(String(targetUrl));
  const r = new URL(String(rootUrl));
  return t.protocol === r.protocol && t.hostname.toLowerCase() === r.hostname.toLowerCase();
}

function urlMatchesScope(candidate, { allowPaths = [], denyPatterns = [] } = {}) {
  const s = String(candidate);
  if (allowPaths && allowPaths.length) {
    const u = new URL(s);
    const ok = allowPaths.some(p => u.pathname.startsWith(String(p)));
    if (!ok) return false;
  }
  if (denyPatterns && denyPatterns.length) {
    for (const pat of denyPatterns) {
      try {
        const re = new RegExp(String(pat));
        if (re.test(s)) return false;
      } catch { if (s.includes(String(pat))) return false; }
    }
  }
  return true;
}

function canonicalizeUrl(raw, base) {
  try {
    const u = base ? new URL(String(raw), String(base)) : new URL(String(raw));
    u.hash = '';
    // drop common tracking params
    for (const p of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid']) u.searchParams.delete(p);
    // trailing slash normalization (keep root slash)
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  } catch { return String(raw); }
}

module.exports = { isPrivateIP, parseUrlOrThrow, assertSafeDestination, assertSameOriginScope, urlMatchesScope, canonicalizeUrl };
