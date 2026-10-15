import test from 'node:test';
import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import { normalizeOtherAmount, correctDividendTaxPortfolio } from '../../shared/dividend-tax.js';
import { normalizeTrade } from './trades.js';
import { parseImportBuffer } from './import-moomoo.js';
import { createPortfolioStore } from '../../shared/db/portfolio-store.js';
import { createRequire } from 'node:module';

test('manual tax amounts become negative, preserving negative taxes and positive dividends', () => {
  assert.equal(normalizeOtherAmount(' 股息税 ', 1.23), -1.23);
  assert.equal(normalizeOtherAmount('股息税', -1.23), -1.23);
  assert.equal(normalizeOtherAmount('股息', 1.23), 1.23);
  assert.equal(normalizeTrade({ type: 'other', other_category: '股息税', total_amount: 1.23, currency: 'USD' }).total_amount, -1.23);
});

test('xlsx imports automatically sign dividend taxes as expenses', () => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    ['时间', '类型', '交易方向', '其它类别', '代码', '名称', '币种', '股数', '价格', '金额', '手续费'],
    ['2026-01-01 12:00:00', '其它收支', '其它', '股息税', 'AAPL', 'AAPL', 'USD', 1, 0, 5, 0],
    ['2026-01-02 12:00:00', '其它收支', '其它', '股息', 'AAPL', 'AAPL', 'USD', 1, 0, 10, 0]
  ]), '交易记录');
  const rows = parseImportBuffer(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
  assert.equal(rows[0].total_amount, -5);
  assert.equal(rows[1].total_amount, 10);
});

test('cash correction applies only sign deltas and is idempotent, leaving unrelated data intact', () => {
  const raw = { cashUsd: 100, cashCny: 200, usdCnyRate: 7, trades: [
    { id: 'a', type: 'other', other_category: '股息税', total_amount: 5, currency: 'USD', commission: 1 },
    { id: 'b', type: 'other', other_category: '股息税', total_amount: 3, currency: 'CNY' },
    { id: 'c', type: 'other', other_category: '股息税', total_amount: -2, currency: 'USD' },
    { id: 'd', type: 'other', other_category: '股息', total_amount: 8, currency: 'USD' }
  ] };
  const fixed = correctDividendTaxPortfolio(raw);
  assert.equal(fixed.cashUsd, 90);
  assert.equal(fixed.cashCny, 194);
  assert.equal(fixed.trades[0].commission, 1);
  assert.equal(fixed.trades[3].total_amount, 8);
  assert.equal(raw.trades[0].total_amount, 5);
  assert.deepEqual(correctDividendTaxPortfolio(fixed), fixed);
});

test('database writes enforce expense signs when callers bypass trade normalization', () => {
  const require = createRequire(import.meta.url);
  // The shared store uses Portal's native SQLite binding first on ECS.
  const Database = require('../../portal/node_modules/better-sqlite3');
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT); CREATE TABLE trades(id TEXT PRIMARY KEY, data TEXT); CREATE TABLE quotes(symbol TEXT PRIMARY KEY, data TEXT); CREATE TABLE holdings_meta(symbol TEXT PRIMARY KEY, data TEXT);');
    const store = createPortfolioStore(db, 'test-user');
    store.write({ cashUsd: 100, cashCny: 0, trades: [{ id: '1', type: 'other', other_category: '股息税', total_amount: 5, currency: 'USD' }] });
    assert.equal(store.read().trades[0].total_amount, -5);
    assert.equal(store.read().cashUsd, 90);
    store.write(store.read());
    assert.equal(store.read().cashUsd, 90);
  } finally { db.close(); }
});
