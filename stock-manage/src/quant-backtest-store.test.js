import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuantBacktestStore } from './quant-backtest-store.js';

function memoryDatabase() {
  const rows = new Map();
  return {
    prepare(sql) {
      if (sql.includes('INSERT INTO')) return { run: (id, userId, payload, createdAt) => rows.set(id, { id, userId, payload, createdAt }) };
      if (sql.includes('ORDER BY')) return { all: (userId, limit) => [...rows.values()].filter((row) => row.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit) };
      if (sql.startsWith('SELECT')) return { get: (id, userId) => rows.get(id)?.userId === userId ? rows.get(id) : undefined };
      return { run: (id, userId) => ({ changes: rows.get(id)?.userId === userId && rows.delete(id) ? 1 : 0 }) };
    }
  };
}

test('persists, isolates and deletes backtest results by user', () => {
  const store = createQuantBacktestStore({}, memoryDatabase());
  const saved = store.save('user-a', {
    period: '5y',
    initialCapital: 10000,
    finalEquity: 12000,
    totalReturn: 0.2,
    buyHoldReturn: 0.1,
    completedTrades: 3,
    results: [{ symbol: 'AAPL' }]
  });
  assert.equal(store.list('user-a')[0].period, '5y');
  assert.equal(store.list('user-b').length, 0);
  assert.equal(store.get('user-b', saved.id), null);
  assert.equal(store.remove('user-b', saved.id), false);
  assert.equal(store.remove('user-a', saved.id), true);
  assert.equal(store.get('user-a', saved.id), null);
});
