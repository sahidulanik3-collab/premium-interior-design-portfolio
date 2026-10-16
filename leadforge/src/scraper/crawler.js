'use strict';
/* Website crawler: SSRF-guarded fetch, bounded concurrency, retries, timeouts,
   canonicalization, same-origin scope, robots.txt respect (basic), size limits. */
const { assertSafeDestination, canonicalizeUrl, urlMatchesScope, assertSameOriginScope } = require('../ssrf');
const { extract, discoverLinks, pickFields } = require('./extract');

const MAX_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 5;

async function fetchPage(url, { timeoutMs = 15000, fetchFn } = {}) {
  const fetchImpl = fetchFn || fetch;
  let current = String(url);
  let redirects = 0;
  while (true) {
    await assertSafeDestination(current); // revalidate after each redirect
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(current, { redirect: 'manual', signal: ctrl.signal, headers: { 'User-Agent': 'LeadForgeBot/1.0 (+leadgen; contact: admin)' } });
    } catch (e) { clearTimeout(t); throw Object.assign(new Error(`Fetch failed: ${e.message}`), { code: 'FETCH_FAIL' }); }
    clearTimeout(t);
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      if (++redirects > MAX_REDIRECTS) throw Object.assign(new Error('Too many redirects'), { code: 'REDIRECTS' });
      const loc = res.headers.get('location');
      if (!loc) throw Object.assign(new Error('Redirect without location'), { code: 'REDIRECTS' });
      current = new URL(loc, current).toString();
      continue;
    }
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!/text\/html|application\/xhtml|text\/plain/.test(ct) && ct) {
      return { url: current, status: res.status, skipped: true, reason: `Unsupported content-type ${ct}` };
    }
    const buf = Buffer.from(await res.arrayBuffer().catch(() => Buffer.alloc(0)));
    if (buf.length > MAX_BYTES) throw Object.assign(new Error('Page exceeds size limit'), { code: 'TOO_LARGE' });
    const html = buf.toString('utf8');
    return { url: current, finalUrl: current, status: res.status, html, headers: Object.fromEntries(res.headers.entries()) };
  }
}

async function robotsAllowed(origin, fetchFn) {
  try {
    await assertSafeDestination(origin + '/robots.txt');
    const res = await (fetchFn || fetch)(origin + '/robots.txt', { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { allowed: () => true };
    const txt = await res.text();
    const disallows = txt.split('\n').filter(l => /^disallow:/i.test(l)).map(l => l.split(':')[1].trim()).filter(Boolean);
    return { allowed: (path) => !disallows.some(d => d === '/' || (d !== '' && path.startsWith(d))) };
  } catch { return { allowed: () => true }; }
}

async function crawl({ startUrl, mode = 'single', maxPages = 10, maxDepth = 2, allowPaths = [], denyPatterns = [], fields = null, customFields = [], concurrency = 3, timeoutMs = 15000, fetchFn, onProgress }) {
  await assertSafeDestination(startUrl);
  const root = new URL(startUrl);
  const robots = await robotsAllowed(root.origin, fetchFn);
  let queue = [];
  if (mode === 'single') queue = [{ url: canonicalizeUrl(startUrl), depth: 0 }];
  else if (mode === 'selected') queue = [];
  else queue = [{ url: canonicalizeUrl(startUrl), depth: 0 }];

  const seen = new Set(queue.map(q => q.url));
  const records = []; const errors = [];
  let processed = 0;

  async function handleOne(item) {
    const canon = canonicalizeUrl(item.url);
    try {
      if (!assertSameOriginScope(canon, startUrl)) throw new Error('Out of scope (external domain)');
      const u = new URL(canon);
      if (!robots.allowed(u.pathname)) throw new Error('Blocked by robots.txt');
      if (!urlMatchesScope(canon, { allowPaths, denyPatterns })) throw new Error('Excluded by scope rules');
      const page = await fetchPage(canon, { timeoutMs, fetchFn });
      if (page.skipped) { errors.push({ url: canon, error: page.reason }); return; }
      const full = extract(page.html || '', page.finalUrl || canon);
      full.url = page.finalUrl || canon; full.status = page.status; full.crawledAt = new Date().toISOString();
      let rec = fields && fields.length ? pickFields(full, fields) : full;
      if (customFields.length) { rec.custom = {}; for (const c of customFields) rec.custom[c.name] = (full.mainText || '').slice(0, 500); rec = { ...rec, ...flattenCustom(rec.custom) }; delete rec.custom; }
      records.push(rec);
      if (mode === 'crawl' && item.depth < maxDepth && records.length + queue.length < maxPages) {
        const origin = new URL(startUrl).origin;
        for (const link of discoverLinks(page.html, page.finalUrl || canon)) {
          const c = canonicalizeUrl(link);
          if (seen.has(c)) continue;
          try { if (new URL(c).origin !== origin) continue; } catch { continue; }
          if (!urlMatchesScope(c, { allowPaths, denyPatterns })) continue;
          seen.add(c);
          if (records.length + queue.length >= maxPages) break;
          queue.push({ url: c, depth: item.depth + 1 });
        }
      }
    } catch (e) {
      errors.push({ url: canon, error: e.message || String(e) });
    } finally {
      processed += 1;
      if (onProgress) onProgress({ processed, discovered: seen.size, unique: records.length });
    }
  }

  // Selected mode: seed from caller-provided list handled by caller; here queue already set.
  while (queue.length && records.length < maxPages) {
    const batch = queue.splice(0, Math.min(concurrency, maxPages - records.length));
    // retry once on fetch fail
    await Promise.all(batch.map(async (item) => {
      await handleOne(item);
      if (errors.length && errors[errors.length - 1]?.url === canonicalizeUrl(item.url) && /Fetch failed|timeout/i.test(errors[errors.length - 1].error)) {
        await new Promise(r => setTimeout(r, 500));
        errors.pop(); processed -= 1;
        await handleOne(item);
      }
    }));
  }
  return { records, errors, stats: { discovered: seen.size, processed, unique: records.length } };
}

function flattenCustom(custom) {
  const o = {};
  for (const [k, v] of Object.entries(custom || {})) o[`custom_${k}`] = v;
  return o;
}

module.exports = { crawl, fetchPage, robotsAllowed };
