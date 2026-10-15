import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { initSchema } from '../../shared/db/schema.js';
import { createPortfolioStore } from '../../shared/db/portfolio-store.js';
import { createBookkeepingStore } from '../../portal/src/bookkeeping-store.js';
import { saveInvestmentAccount, projectInvestments, unlinkInvestmentAccount } from '../../shared/investment-accounts.js';
import { deriveHoldings, computePnl, computeSymbolSummaries, buildDailyCumulativeSeries } from './trades.js';
import { computeTradeReview } from './trade-review.js';
import { assetTrends } from '../../portal/src/bookkeeping-analysis.js';
const require = createRequire(import.meta.url);
const Database = require('../../portal/node_modules/better-sqlite3');
const setup = () => { const db = new Database(':memory:'); initSchema(db); return { db, ledger: createBookkeepingStore(db), stock: createPortfolioStore(db, 'u') }; };
const trade = (id, type, account, amount, date = '2090-01-01T00:00:00Z') => ({ id, type, account_id: account, symbol: 'AAPL', name: 'Apple', currency: 'USD', shares: 1, price: amount, total_amount: amount, commission: 1, trade_date: date });

test('stale total assets never initialize cash; historical trades do not replay after binding', () => {
  const { db, ledger, stock } = setup();
  try {
    const lid = ledger.saveAccount('u', { name: '海外理财', currency: 'USD', balance: 99999 });
    const a = saveInvestmentAccount(db, 'u', { name: '券商USD', currency: 'USD', bookkeepingId: lid, baselineCash: 1000 });
    stock.write({ trades: [trade('old', 'buy', a, 100, '2020-01-01T00:00:00Z')], quotes: { AAPL: { price: 150 } } });
    assert.equal(stock.read().cashUsd, 1000);
    const view = ledger.accounts('u')[0];
    assert.equal(view.balance, 1150);
    assert.equal(view.investment.oldLedgerBalance, 99999);
    assert.equal(view.ledgerBalance, 99999);
  } finally { db.close(); }
});

test('stock buy, sell, fees, updates and deletes dynamically project once into both views', () => {
  const { db, ledger, stock } = setup();
  try {
    const lid = ledger.saveAccount('u', { name: '券商', currency: 'USD', balance: 5000 });
    const a = saveInvestmentAccount(db, 'u', { name: 'A', currency: 'USD', bookkeepingId: lid, baselineCash: 1000 });
    stock.write({ trades: [trade('buy', 'buy', a, 100)], quotes: { AAPL: { price: 120 } } });
    assert.equal(stock.read().cashUsd, 899);
    assert.equal(ledger.accounts('u')[0].balance, 1019);
    const data = stock.read(); data.trades.push(trade('sell', 'sell', a, 130, '2090-01-02T00:00:00Z')); stock.write(data);
    assert.equal(stock.read().cashUsd, 1028);
    assert.equal(ledger.accounts('u')[0].balance, 1028);
    data.trades[1].total_amount = 140; stock.write(data);
    assert.equal(stock.read().cashUsd, 1038);
    stock.write(stock.read()); assert.equal(stock.read().cashUsd, 1038);
    const next = stock.read(); next.trades = []; stock.write(next);
    assert.equal(stock.read().cashUsd, 1000);
    assert.equal(ledger.entries('u').length, 0, 'trade principal is not everyday income/expense');
  } finally { db.close(); }
});

test('bookkeeping transfer and fee update cash and preserve net assets without adding legacy balances', () => {
  const { db, ledger, stock } = setup();
  try {
    const bank = ledger.saveAccount('u', { name: '银行', currency: 'USD', balance: 1000 });
    const broker = ledger.saveAccount('u', { name: '券商', currency: 'USD', balance: 9999 });
    ledger.accounts('u');
    saveInvestmentAccount(db, 'u', { name: 'A', currency: 'USD', bookkeepingId: broker, baselineCash: 100 });
    const entry = ledger.saveEntry('u', { type: '转账', date: '2090-01-01T12:00:00', amount: 200, fee: 2, currency: 'USD', accountId: bank, toAccountId: broker });
    assert.equal(stock.read().cashUsd, 300);
    assert.equal(ledger.accounts('u').find((a) => a.id === bank).balance, 798);
    assert.equal(ledger.accounts('u').reduce((s, a) => s + a.balance, 0), 1098);
    ledger.removeEntry('u', entry);
    assert.equal(stock.read().cashUsd, 100);
    assert.equal(ledger.accounts('u').find((a) => a.id === bank).balance, 1000);
  } finally { db.close(); }
});

