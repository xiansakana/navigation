import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  resetPortfolioBridge,
  getPortfolioCash,
  setPortfolioCash,
  migrateDipCashOnce,
  legsToTradeInputs,
  appendTradesDeductFormCash,
  appendTradesApplyCash,
  getPortfolioStore
} from './portfolio-bridge.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function hasSqliteBindings() {
  const candidates = [
    path.join(__dirname, '../../stock-manage/node_modules/better-sqlite3'),
    path.join(__dirname, '../../portal/node_modules/better-sqlite3'),
    'better-sqlite3'
  ];
  for (const candidate of candidates) {
    try {
      const Database = require(candidate);
      const db = new Database(':memory:');
      db.close();
      return true;
    } catch {
      // try next
    }
  }
  return false;
}

const HAS_SQLITE = hasSqliteBindings();

function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-bridge-'));
  const dbPath = path.join(dir, 'navigation.db');
  const prev = process.env.NAVIGATION_DB_PATH;
  process.env.NAVIGATION_DB_PATH = dbPath;
  resetPortfolioBridge();
  try {
    return fn(dbPath);
  } finally {
    resetPortfolioBridge();
    if (prev == null) delete process.env.NAVIGATION_DB_PATH;
    else process.env.NAVIGATION_DB_PATH = prev;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

test('legsToTradeInputs maps equity and call legs', () => {
  const inputs = legsToTradeInputs([
    { kind: 'equity', symbol: '159509', currency: 'CNY', shares: 100, price: 1.5 },
    { kind: 'call', occSymbol: 'QQQ260116C00400000', price: 2, contracts: 2 },
    { kind: 'equity', symbol: 'SKIP', price: 0, shares: 10 }
  ], { tier: 'T1' });
  assert.equal(inputs.length, 2);
  assert.equal(inputs[0].symbol, '159509');
  assert.equal(inputs[0].type, 'buy');
  assert.equal(inputs[1].symbol, 'QQQ260116C00400000');
  assert.equal(inputs[1].shares, 2);
});

test('legsToTradeInputs maps sell side', () => {
  const inputs = legsToTradeInputs([
    { kind: 'equity', side: 'sell', symbol: 'QQQ', currency: 'USD', shares: 5, price: 420 }
  ]);
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].type, 'sell');
});

test('setPortfolioCash then getPortfolioCash round-trip', { skip: !HAS_SQLITE }, () => {
  withTempDb(() => {
    setPortfolioCash({ cashUsd: 1000, cashCny: 7000, usdCnyRate: 7, fxSource: 'test', fxUpdatedAt: '2026-01-01T00:00:00.000Z' });
    const cash = getPortfolioCash();
    assert.equal(cash.cashUsd, 1000);
    assert.equal(cash.cashCny, 7000);
    assert.equal(cash.usdCnyRate, 7);
    assert.equal(cash.fxSource, 'test');
  });
});

test('migrateDipCashOnce imports only empty pockets once', { skip: !HAS_SQLITE }, () => {
  withTempDb(() => {
    setPortfolioCash({ cashUsd: 500, cashCny: 0, usdCnyRate: 7.2 });
    const first = migrateDipCashOnce({ cashUsd: 999, cashCny: 8000, usdCnyRate: 7 });
    assert.equal(first.cash.cashUsd, 500);
    assert.equal(first.cash.cashCny, 8000);
    assert.equal(first.migrated, true);

    const second = migrateDipCashOnce({ cashUsd: 1, cashCny: 1 });
    assert.equal(second.migrated, false);
    assert.equal(second.cash.cashUsd, 500);
    assert.equal(second.cash.cashCny, 8000);
  });
});

test('execute legs write trades and deduct form cash once', { skip: !HAS_SQLITE }, () => {
  withTempDb(() => {
    setPortfolioCash({ cashUsd: 10000, cashCny: 70000, usdCnyRate: 7 });
    const inputs = legsToTradeInputs([
      { kind: 'equity', symbol: '159509', currency: 'CNY', shares: 100, price: 1.5, cny: 150 },
      { kind: 'equity', symbol: 'QQQ', currency: 'USD', shares: 10, price: 400, usd: 4000 },
      { kind: 'call', occSymbol: 'QQQ260116C00400000', price: 2, contracts: 2, usd: 400 }
    ], { tier: 'T1', note: 'test-exec' });

    assert.equal(inputs.length, 3);

    const result = appendTradesDeductFormCash({
      trades: inputs,
      deductCashUsd: 4400,
      deductCashCny: 150
    });

    assert.equal(result.trades.length, 3);
    assert.equal(result.cash.cashUsd, 5600);
    assert.equal(result.cash.cashCny, 69850);

    const store = getPortfolioStore();
    const data = store.read();
    const symbols = data.trades.map((t) => t.symbol).sort();
    assert.deepEqual(symbols, ['159509', 'QQQ', 'QQQ260116C00400000'].sort());
    assert.equal(data.cashUsd, 5600);
    assert.equal(data.cashCny, 69850);
  });
});

test('sell legs apply cash via trade deltas', { skip: !HAS_SQLITE }, () => {
  withTempDb(() => {
    setPortfolioCash({ cashUsd: 1000, cashCny: 0, usdCnyRate: 7 });
    const inputs = legsToTradeInputs([
      { kind: 'equity', side: 'sell', symbol: 'QQQ', currency: 'USD', shares: 5, price: 420 }
    ]);
    const result = appendTradesApplyCash(inputs);
    assert.equal(result.trades.length, 1);
    assert.equal(result.trades[0].type, 'sell');
    assert.equal(result.cash.cashUsd, 1000 + 5 * 420);
  });
});
