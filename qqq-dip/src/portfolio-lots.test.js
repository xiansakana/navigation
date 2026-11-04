import test from 'node:test';
import assert from 'node:assert/strict';
import { portfolioDipLots } from './portfolio-lots.js';
import { legsToTradeInputs } from '../../shared/db/portfolio-bridge.js';
import { evaluate } from './playbook.js';

const buy = { id: 'dip', account_id: 'a', currency: 'CNY', symbol: '159509', type: 'buy', source: 'qqq-dip', shares: 2300, price: 2.96, trade_date: '2026-11-04T06:11:00Z', tier: 'T1' };
test('CNY lots use their own ETF mark rather than the QQQ dollar price', () => {
  const ev = evaluate({ cashUsd: 1000, usdCnyRate: 7, qqq: { price: 600, candles: [{ h: 600, c: 600 }] },
    cnyProxy: { price: 3, candles: [] }, lots: portfolioDipLots([buy]) });
  assert.equal(ev.lots[0].mark, 3);
});
test('projects actual fills idempotently while retaining monitoring metadata', () => {
  const lots = portfolioDipLots([buy]);
  assert.equal(lots[0].qty, 2300);
  assert.equal(lots[0].cost, 2.96);
  assert.equal(lots[0].currency, 'CNY');
  const saved = [{ ...lots[0], holdingHigh: 4, reached3x: true }];
  assert.equal(portfolioDipLots([buy], saved)[0].holdingHigh, 4);
  assert.equal(portfolioDipLots([buy], saved).length, 1);
  assert.deepEqual(portfolioDipLots([], saved), []);
  assert.deepEqual(portfolioDipLots([buy], saved, ['portfolio:dip']), []);
});
test('FIFO includes ordinary buys and isolates accounts and symbols on sales', () => {
  const ordinary = { ...buy, id: 'ordinary', source: 'manual', shares: 1000, trade_date: '2026-11-03T06:11:00Z' };
  const sale = { ...buy, id: 'sale', type: 'sell', shares: 1500, trade_date: '2026-11-05T06:11:00Z' };
  assert.equal(portfolioDipLots([sale, buy, ordinary])[0].qty, 1800);
  assert.equal(portfolioDipLots([buy, { ...sale, account_id: 'b' }])[0].qty, 2300);
  assert.deepEqual(portfolioDipLots([buy, { ...sale, shares: 2300 }]), []);
});
test('option quantities stay in contracts and OCC strike is decoded', () => {
  const lot = portfolioDipLots([{ ...buy, symbol: 'O:QQQ270115C00700500', currency: 'USD', shares: 2 }])[0];
  assert.equal(lot.qty, 2);
  assert.equal(lot.type, 'call');
  assert.equal(lot.strike, 700.5);
  assert.equal(lot.expiry, '2027-01-15');
});
test('security names never use strategy instructions; notes retain them', () => {
  const [trade] = legsToTradeInputs([{ kind: 'equity', symbol: '159509', currency: 'CNY', shares: 2300, price: 2.96, note: 'T1 只买正股' }]);
  assert.equal(trade.name, '纳指科技ETF景顺');
  assert.match(trade.note, /T1 只买正股/);
});