test('missing quotes prevent partial asset totals, while cash and other currencies stay accurate', () => {
  const { db, stock, ledger } = setup();
  try {
    const lid = ledger.saveAccount('u', { name: '券商', currency: 'USD', balance: 1 });
    const a = saveInvestmentAccount(db, 'u', { name: 'A', currency: 'USD', bookkeepingId: lid, baselineCash: 100 });
    saveInvestmentAccount(db, 'u', { name: '人民币', currency: 'CNY', baselineCash: 500 });
    stock.write({ trades: [trade('old', 'buy', a, 10, '2020-01-01T00:00:00Z')] });
    assert.equal(ledger.accounts('u')[0].balance, null);
    assert.equal(stock.read().cashUsd, 100); assert.equal(stock.read().cashCny, 500);
    const data = stock.read(); data.quotes = { AAPL: { price: 12 } }; stock.write(data);
    assert.equal(ledger.accounts('u')[0].balance, 112);
  } finally { db.close(); }
});

test('binding ownership, currency, uniqueness and linked account mutations are enforced', () => {
  const { db, ledger } = setup();
  try {
    const foreign = ledger.saveAccount('v', { name: '别人的', currency: 'USD', balance: 10 });
    assert.throws(() => saveInvestmentAccount(db, 'u', { name: 'A', currency: 'USD', bookkeepingId: foreign, baselineCash: 0 }));
    const lid = ledger.saveAccount('u', { name: '自己', currency: 'USD', balance: 10 });
    assert.throws(() => saveInvestmentAccount(db, 'u', { name: 'A', currency: 'CNY', bookkeepingId: lid, baselineCash: 0 }));
    saveInvestmentAccount(db, 'u', { name: 'A', currency: 'USD', bookkeepingId: lid, baselineCash: 0 });
    assert.throws(() => saveInvestmentAccount(db, 'u', { name: 'B', currency: 'USD', bookkeepingId: lid, baselineCash: 10 }));
    assert.throws(() => ledger.adjust('u', lid, { balance: 123, date: '2090-01-01T12:00:00' }));
    assert.throws(() => ledger.archiveAccount('u', lid, true));
    assert.throws(() => ledger.removeAccount('u', lid));
    assert.equal(projectInvestments(db, 'v').length, 0);
  } finally { db.close(); }
});

test('same symbol in different accounts cannot match FIFO costs or dispose another account holdings', () => {
  const buy = { ...trade('a-buy', 'buy', 'a', 100, '2020-01-01T00:00:00Z'), commission: 0 };
  const sell = { ...trade('b-sell', 'sell', 'b', 200, '2020-01-02T00:00:00Z'), commission: 0 };
  assert.equal(deriveHoldings([buy, sell])[0].shares, 1);
  assert.equal(computePnl([buy, sell]).realizedPL, 0);
  assert.ok(computeSymbolSummaries([buy, sell]).some((s) => s.pnlRateUnavailableReason === 'missing-buy-cost'));
  assert.equal(computeTradeReview([buy, sell]).currencies[0].unmatched.length, 1);
  assert.equal(buildDailyCumulativeSeries([buy, sell]).at(-1).cumulativeNet, 0);
});

test('unlink freezes current equity to bookkeeping and retains broker cash, with an audit trail', () => {
  const { db, ledger, stock } = setup();
  try {
    const lid = ledger.saveAccount('u', { name: '券商', currency: 'USD', balance: 9999 });
    const a = saveInvestmentAccount(db, 'u', { name: 'A', currency: 'USD', bookkeepingId: lid, baselineCash: 100 });
    stock.write({ trades: [trade('old', 'buy', a, 10, '2020-01-01T00:00:00Z')], quotes: { AAPL: { price: 20 } } });
    unlinkInvestmentAccount(db, 'u', a);
    assert.equal(stock.read().cashUsd, 100);
    assert.equal(ledger.accounts('u')[0].balance, 120);
    assert.equal(ledger.accounts('u')[0].balanceSource, undefined);
    assert.equal(ledger.entries('u').filter((e) => e.type === '余额调整').length, 1);
  } finally { db.close(); }
});

test('cash reconciliation anchors existing records and does not replay them on refresh', () => {
  const { db, stock, ledger } = setup();
  try {
    const lid = ledger.saveAccount('u', { name: '券商', currency: 'USD', balance: 99 });
    const a = saveInvestmentAccount(db, 'u', { name: 'A', currency: 'USD', bookkeepingId: lid, baselineCash: 1000 });
    stock.write({ trades: [trade('buy', 'buy', a, 100)], quotes: { AAPL: { price: 100 } } });
    assert.equal(stock.read().cashUsd, 899);
    saveInvestmentAccount(db, 'u', { name: 'A', baselineCash: 800 }, a);
    assert.equal(stock.read().cashUsd, 800);
    stock.write(stock.read()); assert.equal(stock.read().cashUsd, 800);
    const data = stock.read(); data.trades.push(trade('sell', 'sell', a, 120, '2090-01-02T00:00:00Z')); stock.write(data);
    assert.equal(stock.read().cashUsd, 919);
    const trend = assetTrends(ledger.accounts('u'), [], '2026-10-15', { USD: 7.2 });
    assert.equal(trend.currentOnly, true);
    assert.equal(trend.period, undefined);
  } finally { db.close(); }
});
