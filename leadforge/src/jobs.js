'use strict';
/* Background job engine: in-process queue with BullMQ-compatible interface.
   If REDIS_URL is set and bullmq+i belonged, it would delegate; here we run a reliable
   in-process worker pool so the app works standalone, with the same status model. */
const path = require('path');
const fs = require('fs');
const db = require('./db');
const { decryptSecret } = require('./crypto');
const google = require('./providers/googlePlaces');
const { crawl } = require('./scraper/crawler');
const { buildWorkbook } = require('./excel');

const EXPORT_DIR = process.env.EXPORT_DIR || path.join(__dirname, '..', 'data', 'exports');
fs.mkdirSync(EXPORT_DIR, { recursive: true });

const running = new Map(); // jobId -> { cancelled: bool }

function cancelJob(jobId) {
  const r = running.get(jobId);
  if (r) r.cancelled = true;
  const j = db._db().jobs.find(x => x.id === jobId);
  if (j && ['pending', 'queued', 'running'].includes(j.status)) db.setJobStatus(jobId, 'cancelled', { finishedAt: new Date().toISOString() });
  return true;
}

async function getApiKey(userId, provider) {
  const c = db.getCredential(userId, provider);
  if (!c || !c.encrypted) return null;
  if (c.enabled === false) return null;
  try { return decryptSecret(c.encrypted); } catch { return null; }
}

function slug(s) { return String(s || 'export').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60) || 'export'; }

async function executeMapsJob(job) {
  const p = job.params;
  const apiKey = await getApiKey(job.userId, 'google-places');
  if (!apiKey) throw Object.assign(new Error('Google Maps API key not configured. Open Settings → API & Integrations → Google Maps Platform and save a key.'), { status: 400, code: 'NO_CREDENTIALS' });
  db.addLog(job.id, 'info', `Starting Places search: "${p.keyword}" in ${p.location} (want ${p.leadCount})`);
  const { leads, errors } = await google.textSearch({ apiKey, keyword: p.keyword, location: p.location, maxResults: p.leadCount });
  let filtered = google.applyFilters(leads, p);
  const before = filtered.length;
  let dupes = 0;
  if (p.dedupe !== false) { const d = google.dedupe(filtered); filtered = d.out; dupes = d.dupes; }
  filtered = filtered.slice(0, p.leadCount);
  db.addRecords(job.id, filtered);
  db.updateJob(job.id, { progress: { requested: p.leadCount, discovered: leads.length, processed: before, unique: filtered.length, duplicates: dupes, failed: errors.length }, providerErrors: errors });
  for (const e of errors) db.addLog(job.id, 'warn', e);
  if (!filtered.length) throw Object.assign(new Error('No results found for this search. Try a broader keyword or nearby location.'), { status: 404, code: 'NO_RESULTS' });
  const short = filtered.length < p.leadCount;
  return { records: filtered, short, errors };
}

async function executeScrapeJob(job, token) {
  const p = job.params;
  const progress = { requested: p.mode === 'selected' ? (p.urls?.length || 0) : p.maxPages, discovered: 0, processed: 0, unique: 0, duplicates: 0, failed: 0 };
  db.updateJob(job.id, { progress });
  let seedQueue = null;
  const crawlOpts = {
    startUrl: p.startUrl, mode: p.mode, maxPages: p.maxPages, maxDepth: p.maxDepth,
    allowPaths: p.allowPaths, denyPatterns: p.denyPatterns, fields: p.fields,
    customFields: p.customFields, concurrency: p.concurrency,
    onProgress: (s) => {
      if (token.cancelled) throw Object.assign(new Error('Job cancelled'), { code: 'CANCELLED' });
      db.updateJob(job.id, { progress: { ...db._db().jobs.find(j => j.id === job.id).progress, discovered: s.discovered, processed: s.processed, unique: s.unique } });
    },
  };
  let result;
  if (p.mode === 'selected') {
    // Crawl each selected URL as single pages within scope
    const { crawl: crawlFn } = require('./scraper/crawler');
    const all = []; const errs = [];
    for (const u of (p.urls || []).slice(0, p.maxPages)) {
      if (token.cancelled) throw Object.assign(new Error('Job cancelled'), { code: 'CANCELLED' });
      const r = await crawlFn({ ...crawlOpts, startUrl: u, mode: 'single', maxPages: 1, maxDepth: 0 });
      all.push(...r.records); errs.push(...r.errors);
      db.updateJob(job.id, { progress: { requested: p.urls.length, discovered: all.length + errs.length, processed: all.length + errs.length, unique: all.length, duplicates: 0, failed: errs.length } });
    }
    result = { records: all, errors: errs, stats: { discovered: all.length + errs.length, processed: all.length + errs.length, unique: all.length } };
  } else if (p.provider === 'firecrawl') {
    const key = await getApiKey(job.userId, 'firecrawl');
    if (!key) throw Object.assign(new Error('Firecrawl API key not configured but Firecrawl provider selected.'), { status: 400, code: 'NO_CREDENTIALS' });
    const { scrapeViaFirecrawl } = require('./providers/optional');
    const { extract } = require('./scraper/extract');
    const r = await crawl({ ...crawlOpts, fetchFn: async (url) => {
      const s = await scrapeViaFirecrawl(key, url);
      return { ok: true, status: 200, headers: { get: () => 'text/html' }, arrayBuffer: async () => Buffer.from(s.html || `<html><body>${s.text || ''}</body></html>`) };
    }});
    result = r;
  } else {
    result = await crawl(crawlOpts);
  }
  // Dedupe by canonical URL
  const seen = new Set(); const uniq = []; let dupes = 0;
  for (const r of result.records) {
    const k = String(r.url || '').toLowerCase();
    if (seen.has(k)) { dupes += 1; continue; }
    seen.add(k); uniq.push(r);
  }
  db.addRecords(job.id, uniq);
  const prog = db._db().jobs.find(j => j.id === job.id).progress;
  db.updateJob(job.id, { progress: { ...prog, unique: uniq.length, duplicates: (prog.duplicates || 0) + dupes, failed: result.errors.length } });
  for (const e of result.errors.slice(0, 50)) db.addLog(job.id, 'warn', `${e.url}: ${e.error}`);
  if (!uniq.length) throw Object.assign(new Error('No pages could be extracted. The site may block bots or require JavaScript. Try fewer pages or configure Playwright/Firecrawl provider.'), { status: 404, code: 'NO_RESULTS' });
  return { records: uniq, short: result.records.length < (p.mode === 'single' ? 1 : 1), errors: result.errors };
}

