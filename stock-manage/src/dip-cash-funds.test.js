import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { initSchema } from '../../shared/db/schema.js';
import { createPortfolioStore } from '../../shared/db/portfolio-store.js';
import { saveInvestmentAccount } from '../../shared/investment-accounts.js';
import { dipCashFunds, setDipCashReserve } from '../../shared/dip-cash-funds.js';
const require = createRequire(import.meta.url);
const Database = require('../../portal/node_modules/better-sqlite3');
function fixture(t) {
  const db = new Database(':memory:'); initSchema(db); t.after(() => db.close());
  const store = createPortfolioStore(db, 'u');
  const id = saveInvestmentAccount(db, 'u', { name: 'USD', currency: 'USD', baselineCash: 1000 });
  setDipCashReserve(db, 'u', id, 600);
  const trade = (key, amount, type = 'buy') => ({ id: key, account_id: id, type, symbol: 'QQQ',
    currency: 'USD', shares: 1, price: amount, total_amount: amount, commission: 0, trade_date: '2090-01-01T00:00:00Z' });
  return { db, store, id, trade, fund: () => dipCashFunds(db, 'u')[0] };
}
test('reserves partition cash without changing cash, assets or creating trades', (t) => {
  const { db, store, id, fund } = fixture(t);
  assert.equal(store.read().cashUsd, 1000); assert.equal(store.read().trades.length, 0);
  assert.equal(fund().ordinaryAvailable, 400);
  setDipCashReserve(db, 'u', id, 200);
  assert.equal(fund().ordinaryAvailable, 800); assert.equal(store.read().cashUsd, 1000);
  assert.throws(() => setDipCashReserve(db, 'other', id, 10), /本人/);
  assert.deepEqual(dipCashFunds(db, 'other'), []);
});
test('ordinary buys and edited trades cannot consume reserved funds', (t) => {
  const { store, trade, fund } = fixture(t);
  assert.throws(() => store.write({ ...store.read(), trades: [trade('a', 500)] }), /普通可用/);
  assert.equal(store.read().trades.length, 0);
  store.write({ ...store.read(), trades: [trade('a', 300)] });
  assert.equal(fund().reserved, 600); assert.equal(fund().ordinaryAvailable, 100);
  assert.throws(() => store.write({ ...store.read(), trades: [trade('a', 450)] }), /普通可用/);
});
test('strategy cash and account cash decrease together and edits reverse only actual delta', (t) => {
  const { store, id, trade, fund } = fixture(t);
  store.write({ ...store.read(), trades: [trade('a', 200)] }, { strategyFundId: id });
  assert.equal(store.read().cashUsd, 800); assert.equal(fund().reserved, 400); assert.equal(fund().ordinaryAvailable, 400);
  store.write({ ...store.read(), trades: [trade('a', 100)] });
  assert.equal(fund().reserved, 500);
  store.write({ ...store.read(), trades: [] }); assert.equal(fund().reserved, 600);
});
test('external facts are imported with a deficit and strategy spending is paused', (t) => {
  const { store, id, trade, fund } = fixture(t);
  store.write({ ...store.read(), trades: [trade('external', 700)] }, { externalSync: true });
  assert.equal(fund().deficit, 300); assert.equal(fund().ordinaryAvailable, 0);
  assert.equal(fund().strategyAvailable, 0);
  assert.throws(() => store.write({ ...store.read(), trades: [...store.read().trades, trade('dip', 50)] }, { strategyFundId: id }), /暂停/);
  assert.equal(store.read().trades.length, 1);
});
test('caller-supplied strategy tags do not bypass ordinary-cash checks', (t) => {
  const { store, id, trade } = fixture(t);
  assert.throws(() => store.write({ ...store.read(), trades: [{ ...trade('a', 500), dip_fund_account: id }] }), /普通可用/);
});

test('reconciled historical trades do not refund reserves again when removed', (t) => {
  const { db, store, id, trade, fund } = fixture(t);
  store.write({ ...store.read(), trades: [trade('dip', 200)] }, { strategyFundId: id });
  saveInvestmentAccount(db, 'u', { baselineCash: 800 }, id);
  store.write({ ...store.read(), trades: [] });
  assert.equal(store.read().cashUsd, 800);
  assert.equal(fund().reserved, 400);
});
