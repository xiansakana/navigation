import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuantStore, resetPaper } from './quant-store.js';

function memoryDatabase() {
  const rows = new Map();
  return {
    prepare(sql) {
      if (sql.startsWith('SELECT')) return { get: (userId) => rows.has(userId) ? { data: rows.get(userId) } : undefined };
      return { run: (userId, data) => rows.set(userId, data) };
    }
  };
}

test('persists isolated quant settings per user', () => {
  const store = createQuantStore({ dataFile: 'missing.json' }, memoryDatabase());
  const value = store.read('user-a');
  value.settings.symbols = ['aapl', 'MSFT', 'AAPL', 'bad symbol'];
  value.settings.period = '2y';
  store.write('user-a', value);
  const saved = store.read('user-a');
  assert.deepEqual(saved.settings.symbols, ['AAPL', 'MSFT']);
  assert.equal(saved.settings.period, '2y');
  assert.notDeepEqual(store.read('user-b').settings.symbols, saved.settings.symbols);
});

test('resets paper portfolio without touching the watchlist', () => {
  const paper = resetPaper({ paperInitialCapital: 250000 });
  assert.equal(paper.cash, 250000);
  assert.deepEqual(paper.holdings, {});
  assert.deepEqual(paper.trades, []);
});
