import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

export function loadPg() {
  const candidates = [
    path.join(root, 'stock-manage', 'node_modules', 'pg'),
    path.join(root, 'portal', 'node_modules', 'pg'),
    path.join(root, 'qqq-dip', 'node_modules', 'pg'),
    'pg'
  ];
  for (const candidate of candidates) {
    try { return require(candidate); } catch { /* next */ }
  }
  throw new Error('找不到 pg 依赖');
}

function urlForDatabase(base, name) {
  const url = new URL(base);
  url.pathname = '/' + name;
  return url.toString();
}

export async function withTestDatabase(run) {
  const adminUrl = process.env.NAVIGATION_TEST_POSTGRES_URL;
  if (!adminUrl) throw new Error('需要 NAVIGATION_TEST_POSTGRES_URL（管理连接）');
  const pg = loadPg();
  const name = 'navigation_test_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query('CREATE DATABASE "' + name + '"');
  } finally {
    await admin.end();
  }
  const url = urlForDatabase(adminUrl, name);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('CREATE SCHEMA navigation');
    await client.query('SET search_path TO navigation');
    await client.query(fs.readFileSync(path.join(root, 'shared/db/postgres/001-initial.sql'), 'utf8'));
    await client.query('SET search_path TO navigation');
    await client.query(fs.readFileSync(path.join(root, 'shared/db/postgres/002-qqq-dip-state.sql'), 'utf8'));
    const result = await run({ url, client, pg });
    return result;
  } finally {
    await client.end();
    const drop = new pg.Client({ connectionString: adminUrl });
    await drop.connect();
    try { await drop.query('DROP DATABASE IF EXISTS "' + name + '" WITH (FORCE)'); }
    finally { await drop.end(); }
  }
}

export function assert(condition, message) {
  if (!condition) throw new Error('断言失败：' + message);
}

export function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('断言失败：' + message + '\n实际：' + JSON.stringify(actual) + '\n期望：' + JSON.stringify(expected));
  }
}
