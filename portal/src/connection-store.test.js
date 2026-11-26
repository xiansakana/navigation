import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { connectionStore } from './connection-store.js';

test('store initialization is connection-local and a rolled-back schema is never cached', () => {
  const first = new Database(':memory:');
  const second = new Database(':memory:');
  const getStore = connectionStore(db => {
    db.exec('CREATE TABLE IF NOT EXISTS entries (user_id TEXT)');
    return {
      insert: db.prepare('INSERT INTO entries VALUES (?)'),
      select: db.prepare('SELECT user_id FROM entries WHERE user_id=?'),
    };
  });
  try {
    let rolledBack;
    assert.throws(first.transaction(() => {
      rolledBack = getStore(first);
      rolledBack.insert.run('a');
      throw new Error('rollback');
    }), /rollback/);
    const store = getStore(first);
    assert.notEqual(store, rolledBack);
    assert.equal(getStore(first), store);
    assert.equal(store.select.get('a'), undefined);
    store.insert.run('a');
    assert.ok(getStore(first).select.get('a'));
    assert.equal(getStore(first).select.get('b'), undefined);
    assert.equal(getStore(second).select.get('a'), undefined);
  } finally {
    first.close();
    second.close();
  }
});
