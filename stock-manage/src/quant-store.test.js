import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createQuantStore, resetPaper } from './quant-store.js';

test('persists an independent quant watchlist and settings', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-quant-'));
  const file = path.join(directory, 'quant.json');
  const store = createQuantStore({ dataFile: path.join(directory, 'portfolio.json') }, file);
  const value = store.read();
  value.settings.symbols = ['aapl', 'MSFT', 'AAPL', 'bad symbol'];
  value.settings.period = '2y';
  store.write(value);
  const saved = store.read();
  assert.deepEqual(saved.settings.symbols, ['AAPL', 'MSFT']);
  assert.equal(saved.settings.period, '2y');
  fs.rmSync(directory, { recursive: true, force: true });
});

test('resets paper portfolio without touching the watchlist', () => {
  const paper = resetPaper({ paperInitialCapital: 250000 });
  assert.equal(paper.cash, 250000);
  assert.deepEqual(paper.holdings, {});
  assert.deepEqual(paper.trades, []);
});
