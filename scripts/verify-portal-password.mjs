#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const require = createRequire(path.join(ROOT, 'portal/package.json'));
const Database = require('better-sqlite3');

const PWD = process.argv[2] || 'Kimiga1bansuki';
const db = new Database(path.join(ROOT, 'data/navigation.db'));
const rbac = JSON.parse(db.prepare('SELECT payload FROM rbac_snapshot WHERE id = 1').get().payload);
const admin = rbac.users.find((u) => u.username === 'admin');
const hash = crypto.scryptSync(PWD, admin.salt, 64).toString('hex');
console.log('db match', hash === admin.passwordHash);
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'portal/config.json'), 'utf8'));
console.log('config password', cfg.auth?.password === PWD);
