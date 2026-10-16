'use strict';
/* File-backed JSON database. Production can swap DATABASE_URL to Postgres via Prisma (see prisma/schema.prisma).
   Provides users, credentials, jobs, records, files, logs, audits with indexes. */
const fs = require('fs');
const path = require('path');
const { randomToken } = require('./crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'leadforge.db.json');

function blank() {
  return { users: [], credentials: [], jobs: [], records: [], files: [], logs: [], audits: [], meta: { seq: 1 } };
}

function load() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DB_FILE)) { const b = blank(); fs.writeFileSync(DB_FILE, JSON.stringify(b, null, 2)); return b; }
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const db = raw.trim() ? JSON.parse(raw) : blank();
    for (const k of Object.keys(blank())) if (!db[k]) db[k] = blank()[k];
    return db;
  } catch { return blank(); }
}

let DB = load();
function save() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(DB_FILE, JSON.stringify(DB, null, 2)); } catch {}
}
function uid(prefix) { DB.meta.seq += 1; return `${prefix}_${Date.now().toString(36)}_${DB.meta.seq.toString(36)}${randomToken(3)}`; }

// --- users ---
function createUser({ email, salt, hash, role }) {
  const u = { id: uid('usr'), email: String(email).toLowerCase(), salt, hash, role: role || 'admin', createdAt: new Date().toISOString() };
  DB.users.push(u); save(); return u;
}
function findUserByEmail(email) { return DB.users.find(u => u.email === String(email).toLowerCase()) || null; }
function findUserById(id) { return DB.users.find(u => u.id === id) || null; }

// --- credentials (encrypted payloads only) ---
function upsertCredential({ userId, provider, encrypted, enabled, meta }) {
  let c = DB.credentials.find(x => x.userId === userId && x.provider === provider);
  if (!c) { c = { id: uid('cred'), userId, provider, createdAt: new Date().toISOString() }; DB.credentials.push(c); }
  if (encrypted !== undefined) c.encrypted = encrypted; // null clears
  if (enabled !== undefined) c.enabled = !!enabled;
  if (meta !== undefined) c.meta = meta;
  c.updatedAt = new Date().toISOString();
  save(); return c;
}
function getCredential(userId, provider) { return DB.credentials.find(x => x.userId === userId && x.provider === provider) || null; }
function listCredentials(userId) { return DB.credentials.filter(x => x.userId === userId); }

// --- jobs ---
const TRANSITIONS = {
  pending: ['queued', 'cancelled', 'failed'],
  queued: ['running', 'cancelled', 'failed'],
  running: ['completed', 'partial', 'failed', 'cancelled'],
  completed: [], partial: [], failed: ['queued'], cancelled: ['queued'],
};
function canTransition(from, to) { return (TRANSITIONS[from] || []).includes(to); }
function createJob({ userId, type, title, params, provider }) {
  const j = {
    id: uid('job'), userId, type, title, params, provider: provider || null,
    status: 'pending', progress: { requested: 0, discovered: 0, processed: 0, unique: 0, duplicates: 0, failed: 0 },
    error: null, providerErrors: [], fileId: null, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null,
  };
  DB.jobs.unshift(j); save(); return j;
}
function getJob(userId, id) { return DB.jobs.find(j => j.id === id && j.userId === userId) || null; }
function listJobs(userId, { limit = 50 } = {}) { return DB.jobs.filter(j => j.userId === userId).slice(0, limit); }
function updateJob(id, patch) { const j = DB.jobs.find(x => x.id === id); if (!j) return null; Object.assign(j, patch); save(); return j; }
function setJobStatus(id, to, extra = {}) {
  const j = DB.jobs.find(x => x.id === id); if (!j) return null;
  if (j.status !== to && !canTransition(j.status, to)) throw Object.assign(new Error(`Illegal job transition ${j.status} -> ${to}`), { status: 400 });
  j.status = to; Object.assign(j, extra); save(); return j;
}

// --- records ---
function addRecords(jobId, rows) {
  for (const r of rows) DB.records.push({ id: uid('rec'), jobId, ...r });
  save();
}
function listRecords(jobId, { limit = 5000 } = {}) { return DB.records.filter(r => r.jobId === jobId).slice(0, limit); }
function countRecords(jobId) { return DB.records.reduce((n, r) => n + (r.jobId === jobId ? 1 : 0), 0); }
function deleteJobCascade(jobId) {
  DB.jobs = DB.jobs.filter(j => j.id !== jobId);
  DB.records = DB.records.filter(r => r.jobId !== jobId);
  const f = DB.files.filter(x => x.jobId === jobId);
  DB.files = DB.files.filter(x => x.jobId !== jobId);
  DB.logs = DB.logs.filter(l => l.jobId !== jobId);
  save(); return f;
}

// --- files / logs / audits ---
function addFile({ userId, jobId, filename, filepath, size, sheets }) {
  const f = { id: uid('file'), userId, jobId, filename, filepath, size, sheets: sheets || [], createdAt: new Date().toISOString() };
  DB.files.unshift(f); save(); return f;
}
function listFiles(userId) { return DB.files.filter(f => f.userId === userId); }
function getFile(userId, id) { return DB.files.find(f => f.id === id && f.userId === userId) || null; }
function deleteFileRecord(id) { DB.files = DB.files.filter(f => f.id !== id); save(); }
function addLog(jobId, level, message) { DB.logs.push({ id: uid('log'), jobId, level, message, at: new Date().toISOString() }); save(); }
function jobLogs(jobId) { return DB.logs.filter(l => l.jobId === jobId); }
function audit(userId, action, detail) { DB.audits.unshift({ id: uid('aud'), userId, action, detail: detail || null, at: new Date().toISOString() }); if (DB.audits.length > 500) DB.audits.length = 500; save(); }
function audits(userId) { return DB.audits.filter(a => a.userId === userId).slice(0, 200); }

function stats(userId) {
  const jobs = DB.jobs.filter(j => j.userId === userId);
  const recs = DB.records.filter(r => jobs.some(j => j.id === r.jobId));
  const today = new Date().toISOString().slice(0, 10);
  return {
    totalLeads: recs.length,
    totalJobs: jobs.length,
    completed: jobs.filter(j => ['completed', 'partial'].includes(j.status)).length,
    failed: jobs.filter(j => j.status === 'failed').length,
    today: recs.filter(r => (r.collectedAt || r.crawledAt || '').slice(0, 10) === today).length,
  };
}

module.exports = {
  createUser, findUserByEmail, findUserById,
  upsertCredential, getCredential, listCredentials,
  createJob, getJob, listJobs, updateJob, setJobStatus, canTransition,
  addRecords, listRecords, countRecords, deleteJobCascade,
  addFile, listFiles, getFile, deleteFileRecord,
  addLog, jobLogs, audit, audits, stats,
  _db: () => DB, _reload: () => { DB = load(); },
};