async function finalizeExport(job, records, errors, summaryExtra = {}) {
  const date = new Date().toISOString().slice(0, 10);
  const base = job.type === 'maps' ? `google_maps_leads_${slug(job.params.location || job.params.keyword)}_${date}` : `website_scrape_${slug(new URL(job.params.startUrl || job.params.keyword || 'site').hostname || 'site')}_${date}`;
  const filename = `${base}.xlsx`;
  const summary = {
    jobId: job.id, type: job.type, provider: job.provider,
    requested: job.params.leadCount || job.params.maxPages || (job.params.urls || []).length,
    savedRecords: records.length, ...summaryExtra,
    generatedAt: new Date().toISOString(),
  };
  const { buffer } = buildWorkbook({ records, summary, errors, });
  const filepath = path.join(EXPORT_DIR, `${job.id}_${filename}`);
  fs.writeFileSync(filepath, buffer);
  const f = db.addFile({ userId: job.userId, jobId: job.id, filename, filepath, size: buffer.length, sheets: ['Data', 'Job Summary'].concat(errors?.length ? ['Errors'] : []) });
  return f;
}

async function runJob(jobId) {
  const job = db._db().jobs.find(j => j.id === jobId);
  if (!job) return;
  const token = { cancelled: false };
  running.set(jobId, token);
  try {
    db.setJobStatus(jobId, 'queued');
    db.setJobStatus(jobId, 'running', { startedAt: new Date().toISOString() });
    db.addLog(jobId, 'info', `Job started (${job.type} via ${job.provider})`);
    let out;
    if (job.type === 'maps') out = await executeMapsJob(db._db().jobs.find(j => j.id === jobId));
    else out = await executeScrapeJob(db._db().jobs.find(j => j.id === jobId), token);
    if (token.cancelled) throw Object.assign(new Error('Job cancelled'), { code: 'CANCELLED' });
    const cur = db._db().jobs.find(j => j.id === jobId);
    const file = await finalizeExport(cur, out.records, out.errors, { duplicatesRemoved: cur.progress.duplicates, failed: cur.progress.failed });
    const status = out.short || (out.errors && out.errors.length && cur.progress.unique < cur.progress.requested) ? 'partial' : 'completed';
    // 'partial' is terminal-completed-with-warning; map to allowed transition
    db.setJobStatus(jobId, status === 'partial' ? 'partial' : 'completed', { finishedAt: new Date().toISOString(), fileId: file.id, error: out.short ? `Only ${out.records.length} results available (requested ${cur.progress.requested}).` : null });
    db.addLog(jobId, 'info', `Job ${status}. Excel: ${file.filename}`);
  } catch (e) {
    if (e.code === 'CANCELLED' || token.cancelled) {
      try { db.setJobStatus(jobId, 'cancelled', { finishedAt: new Date().toISOString() }); } catch {}
      db.addLog(jobId, 'info', 'Job cancelled by user');
    } else {
      // finalize partial export if records were saved
      try {
        const cur = db._db().jobs.find(j => j.id === jobId);
        const recs = db.listRecords(jobId);
        if (recs.length) {
          const file = await finalizeExport(cur, recs, [], {});
          db.setJobStatus(jobId, 'partial', { finishedAt: new Date().toISOString(), fileId: file.id, error: e.message });
        } else {
          db.setJobStatus(jobId, 'failed', { finishedAt: new Date().toISOString(), error: e.message });
        }
      } catch { try { db.setJobStatus(jobId, 'failed', { finishedAt: new Date().toISOString(), error: e.message }); } catch {} }
      db.addLog(jobId, 'error', e.message);
    }
  } finally {
    running.delete(jobId);
  }
}

function enqueue(jobId) {
  setImmediate(() => runJob(jobId).catch(e => console.error('job failed', e)));
}

module.exports = { enqueue, cancelJob, runJob };
