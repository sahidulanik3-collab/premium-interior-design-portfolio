'use strict';
/* AES-256-GCM credential encryption + password hashing + masking */
const crypto = require('crypto');

function getMasterKey() {
  const raw = process.env.ENCRYPTION_MASTER_KEY || process.env.MASTER_ENCRYPTION_KEY || 'dev-only-master-key-change-me-32b!';
  // Derive 32-byte key via SHA-256 so any length env works; production should supply 32-byte base64.
  return crypto.createHash('sha256').update(String(raw)).digest();
}

function encryptSecret(plaintext) {
  if (plaintext == null || plaintext === '') return null;
  const key = getMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `gcm1.${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

function decryptSecret(payload) {
  if (!payload) return null;
  const parts = String(payload).split('.');
  if (parts[0] !== 'gcm1' || parts.length !== 4) throw new Error('Unknown encrypted payload format');
  const key = getMasterKey();
  const iv = Buffer.from(parts[1], 'base64');
  const tag = Buffer.from(parts[2], 'base64');
  const data = Buffer.from(parts[3], 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

function maskSecret(s) {
  if (!s) return '';
  const str = String(s);
  if (str.length <= 4) return '••••';
  return '••••' + str.slice(-4);
}

function hashPassword(password, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 32);
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

function verifyPassword(password, saltHex, hashHex) {
  const { hash } = hashPassword(password, saltHex);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(String(hashHex), 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function randomToken(bytes = 32) { return crypto.randomBytes(bytes).toString('hex'); }

module.exports = { encryptSecret, decryptSecret, maskSecret, hashPassword, verifyPassword, randomToken, getMasterKey };
