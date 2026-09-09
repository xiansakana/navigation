import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  triggerPrices,
  drawdownPct,
  computeAmmoB,
  bagCaps,
  evaluate,
  shouldReset,
  evaluateLot,
  mediumOtmBand,
  buildBuyPreview,
  tierTriggerText
} from './playbook.js';

const H = 540.81;

test('tier trigger text matches 手册 §D 触发列', () => {
  assert.equal(tierTriggerText('T1'), '−8%');
  assert.equal(tierTriggerText('T2'), '−12% 且 VXN≥25');
  assert.equal(tierTriggerText('T3'), '−18% 且 VXN≥32');
  assert.equal(tierTriggerText('T4'), '收盘 −22% 或盘中 0.75H 限价');
  assert.equal(tierTriggerText('T5'), '−30%');
  assert.equal(tierTriggerText('T6'), '−40%');
  assert.equal(tierTriggerText('T7'), '−50%');
  assert.equal(tierTriggerText('R1'), '已出现过 −22%；收盘站上 20 日线且收盘创 5 日新高');
  assert.equal(tierTriggerText('R2'), 'R1 后 15–20 日未破前低，或 −30% 之后的新 20 日线突破');
});

test('T1–T4 trigger prices from 2025-02-19 high', () => {
  const t = triggerPrices(H);
  assert.equal(t.T1, 497.55);
  assert.equal(t.T2, 475.91);
  assert.equal(t.T3, 443.46);
  assert.equal(t.T4, 421.83);
  assert.equal(t.T4_intraday, 405.61);
  assert.equal(t.T5, 378.57);
  assert.equal(t.T6, 324.49);
  assert.equal(t.T7, 270.4);
  assert.equal(t.reset, 529.99);
});

test('drawdown from H', () => {
  assert.ok(Math.abs(drawdownPct(423.69, H) - (-21.66)) < 0.02);
});

test('ammo B = USD + CNY/rate', () => {
  assert.equal(computeAmmoB(70000, 140000, 7), 90000);
  assert.equal(computeAmmoB(100000, 0, 7.2), 100000);
});

test('default bags 40/30/30', () => {
  const b = bagCaps(100000, 'default');
  assert.equal(b.left, 40000);
  assert.equal(b.crisis, 30000);
  assert.equal(b.right, 30000);
});

test('V-boost bags 55/20/25', () => {
  const b = bagCaps(100000, 'vBoost');
  assert.equal(b.left, 55000);
  assert.equal(b.crisis, 20000);
  assert.equal(b.right, 25000);
});

test('V-boost scales tier pctB and usd', () => {
  const base = evaluate({
    cashUsd: 100000,
    cashCny: 0,
    usdCnyRate: 7,
    variant: 'default',
    qqq: { candles: candlesFromHighClose(H, 530), price: 530, close: 530, low: 529 }
  });
  const boost = evaluate({
    cashUsd: 100000,
    cashCny: 0,
    usdCnyRate: 7,
    variant: 'vBoost',
    qqq: { candles: candlesFromHighClose(H, 530), price: 530, close: 530, low: 529 }
  });
  const t1 = boost.tiers.find((t) => t.id === 'T1');
  const t1Base = base.tiers.find((t) => t.id === 'T1');
  assert.equal(t1Base.pctB, 0.06);
  assert.equal(t1Base.usd, 6000);
  assert.equal(t1.pctB, 0.06 * (0.55 / 0.4));
  assert.equal(t1.usd, 8250);
  const leftSum = boost.tiers.filter((t) => t.bag === 'left').reduce((s, t) => s + t.pctB, 0);
  const crisisSum = boost.tiers.filter((t) => t.bag === 'crisis').reduce((s, t) => s + t.pctB, 0);
  const rightSum = boost.tiers.filter((t) => t.bag === 'right').reduce((s, t) => s + t.pctB, 0);
  assert.ok(Math.abs(leftSum - 0.55) < 1e-9);
  assert.ok(Math.abs(crisisSum - 0.2) < 1e-9);
  assert.ok(Math.abs(rightSum - 0.25) < 1e-9);
});

test('0.98H reset', () => {
  const stats = { H, lastClose: 530, price: 530 };
  assert.equal(shouldReset(stats), true);
  assert.equal(shouldReset({ H, lastClose: 500, price: 500 }), false);
});

function candlesFromHighClose(high, close, n = 60) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const c = i === n - 1 ? close : high - 1;
    const h = i === 0 ? high : c + 0.5;
    rows.push({ t: i, o: c, h, l: c - 1, c });
  }
  return rows;
}

test('T1 confirmed on close −8%', () => {
  const ev = evaluate({
    cashUsd: 100000,
    cashCny: 0,
    usdCnyRate: 7,
    qqq: { candles: candlesFromHighClose(H, 497), price: 497, close: 497, low: 496 },
    vxn: { price: 20 }
  });
  const t1 = ev.tiers.find((t) => t.id === 'T1');
  assert.equal(t1.status, 'confirmed');
  assert.match(t1.recommendation, /只买 QQQ 正股/);
  const t2 = ev.tiers.find((t) => t.id === 'T2');
  assert.equal(t2.status, 'idle');
  const r1 = ev.tiers.find((t) => t.id === 'R1');
  assert.equal(r1.status, 'locked');
});

test('T2 fires with VXN gate: options blocked below 25', () => {
  const ev = evaluate({
    cashUsd: 100000,
    cashCny: 0,
    usdCnyRate: 7,
    qqq: { candles: candlesFromHighClose(H, 470), price: 470, close: 470, low: 468 },
    vxn: { price: 20 }
  });
  const t2 = ev.tiers.find((t) => t.id === 'T2');
  assert.equal(t2.status, 'confirmed');
  assert.equal(t2.vxnGate.blocked, true);
  assert.match(t2.recommendation, /全部改买/);
});

