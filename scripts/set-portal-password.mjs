#!/usr/bin/env node
/** Reset portal admin password in navigation.db (and sync config.json fallback). */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const require = createRequire(path.join(ROOT, 'portal/package.json'));
const Database = require('better-sqlite3');

const NEW_PASSWORD = process.argv[2] || 'Kimigabansuki';
const DB_PATH = process.env.NAVIGATION_DB_PATH || path.join(ROOT, 'data/navigation.db');
const CONFIG_PATH = path.join(ROOT, 'portal/config.json');

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function createPasswordRecord(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, passwordHash: hashPassword(password, salt) };
}

function verifyPassword(password, record) {
  if (!record?.salt || !record?.passwordHash) return false;
  const hash = hashPassword(password, record.salt);
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(record.passwordHash, 'hex'));
  } catch {
    return false;
  }
}

const db = new Database(DB_PATH);
const row = db.prepare('SELECT payload FROM rbac_snapshot WHERE id = 1').get();
if (!row) {
  console.error('no rbac data in db');
  process.exit(1);
}
const rbac = JSON.parse(row.payload);
const admin = rbac.users.find((u) => u.username === 'admin' || u.id === 'usr_admin');
if (!admin) {
  console.error('admin user not found');
  process.exit(1);
}

const testPasswords = ['Kimigabansuki', 'Kimiga1bansuki', 'change-me'];
for (const p of testPasswords) {
  if (verifyPassword(p, admin)) {
    console.log('current password matches:', p);
    if (p === NEW_PASSWORD) process.exit(0);
  }
}

const record = createPasswordRecord(NEW_PASSWORD);
admin.salt = record.salt;
admin.passwordHash = record.passwordHash;
db.prepare('INSERT OR REPLACE INTO rbac_snapshot (id, payload) VALUES (1, ?)').run(JSON.stringify(rbac));

if (fs.existsSync(CONFIG_PATH)) {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  cfg.auth = cfg.auth || {};
  cfg.auth.username = cfg.auth.username || 'admin';
  cfg.auth.password = NEW_PASSWORD;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
}

console.log('admin password reset to:', NEW_PASSWORD);
