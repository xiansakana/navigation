import test from 'node:test';
import assert from 'node:assert/strict';
import { getDatabase } from './connection.js';

test('a PostgreSQL runtime selection cannot fall back to SQLite', () => {
  const previous = process.env.NAVIGATION_DATABASE_ENGINE;
  process.env.NAVIGATION_DATABASE_ENGINE = 'postgres';
  try { assert.throws(() => getDatabase(), { status: 503, code: 'DATABASE_ENGINE_UNAVAILABLE' }); }
  finally {
    if (previous === undefined) delete process.env.NAVIGATION_DATABASE_ENGINE;
    else process.env.NAVIGATION_DATABASE_ENGINE = previous;
  }
});