test('T2 allows medium OTM when VXN≥25', () => {
  const ev = evaluate({
    cashUsd: 100000,
    cashCny: 0,
    usdCnyRate: 7,
    qqq: { candles: candlesFromHighClose(H, 470), price: 470, close: 470, low: 468 },
    vxn: { price: 28 }
  });
  const t2 = ev.tiers.find((t) => t.id === 'T2');
  assert.equal(t2.vxnGate.ok, true);
  assert.match(t2.recommendation, /中虚值/);
});

test('T4 intraday 0.75H using 2025-04-07 low 402.39', () => {
  const ev = evaluate({
    cashUsd: 100000,
    cashCny: 0,
    usdCnyRate: 7,
    rth: true,
    qqq: { candles: candlesFromHighClose(H, 423.69), price: 423.69, close: 423.69, low: 402.39 },
    vxn: { price: 40 }
  });
  const t4 = ev.tiers.find((t) => t.id === 'T4');
  assert.equal(t4.status, 'confirmed');
  assert.ok(ev.alerts.some((a) => a.event === 'T4_intraday'));
  assert.equal(ev.round.hasSeenMinus22, true);
});

test('right bag locked before −22%', () => {
  const ev = evaluate({
    cashUsd: 100000,
    cashCny: 0,
    usdCnyRate: 7,
    qqq: { candles: candlesFromHighClose(H, 510), price: 510, close: 510, low: 509 },
    vxn: { price: 30 }
  });
  assert.equal(ev.tiers.find((t) => t.id === 'R1').status, 'locked');
  assert.equal(ev.tiers.find((t) => t.id === 'R2').status, 'locked');
  assert.ok((ev.primary.prohibitions || []).some((p) => /右侧/.test(p)) || /观察|T1/.test(ev.primary.title + ev.primary.body));
});

test('fake right: break R1 swing low with 1% tolerance', () => {
  const ev = evaluate({
    cashUsd: 100000,
    cashCny: 0,
    usdCnyRate: 7,
    round: {
      hasSeenMinus22: true,
      r1At: '2026-01-01T00:00:00.000Z',
      r1SwingLow: 400,
      triggered: { R1: { at: '2026-01-01T00:00:00.000Z' } }
    },
    qqq: { candles: candlesFromHighClose(H, 430), price: 395, close: 395, low: 394 },
    vxn: { price: 30 }
  });
  assert.equal(ev.fakeRight, true);
  assert.equal(ev.round.r2Frozen, true);
  assert.equal(ev.tiers.find((t) => t.id === 'R2').status, 'frozen');
});

test('deep OTM 3x / 5x take-profit', () => {
  const lot3 = evaluateLot({
    id: 'a',
    type: 'call',
    otmClass: 'deep',
    symbol: 'QQQ270115C00700000',
    strike: 700,
    expiry: '2027-01-15',
    cost: 2.35,
    openedAt: '2025-04-07'
  }, { spot: 540, optionPrice: 7.1, now: new Date('2025-05-08') });
  assert.ok(lot3.alerts.some((a) => a.code === 'deep-3x'));

  const lot5 = evaluateLot({
    id: 'b',
    type: 'call',
    otmClass: 'deep',
    cost: 2.35,
    strike: 700,
    expiry: '2027-01-15',
    openedAt: '2025-04-07'
  }, { spot: 540, optionPrice: 12, now: new Date('2025-06-10') });
  assert.ok(lot5.alerts.some((a) => a.code === 'deep-5x'));
});

test('medium OTM strike band is 1.25S–1.40S', () => {
  const band = mediumOtmBand(470);
  assert.equal(band.low, 590);
  assert.equal(band.high, 660);
});

test('buy preview T1 is all QQQ equity', () => {
  const ev = evaluate({
    cashUsd: 100000,
    cashCny: 0,
    usdCnyRate: 7,
    qqq: { candles: candlesFromHighClose(H, 497), price: 497, close: 497, low: 496 },
    vxn: { price: 20 }
  });
  const preview = ev.buyPreview;
  assert.equal(preview.available, true);
  assert.equal(preview.tier, 'T1');
  assert.equal(preview.legs.length, 1);
  assert.equal(preview.legs[0].kind, 'equity');
  assert.equal(preview.legs[0].symbol, 'QQQ');
});

test('buy preview T2 blocked is equity only', () => {
  const ev = evaluate({
    cashUsd: 100000,
    cashCny: 0,
    usdCnyRate: 7,
    qqq: { candles: candlesFromHighClose(H, 470), price: 470, close: 470, low: 468 },
    vxn: { price: 20 }
  });
  const preview = ev.buyPreview;
  assert.equal(preview.tier, 'T2');
  assert.equal(preview.legs.length, 1);
  assert.equal(preview.legs[0].kind, 'equity');
});

test('buy preview T2 with VXN splits equity and call', () => {
  const ev = evaluate({
    cashUsd: 100000,
    cashCny: 0,
    usdCnyRate: 7,
    qqq: { candles: candlesFromHighClose(H, 470), price: 470, close: 470, low: 468 },
    vxn: { price: 28 }
  });
  const preview = ev.buyPreview;
  assert.equal(preview.legs.length, 2);
  assert.equal(preview.legs[0].kind, 'equity');
  assert.equal(preview.legs[1].kind, 'call');
  assert.ok(preview.legs[1].strike >= 585);
});
