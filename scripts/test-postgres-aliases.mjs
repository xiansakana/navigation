import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoots = ['portal/src', 'shared', 'stock-manage/src', 'qqq-dip/src', 'qq-bot/src', 'torn-toolbox-desktop/src'];
const violations = [];

function scan(file) {
  const source = fs.readFileSync(file, 'utf8');
  const pattern = /\bAS\s+([a-z][A-Za-z0-9_]*[A-Z][A-Za-z0-9_]*)/g;
  let match;
  while ((match = pattern.exec(source))) {
    const alias = match[1];
    const aliasStart = match.index + match[0].lastIndexOf(alias);
    if (source[aliasStart - 1] === '"') continue;
    const line = source.slice(0, match.index).split('\n').length;
    violations.push(`${path.relative(root, file)}:${line} AS ${alias}`);
  }
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!['node_modules', 'public', 'vendor', 'data'].includes(entry.name)) walk(full);
      continue;
    }
    if (!/\.(js|mjs)$/.test(entry.name) || /\.test\.(js|mjs)$/.test(entry.name)) continue;
    if (!/postgres/i.test(entry.name)) continue;
    scan(full);
  }
}

test('PostgreSQL SQL aliases keep camelCase names quoted', () => {
  for (const relative of sourceRoots) {
    const dir = path.join(root, relative);
    if (fs.existsSync(dir)) walk(dir);
  }
  assert.deepEqual(violations, [],
    'PostgreSQL folds unquoted aliases to lower case; quote them:\n' + violations.join('\n'));
});
