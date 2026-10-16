'use strict';
/* Lightweight validation (Zod-compatible API subset). Works without deps; uses zod if installed. */
let zod = null;
try { zod = require('zod'); } catch { zod = null; }

function err(msg, code = 'VALIDATION_ERROR') { return Object.assign(new Error(msg), { status: 400, code }); }

function isEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s || '')); }
function isUrl(s) { try { const u = new URL(String(s)); return ['http:', 'https:'].includes(u.protocol); } catch { return false; } }

function validateMapsJob(input) {
  const v = input || {};
  if (!v.keyword || String(v.keyword).trim().length < 2) throw err('Business niche/keyword is required (min 2 chars)');
  if (!v.location || String(v.location).trim().length < 2) throw err('Target location is required');
  const count = Number(v.leadCount ?? v.requestedCount ?? 0);
  const max = Number(process.env.MAX_LEADS_PER_JOB || 500);
  if (!Number.isFinite(count) || count < 1) throw err('Desired number of leads must be >= 1');
  if (count > max) throw err(`Requested leads exceed limit of ${max}`);
  if (v.minRating != null && v.minRating !== '' && (Number(v.minRating) < 0 || Number(v.minRating) > 5)) throw err('Minimum rating must be 0-5');
  return {
    keyword: String(v.keyword).trim().slice(0, 200),
    location: String(v.location).trim().slice(0, 200),
    businessType: String(v.businessType || '').trim().slice(0, 120),
    leadCount: Math.floor(count),
    radiusMeters: v.radiusMeters != null && v.radiusMeters !== '' ? Math.min(50000, Math.max(0, Number(v.radiusMeters) || 0)) : null,
    language: String(v.language || 'en').slice(0, 12),
    minRating: v.minRating == null || v.minRating === '' ? null : Number(v.minRating),
    category: String(v.category || '').slice(0, 120),
    onlyWebsite: !!v.onlyWebsite, onlyPhone: !!v.onlyPhone, onlyEmail: !!v.onlyEmail,
    dedupe: v.dedupe !== false,
    includeStatus: !!v.includeStatus,
    budgetLimit: v.budgetLimit != null && v.budgetLimit !== '' ? Number(v.budgetLimit) : null,
    provider: String(v.provider || 'google-places').slice(0, 60),
  };
}

function validateScrapeJob(input) {
  const v = input || {};
  if (!v.startUrl || !isUrl(v.startUrl)) throw err('A valid starting http(s) URL is required');
  const mode = String(v.mode || 'single');
  if (!['single', 'crawl', 'selected'].includes(mode)) throw err('Invalid scraping mode');
  const maxPages = Math.min(Number(process.env.MAX_PAGES_PER_JOB || 200), Math.max(1, Number(v.maxPages ?? 10) || 10));
  const maxDepth = Math.min(5, Math.max(0, Number(v.maxDepth ?? 2) || 0));
  let urlList = [];
  if (mode === 'selected') {
    if (!Array.isArray(v.urls) || !v.urls.length) throw err('Selected-pages mode requires a list of URLs');
    urlList = v.urls.map(s => String(s).trim()).filter(Boolean);
    if (!urlList.length) throw err('Selected-pages mode requires a list of URLs');
    for (const u of urlList) if (!isUrl(u)) throw err(`Invalid URL in list: ${u}`);
    if (urlList.length > maxPages) throw err(`URL list exceeds max pages (${maxPages})`);
  }
  return {
    startUrl: String(v.startUrl).trim(),
    mode, maxPages, maxDepth,
    allowPaths: Array.isArray(v.allowPaths) ? v.allowPaths.map(String).slice(0, 20) : [],
    denyPatterns: Array.isArray(v.denyPatterns) ? v.denyPatterns.map(String).slice(0, 20) : [],
    fields: Array.isArray(v.fields) && v.fields.length ? v.fields.map(String).slice(0, 40) : defaultScrapeFields(),
    customFields: Array.isArray(v.customFields) ? v.customFields.map(c => ({ name: String(c.name || '').slice(0, 60), instruction: String(c.instruction || '').slice(0, 300) })).filter(c => c.name).slice(0, 20) : [],
    columnRenames: (v.columnRenames && typeof v.columnRenames === 'object') ? v.columnRenames : {},
    provider: String(v.provider || 'cheerio').slice(0, 60),
    concurrency: Math.min(5, Math.max(1, Number(v.concurrency || 3))),
    useAI: !!v.useAI,
  };
}

function defaultScrapeFields() {
  return ['title', 'metaDescription', 'headings', 'mainText', 'emails', 'phones', 'links', 'socialLinks', 'tables', 'lists', 'images', 'jsonLd', 'openGraph', 'url', 'status', 'crawledAt'];
}

function validateCredentials(provider, input) {
  const v = input || {};
  if (provider === 'google-places') {
    if (v.apiKey !== undefined && v.apiKey !== '' && String(v.apiKey).length < 10) throw err('Google API key looks too short');
  } else if (provider === 'firecrawl' || provider === 'apify' || provider === 'openai') {
    const key = v.apiKey ?? v.token;
    if (key !== undefined && key !== '' && String(key).length < 8) throw err('API key/token looks too short');
  } else throw err('Unknown provider');
  return true;
}

module.exports = { validateMapsJob, validateScrapeJob, defaultScrapeFields, validateCredentials, isEmail, isUrl, zodAvailable: !!zod };
