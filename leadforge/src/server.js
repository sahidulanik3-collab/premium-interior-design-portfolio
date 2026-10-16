'use strict';
/* LeadForge standalone server: auth, jobs API, settings, files, SSE, static SPA.
   Zero required runtime deps (pure Node). Optional: cheerio, playwright, bullmq/redis. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { hashPassword, verifyPassword, randomToken, encryptSecret, decryptSecret, maskSecret } = require('./crypto');
const db = require('./db');
const { validateMapsJob, validateScrapeJob, validateCredentials } = require('./validate');
const jobs = require('./jobs');

const PORT = Number(process.env.PORT || 3000);
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-session-secret-change-me';
const APP_NAME = process.env.APP_NAME || 'LeadForge';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const sessions = new Map(); // sid -> { userId, createdAt }
const rate = new Map(); // ip -> { count, reset }

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...secHeaders() });
  res.end(body);
}
function secHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; font-src https://fonts.gstatic.com https://cdnjs.cloudflare.com; img-src * data: blob:;",
  };
}
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function getSession(req) {
  const sid = parseCookies(req).lf_sid;
  if (!sid || !sessions.has(sid)) return null;
  return { sid, ...sessions.get(sid) };
}
function requireAuth(req, res) {
  const s = getSession(req);
  if (!s) { sendJson(res, 401, { error: 'Not authenticated. Please log in.' }); return null; }
  const user = db.findUserById(s.userId);
  if (!user) { sendJson(res, 401, { error: 'Session expired. Please log in again.' }); return null; }
  return { session: s, user };
}
function checkRate(req, res) {
  const ip = req.socket.remoteAddress || 'x';
  const now = Date.now();
  const r = rate.get(ip) || { count: 0, reset: now + 60000 };
  if (now > r.reset) { r.count = 0; r.reset = now + 60000; }
  r.count += 1; rate.set(ip, r);
  if (r.count > 300) { sendJson(res, 429, { error: 'Too many requests. Slow down and retry.' }); return false; }
  return true;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    req.on('data', c => { chunks.push(c); if (Buffer.concat(chunks).length > 5 * 1024 * 1024) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); } });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(Object.assign(new Error('Invalid JSON body'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/' || p === '/app') p = '/index.html';
  // Never serve /data
  if (p.includes('..')) { res.writeHead(400); res.end('bad'); return true; }
  const file = path.join(PUBLIC_DIR, p);
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('forbidden'); return true; }
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', ...secHeaders() });
    fs.createReadStream(file).pipe(res);
    return true;
  }
  // SPA fallback for app routes
  if (!p.startsWith('/api/')) {
    const idx = path.join(PUBLIC_DIR, 'index.html');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...secHeaders() });
    fs.createReadStream(idx).pipe(res);
    return true;
  }
  return false;
}

function maskCredRecord(c) {
  if (!c) return { configured: false, enabled: false, masked: '', lastTest: null };
  let masked = '';
  try { if (c.encrypted) masked = maskSecret(decryptSecret(c.encrypted)); } catch { masked = '•••• (unreadable: master key changed?)'; }
  return { configured: !!c.encrypted, enabled: c.enabled !== false, masked, lastTest: c.meta?.lastTest || null, updatedAt: c.updatedAt || null };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const { pathname } = url;
    if (!checkRate(req, res)) return;
    // CSRF: state-changing requests must be same-origin or carry no cross-site intent
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
      const origin = req.headers.origin || '';
      const host = req.headers.host || '';
      if (origin && !origin.includes(host) && !origin.includes('localhost')) {
        // allow empty/same; block obvious cross-site
        if (!String(origin).includes('://')) { sendJson(res, 403, { error: 'CSRF check failed' }); return; }
      }
    }

    // ---- auth ----
    if (pathname === '/api/auth/register' && req.method === 'POST') {
      const body = await readBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return sendJson(res, 400, { error: 'Valid email required' });
      if (password.length < 8) return sendJson(res, 400, { error: 'Password must be at least 8 characters' });
      if (db._db().users.length > 0 && !getSession(req)) {
        // Private app: only allow first user open registration; afterwards require auth or bootstrap token
        const bootstrap = process.env.ADMIN_SETUP_TOKEN;
        if (bootstrap && body.setupToken !== bootstrap) return sendJson(res, 403, { error: 'Registration is closed. Ask an admin to create your account or provide setup token.' });
        if (!bootstrap && db.findUserByEmail(email) == null && db._db().users.length > 0) {
          // Allow additional registrations only when logged in? Keep closed:
          return sendJson(res, 403, { error: 'Registration is closed after initial setup. Log in instead.' });
        }
      }
      if (db.findUserByEmail(email)) return sendJson(res, 400, { error: 'Account already exists. Log in instead.' });
      const { salt, hash } = hashPassword(password);
      const user = db.createUser({ email, salt, hash, role: db._db().users.length === 0 ? 'admin' : 'member' });
      db.audit(user.id, 'user.register', email);
      const sid = randomToken(24);
      sessions.set(sid, { userId: user.id, createdAt: Date.now() });
      res.writeHead(201, { 'Set-Cookie': `lf_sid=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000`, 'Content-Type': 'application/json', ...secHeaders() });
      return res.end(JSON.stringify({ ok: true, user: { id: user.id, email: user.email } }));
    }
    if (pathname === '/api/auth/login' && req.method === 'POST') {
      const body = await readBody(req);
      // Bootstrap: env ADMIN_EMAIL/ADMIN_PASSWORD creates account on first login if DB empty
      if (db._db().users.length === 0 && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
        const { salt, hash } = hashPassword(process.env.ADMIN_PASSWORD);
        db.createUser({ email: process.env.ADMIN_EMAIL, salt, hash, role: 'admin' });
      }
      const user = db.findUserByEmail(String(body.email || ''));
      if (!user || !verifyPassword(String(body.password || ''), user.salt, user.hash)) {
        return sendJson(res, 401, { error: 'Invalid email or password' });
      }
      const sid = randomToken(24);
      sessions.set(sid, { userId: user.id, createdAt: Date.now() });
      db.audit(user.id, 'user.login', user.email);
      res.writeHead(200, { 'Set-Cookie': `lf_sid=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000`, 'Content-Type': 'application/json', ...secHeaders() });
      return res.end(JSON.stringify({ ok: true, user: { id: user.id, email: user.email } }));
    }
    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      const s = getSession(req);
      if (s) sessions.delete(s.sid);
      res.writeHead(200, { 'Set-Cookie': 'lf_sid=; HttpOnly; Path=/; Max-Age=0', 'Content-Type': 'application/json', ...secHeaders() });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (pathname === '/api/auth/me' && req.method === 'GET') {
      const a = requireAuth(req, res); if (!a) return;
      return sendJson(res, 200, { user: { id: a.user.id, email: a.user.email, role: a.user.role } });
    }

    // ---- authed API ----
    if (pathname.startsWith('/api/')) {
      const a = requireAuth(req, res); if (!a) return;
      const userId = a.user.id;

      if (pathname === '/api/stats' && req.method === 'GET') {
        const s = db.stats(userId);
        const recentJobs = db.listJobs(userId, { limit: 6 });
        const files = db.listFiles(userId).slice(0, 6);
        const creds = db.listCredentials(userId);
        const providers = ['google-places', 'firecrawl', 'apify', 'openai'].map(p => {
          const c = creds.find(x => x.provider === p);
          return { provider: p, ...maskCredRecord(c) };
        });
        return sendJson(res, 200, { stats: s, recentJobs, recentFiles: files, providers, appName: APP_NAME });
      }

      if (pathname === '/api/jobs' && req.method === 'GET') {
        return sendJson(res, 200, { jobs: db.listJobs(userId, { limit: 200 }) });
      }
      if (pathname === '/api/jobs/maps' && req.method === 'POST') {
        const body = await readBody(req);
        let params;
        try { params = validateMapsJob(body); } catch (e) { return sendJson(res, e.status || 400, { error: e.message }); }
        const budget = Number(process.env.SPEND_THRESHOLD_USD || 20);
        if (params.budgetLimit != null && params.budgetLimit < 1) return sendJson(res, 400, { error: 'Budget limit must be positive' });
        const job = db.createJob({ userId, type: 'maps', title: `${params.keyword} — ${params.location}`, params, provider: params.provider });
        db.updateJob(job.id, { progress: { requested: params.leadCount, discovered: 0, processed: 0, unique: 0, duplicates: 0, failed: 0 } });
        db.audit(userId, 'job.create.maps', job.id);
        jobs.enqueue(job.id);
        return sendJson(res, 201, { job, confirmSpend: params.leadCount > 100 ? `Large job (${params.leadCount} leads) may consume significant Google API quota. Proceed.` : null, spendThreshold: budget });
      }
      if (pathname === '/api/jobs/scrape' && req.method === 'POST') {
        const body = await readBody(req);
        let params;
        try { params = validateScrapeJob(body); } catch (e) { return sendJson(res, e.status || 400, { error: e.message }); }
        if (params.provider !== 'cheerio' && params.provider !== 'playwright' && params.provider !== 'firecrawl') {
          return sendJson(res, 400, { error: 'Unknown scraping provider' });
        }
        if (params.provider === 'firecrawl') {
          const c = db.getCredential(userId, 'firecrawl');
          if (!c || !c.encrypted || c.enabled === false) return sendJson(res, 400, { error: 'Firecrawl selected but not configured. Configure it in Settings or choose Built-in/Cheerio.' });
        }
        const job = db.createJob({ userId, type: 'scrape', title: params.startUrl, params: { ...params, urls: params.mode === 'selected' ? body.urls : undefined }, provider: params.provider });
        db.updateJob(job.id, { progress: { requested: params.mode === 'selected' ? (body.urls || []).length : params.maxPages, discovered: 0, processed: 0, unique: 0, duplicates: 0, failed: 0 } });
        db.audit(userId, 'job.create.scrape', job.id);
        jobs.enqueue(job.id);
        return sendJson(res, 201, { job });
      }

      const mJob = pathname.match(/^\/api\/jobs\/([^/]+)(\/.*)?$/);
      if (mJob) {
        const jobId = mJob[1];
        const suffix = mJob[2] || '';
        const job = db.getJob(userId, jobId);
        if (!job) return sendJson(res, 404, { error: 'Job not found' });
        if (suffix === '' && req.method === 'GET') {
          return sendJson(res, 200, { job, logs: db.jobLogs(jobId).slice(-100) });
        }
        if (suffix === '/records' && req.method === 'GET') {
          let recs = db.listRecords(jobId);
          const q = String(url.searchParams.get('q') || '').toLowerCase();
          const sort = String(url.searchParams.get('sort') || '');
          const dir = url.searchParams.get('dir') === 'desc' ? -1 : 1;
          const page = Math.max(1, Number(url.searchParams.get('page') || 1));
          const pageSize = Math.min(100, Math.max(5, Number(url.searchParams.get('pageSize') || 20)));
          if (q) recs = recs.filter(r => JSON.stringify(r).toLowerCase().includes(q));
          const total = recs.length;
          if (sort) recs = [...recs].sort((x, y) => String(x[sort] ?? '').localeCompare(String(y[sort] ?? '')) * dir);
          const items = recs.slice((page - 1) * pageSize, page * pageSize);
          return sendJson(res, 200, { total, page, pageSize, items });
        }
        if (suffix === '/logs' && req.method === 'GET') return sendJson(res, 200, { logs: db.jobLogs(jobId) });
        if (suffix === '/events' && req.method === 'GET') {
          // Server-Sent Events live progress
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', ...secHeaders() });
          const iv = setInterval(() => {
            const j = db.getJob(userId, jobId);
            if (!j) { clearInterval(iv); res.end(); return; }
            res.write(`data: ${JSON.stringify({ status: j.status, progress: j.progress, error: j.error, fileId: j.fileId })}\n\n`);
            if (['completed', 'partial', 'failed', 'cancelled'].includes(j.status)) { clearInterval(iv); res.end(); }
          }, 1000);
          req.on('close', () => clearInterval(iv));
          return;
        }
        if (suffix === '/cancel' && req.method === 'POST') {
          jobs.cancelJob(jobId);
          db.audit(userId, 'job.cancel', jobId);
          return sendJson(res, 200, { ok: true });
        }
        if (suffix === '/retry' && req.method === 'POST') {
          if (!['failed', 'cancelled', 'partial'].includes(job.status)) return sendJson(res, 400, { error: 'Only failed/cancelled/partial jobs can be retried' });
          db.setJobStatus(jobId, 'queued', { error: null, startedAt: null, finishedAt: null });
          db.audit(userId, 'job.retry', jobId);
          jobs.enqueue(jobId);
          return sendJson(res, 200, { ok: true });
        }
        if (suffix === '' && req.method === 'DELETE') {
          const files = db.deleteJobCascade(jobId);
          for (const f of files) { try { fs.unlinkSync(f.filepath); } catch {} }
          db.audit(userId, 'job.delete', jobId);
          return sendJson(res, 200, { ok: true });
        }
        if (suffix === '/export-selected' && req.method === 'POST') {
          const body = await readBody(req);
          const ids = new Set(body.ids || []);
          const recs = db.listRecords(jobId).filter(r => ids.has(r.id));
          if (!recs.length) return sendJson(res, 400, { error: 'No matching records selected' });
          const { buildWorkbook } = require('./excel');
          const { buffer } = buildWorkbook({ records: recs, summary: { jobId, exported: recs.length, at: new Date().toISOString() }, errors: [] });
          res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="selected.xlsx"', 'Content-Length': buffer.length });
          return res.end(buffer);
        }
      }

      if (pathname === '/api/files' && req.method === 'GET') return sendJson(res, 200, { files: db.listFiles(userId) });
      const mFile = pathname.match(/^\/api\/files\/([^/]+)(\/download)?$/);
      if (mFile) {
        const f = db.getFile(userId, mFile[1]);
        if (!f) return sendJson(res, 404, { error: 'File not found' });
        if (req.method === 'DELETE') {
          try { fs.unlinkSync(f.filepath); } catch {}
          db.deleteFileRecord(f.id);
          db.audit(userId, 'file.delete', f.filename);
          return sendJson(res, 200, { ok: true });
        }
        if (mFile[2] === '/download' && req.method === 'GET') {
          if (!fs.existsSync(f.filepath)) return sendJson(res, 404, { error: 'Export file missing on disk' });
          const buf = fs.readFileSync(f.filepath);
          res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${f.filename}"`, 'Content-Length': buf.length });
          return res.end(buf);
        }
      }

      // settings / credentials
      if (pathname === '/api/settings/credentials' && req.method === 'GET') {
        const out = {};
        for (const p of ['google-places', 'firecrawl', 'apify', 'openai']) out[p] = maskCredRecord(db.getCredential(userId, p));
        return sendJson(res, 200, { credentials: out });
      }
      const mCred = pathname.match(/^\/api\/settings\/credentials\/([\w-]+)(\/test)?$/);
      if (mCred) {
        const provider = mCred[1];
        if (!['google-places', 'firecrawl', 'apify', 'openai'].includes(provider)) return sendJson(res, 400, { error: 'Unknown provider' });
        if (req.method === 'PUT') {
          const body = await readBody(req);
          try { validateCredentials(provider, body); } catch (e) { return sendJson(res, 400, { error: e.message }); }
          const key = String(body.apiKey ?? body.token ?? '');
          const patch = { enabled: body.enabled !== undefined ? !!body.enabled : undefined, meta: body.meta || undefined };
          if (key === '') {
            // do not overwrite existing key on empty submit
            const existing = db.getCredential(userId, provider);
            if (!existing) return sendJson(res, 400, { error: 'No key provided and none stored' });
            db.upsertCredential({ userId, provider, enabled: patch.enabled ?? existing.enabled, meta: { ...(existing.meta || {}), ...(patch.meta || {}) } });
          } else {
            db.upsertCredential({ userId, provider, encrypted: encryptSecret(key), enabled: patch.enabled ?? true, meta: patch.meta || { model: body.model } });
          }
          db.audit(userId, 'credentials.update', provider);
          return sendJson(res, 200, { ok: true, credential: maskCredRecord(db.getCredential(userId, provider)) });
        }
        if (req.method === 'DELETE') {
          db.upsertCredential({ userId, provider, encrypted: null, enabled: false });
          db.audit(userId, 'credentials.delete', provider);
          return sendJson(res, 200, { ok: true });
        }
        if (mCred[2] === '/test' && req.method === 'POST') {
          const c = db.getCredential(userId, provider);
          if (!c || !c.encrypted) return sendJson(res, 400, { error: 'No key saved for this provider yet', connected: false });
          let key;
          try { key = decryptSecret(c.encrypted); } catch { return sendJson(res, 500, { error: 'Stored key cannot be decrypted (master key changed?)', connected: false }); }
          try {
            if (provider === 'google-places') await require('./providers/googlePlaces').testConnection(key);
            else if (provider === 'firecrawl') await require('./providers/optional').testFirecrawl(key);
            else if (provider === 'apify') await require('./providers/optional').testApify(key);
            else await require('./providers/optional').testOpenAI(key, c.meta?.model);
            db.upsertCredential({ userId, provider, meta: { ...(c.meta || {}), lastTest: new Date().toISOString(), lastTestOk: true } });
            db.audit(userId, 'credentials.test.ok', provider);
            return sendJson(res, 200, { ok: true, connected: true, at: new Date().toISOString() });
          } catch (e) {
            db.upsertCredential({ userId, provider, meta: { ...(c.meta || {}), lastTest: new Date().toISOString(), lastTestOk: false, lastError: e.message } });
            return sendJson(res, 502, { ok: false, connected: false, error: e.message });
          }
        }
      }
      if (pathname === '/api/audits' && req.method === 'GET') return sendJson(res, 200, { audits: db.audits(userId) });

      return sendJson(res, 404, { error: 'API route not found' });
    }

    if (!serveStatic(req, res)) { sendJson(res, 404, { error: 'Not found' }); }
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, e.status || 500, { error: e.message || 'Server error' });
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`${APP_NAME} listening on http://localhost:${PORT}`));
}
module.exports = server;
