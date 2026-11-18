import { tradeAssetType } from '../public/js/trade-asset-type.js';
import { dateTimeFormatter } from './date-formatters.js';
import { normalizeOtherAmount } from '../../shared/dividend-tax.js';
import { fundCode, fundTradeOrder } from '../../shared/fund-holdings.js';
import { Decimal, roundDecimal, tradeCashAmount } from '../../shared/portfolio-decimal.js';
import {
  normalizeSymbol,
  inferCurrency,
  holdingTypeForSymbol,
  isAShareSymbol
} from './markets.js';
import { DEFAULT_USD_CNY_RATE } from '../../shared/db/portfolio-store.js';

export function isOptionSymbol(symbol) {
  return /^[A-Z]+\d{6}[CP]\d+(?:\.\d+)?$/i.test(String(symbol || '').trim());
}

export function optionMult(symbol) {
  return isOptionSymbol(symbol) ? 100 : 1;
}

export function roundMoney(n) {
  return roundDecimal(n, 2);
}

export function roundPrice(n) {
  return roundDecimal(n, 3);
}

export function roundTradePrice(value, symbol) {
  return roundDecimal(value, fundCode(symbol) ? 4 : 3);
}

export function tradeCurrency(trade) {
  return inferCurrency(trade?.symbol, trade?.currency);
}

/** Cash delta in the trade's native currency. */
export function cashDelta(trade) {
  return roundMoney(tradeCashAmount({
    ...trade, total_amount: roundMoney(trade.total_amount || 0), commission: roundMoney(trade.commission || 0)
  }));
}

function decimalUsd(amount, currency, rate = DEFAULT_USD_CNY_RATE, usdHkdRate) {
  const n = amount instanceof Decimal ? amount : new Decimal(Number(amount) || 0);
  const r = Number(rate) > 0 ? Number(rate) : DEFAULT_USD_CNY_RATE;
  if (String(currency).toUpperCase() === 'CNY') return n.div(r);
  if (String(currency).toUpperCase() === 'HKD' && !n.isZero()) return n.div(usdHkdRate > 0 ? usdHkdRate : NaN);
  return n;
}

export function toUsd(amount, currency, rate, usdHkdRate) {
  return decimalUsd(amount, currency, rate, usdHkdRate).toNumber();
}

export function cashUsdEquivalent(cashUsd, cashCny, rate = DEFAULT_USD_CNY_RATE, cashHkd = 0, usdHkdRate) {
  return roundMoney(decimalUsd(cashUsd, 'USD', rate).plus(decimalUsd(cashCny, 'CNY', rate)).plus(decimalUsd(cashHkd, 'HKD', rate, usdHkdRate)));
}

export function applyCashDelta(cashState, trade) {
  const delta = cashDelta(trade);
  const cur = tradeCurrency(trade);
  const next = {
    cashUsd: Number(cashState.cashUsd) || 0,
    cashCny: Number(cashState.cashCny) || 0,
    ...(cur === 'HKD' || cashState.cashHkd != null ? { cashHkd: Number(cashState.cashHkd) || 0, usdHkdRate: cashState.usdHkdRate } : {}),
    usdCnyRate: Number(cashState.usdCnyRate) > 0 ? Number(cashState.usdCnyRate) : DEFAULT_USD_CNY_RATE
  };
  const key = currencyCashKey(cur);
  next[key] = roundMoney(new Decimal(next[key]).plus(delta));
  next.cash = cashUsdEquivalent(next.cashUsd, next.cashCny, next.usdCnyRate, next.cashHkd, next.usdHkdRate);
  return next;
}

/** Reverse a previously applied trade cash effect. */
export function undoCashDelta(cashState, trade) {
  const delta = cashDelta(trade);
  const cur = tradeCurrency(trade);
  const next = {
    cashUsd: Number(cashState.cashUsd) || 0,
    cashCny: Number(cashState.cashCny) || 0,
    ...(cur === 'HKD' || cashState.cashHkd != null ? { cashHkd: Number(cashState.cashHkd) || 0, usdHkdRate: cashState.usdHkdRate } : {}),
    usdCnyRate: Number(cashState.usdCnyRate) > 0 ? Number(cashState.usdCnyRate) : DEFAULT_USD_CNY_RATE
  };
  const key = currencyCashKey(cur);
  next[key] = roundMoney(new Decimal(next[key]).minus(delta));
  next.cash = cashUsdEquivalent(next.cashUsd, next.cashCny, next.usdCnyRate, next.cashHkd, next.usdHkdRate);
  return next;
}

function currencyCashKey(currency) {
  return { CNY: 'cashCny', HKD: 'cashHkd' }[currency] || 'cashUsd';
}

export const APP_TIME_ZONE = process.env.STOCK_TZ || 'Asia/Shanghai';

export function zonedDateKey(date = new Date(), timeZone = APP_TIME_ZONE) {
  return dateTimeFormatter('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

export function tradeCalendarDate(iso, timeZone = APP_TIME_ZONE) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    const s = String(iso || '').slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
  }
  return zonedDateKey(d, timeZone);
}

export function formatZonedDateTime(iso, timeZone = APP_TIME_ZONE) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || '');
  const parts = dateTimeFormatter('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    hourCycle: 'h23'
  }).formatToParts(d);
  const g = (type) => parts.find((p) => p.type === type)?.value || '';
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}:${g('second')}`;
}

function tradeTime(t) {
  return new Date(t).getTime();
}

function compareTrades(a, b) {
  return Number(!!b.openingFund) - Number(!!a.openingFund)
    || tradeTime(a.trade_date) - tradeTime(b.trade_date) || fundTradeOrder(a) - fundTradeOrder(b) || a.id.localeCompare(b.id);
}

function dateKey(t) {
  return tradeCalendarDate(t.trade_date);
}

function unitCost(trade) {
  if (fundCode(trade.symbol) && Number.isFinite(trade.total_amount) && trade.shares > 0) {
    return new Decimal(trade.total_amount).div(trade.shares);
  }
  return new Decimal(Number(trade.price));
}

function tradeLot(trade) {
  return { shares: new Decimal(Number(trade.shares)), price: unitCost(trade) };
}

function applyFifoSellToQueue(buyQueue, trade, symbol, matched = null) {
  const mult = optionMult(symbol);
  const sellPrice = unitCost(trade);
  let gain = new Decimal(0);
  let remaining = new Decimal(Number(trade.shares));
  let cost = new Decimal(0);
  while (remaining.gt(0) && buyQueue.length) {
    const lot = buyQueue[0];
    const sold = Decimal.min(remaining, lot.shares);
    if (matched) cost = cost.plus(sold.times(lot.price).times(mult));
    gain = gain.plus(sold.times(sellPrice.minus(lot.price)).times(mult));
    lot.shares = lot.shares.minus(sold);
    remaining = remaining.minus(sold);
    if (lot.shares.lte(0)) buyQueue.shift();
  }
  if (matched) {
    matched.cost = cost;
    matched.unmatchedShares = Decimal.max(0, remaining).toNumber();
  }
  return gain;
}

export function parseOptionInfo(symbol) {
  const m = String(symbol).toUpperCase().match(/^([A-Z]+)(\d{6})([CP])(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const exp = m[2];
  const y = 2000 + Number(exp.slice(0, 2));
  const mo = Number(exp.slice(2, 4));
  const day = Number(exp.slice(4, 6));
  return {
    underlying: m[1],
    expiration: `${y}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    type: m[3] === 'C' ? 'Call' : 'Put',
    strike: m[4]
  };
}

export function deriveHoldings(trades) {
  const bySym = new Map();
  for (const t of trades) {
    if (t.type !== 'buy' && t.type !== 'sell') continue;
    const sym = normalizeSymbol(t.symbol);
    if (!sym) continue;
    if (!bySym.has(JSON.stringify([t.account_id || '', sym]))) bySym.set(JSON.stringify([t.account_id || '', sym]), []);
    bySym.get(JSON.stringify([t.account_id || '', sym])).push(t);
  }

  const out = [];
  for (const [, list] of bySym) {
    const symbol = normalizeSymbol(list[0].symbol);
    list.sort(compareTrades);
    const queue = [];
    let name = symbol;
    for (const tr of list) {
      if (tr.name) name = tr.name;
      if (tr.type === 'buy') queue.push(tradeLot(tr));
      else applyFifoSellToQueue(queue, tr, symbol);
    }
    const shares = queue.reduce((s, x) => s.plus(x.shares), new Decimal(0));
    if (shares.lte(0)) continue;
    const cost = queue.reduce((s, x) => s.plus(x.shares.times(x.price)), new Decimal(0));
    const type = holdingTypeForSymbol(symbol);
    out.push({
      accountId: list[0].account_id || '',
      symbol,
      name,
      shares: shares.toNumber(),
      avgCost: cost.div(shares).toNumber(),
      costBasisNative: cost.times(optionMult(symbol)).toNumber(),
      costLots: queue.map(x => ({ shares: x.shares.toNumber(), costPerShare: x.price.toNumber() })),
      type,
      currency: inferCurrency(symbol)
    });
  }
  out.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return out;
}

export function computePnl(trades, options = {}) {
  const { startDate, endDate } = options;
  const usdHkdRate = options.usdHkdRate;
  const rate = Number(options.usdCnyRate) > 0 ? Number(options.usdCnyRate) : DEFAULT_USD_CNY_RATE;
  const inWindow = (t) => {
    const d = dateKey(t);
    if (!d) return false;
    if (startDate && d < startDate) return false;
    if (endDate && d > endDate) return false;
    return true;
  };

  let totalBuy = new Decimal(0);
  let totalSell = new Decimal(0);
  let commission = new Decimal(0);
  let otherAmount = new Decimal(0);
  for (const t of trades) {
    if (t.openingFund || !inWindow(t)) continue;
    const cur = tradeCurrency(t);
    commission = commission.plus(decimalUsd(t.commission, cur, rate, usdHkdRate));
    if (t.type === 'buy') totalBuy = totalBuy.plus(decimalUsd(t.total_amount, cur, rate, usdHkdRate));
    else if (t.type === 'sell') totalSell = totalSell.plus(decimalUsd(t.total_amount, cur, rate, usdHkdRate));
    else if (t.type === 'other') otherAmount = otherAmount.plus(decimalUsd(t.total_amount, cur, rate, usdHkdRate));
  }

  const fifoTrades = trades.filter((t) => t.type === 'buy' || t.type === 'sell');
  const bySym = new Map();
  for (const t of fifoTrades) {
    const sym = normalizeSymbol(t.symbol);
    if (!bySym.has(JSON.stringify([t.account_id || '', sym]))) bySym.set(JSON.stringify([t.account_id || '', sym]), []);
    bySym.get(JSON.stringify([t.account_id || '', sym])).push(t);
  }

  let realized = new Decimal(0);
  for (const [, list] of bySym) {
    const symbol = normalizeSymbol(list[0].symbol);
    list.sort((a, b) => fundCode(symbol) ? compareTrades(a, b) : tradeTime(a.trade_date) - tradeTime(b.trade_date));
    const queue = [];
    const cur = isAShareSymbol(symbol) ? 'CNY' : 'USD';
    for (const tr of list) {
      if (tr.type === 'buy') queue.push(tradeLot(tr));
      else {
        const gainNative = applyFifoSellToQueue(queue, tr, tr.symbol);
        realized = realized.plus(decimalUsd(gainNative, tradeCurrency(tr) || cur, rate, usdHkdRate));
      }
    }
  }

  return {
    totalBuy: roundMoney(totalBuy),
    totalSell: roundMoney(totalSell),
    commission: roundMoney(commission),
    otherAmount: roundMoney(otherAmount),
    realizedPL: roundMoney(realized),
    netPL: roundMoney(realized.minus(commission).plus(otherAmount))
  };
}

export function computeSymbolSummaries(trades, options = {}) {
  const { startDate, endDate } = options;
  const usdHkdRate = options.usdHkdRate;
  const rate = Number(options.usdCnyRate) > 0 ? Number(options.usdCnyRate) : DEFAULT_USD_CNY_RATE;
  const symbolsInWindow = new Set();
  for (const t of trades) {
    if (t.openingFund || (t.type !== 'buy' && t.type !== 'sell')) continue;
    const d = dateKey(t);
    if (!d) continue;
    if (startDate && d < startDate) continue;
    if (endDate && d > endDate) continue;
    if (options.assetType && options.assetType !== 'all' && tradeAssetType(t) !== options.assetType) continue;
    if (options.symbol && !normalizeSymbol(t.symbol).includes(normalizeSymbol(options.symbol))) continue;
    symbolsInWindow.add(normalizeSymbol(t.symbol));
  }

  const bySym = new Map();
  for (const t of trades) {
    if (t.type !== 'buy' && t.type !== 'sell') continue;
    const sym = normalizeSymbol(t.symbol);
    if (!symbolsInWindow.has(sym)) continue;
    const d = dateKey(t);
    if (!d || (endDate && d > endDate)) continue;
    if (!bySym.has(JSON.stringify([t.account_id || '', sym]))) bySym.set(JSON.stringify([t.account_id || '', sym]), []);
    bySym.get(JSON.stringify([t.account_id || '', sym])).push(t);
  }

  const out = [];
  for (const [, symTrades] of bySym) {
    const symbol = normalizeSymbol(symTrades[0].symbol);
    symTrades.sort(compareTrades);
    const quoteName = String(options.quotes?.[symbol]?.name || '').trim();
    const name = symTrades.reduce((latest, trade) => {
      const candidate = String(trade.name || '').trim();
      return candidate && normalizeSymbol(candidate) !== symbol ? candidate : latest;
    }, quoteName && normalizeSymbol(quoteName) !== symbol ? quoteName : '');
    const pre = [];
    const win = [];
    for (const t of symTrades) {
      const d = dateKey(t);
      if (t.openingFund || (startDate && d < startDate)) pre.push(t);
      else win.push(t);
    }
    if (!win.length) continue;

    const queue = [];
    for (const t of pre) {
      if (t.type === 'buy') queue.push(tradeLot(t));
      else applyFifoSellToQueue(queue, t, symbol);
    }

    let totalBuy = new Decimal(0);
    let totalSell = new Decimal(0);
    let totalCommission = new Decimal(0);
    let fifoGross = new Decimal(0);
    let soldCost = new Decimal(0);
    let unmatchedSellShares = 0;
    for (const t of win) {
      const cur = tradeCurrency(t);
      totalCommission = totalCommission.plus(decimalUsd(t.commission, cur, rate, usdHkdRate));
      if (t.type === 'buy') {
        totalBuy = totalBuy.plus(decimalUsd(t.total_amount, cur, rate, usdHkdRate));
        queue.push(tradeLot(t));
      } else {
        totalSell = totalSell.plus(decimalUsd(t.total_amount, cur, rate, usdHkdRate));
        const matched = { cost: 0, unmatchedShares: 0 };
        fifoGross = fifoGross.plus(decimalUsd(applyFifoSellToQueue(queue, t, symbol, matched), cur, rate, usdHkdRate));
        soldCost = soldCost.plus(decimalUsd(matched.cost, cur, rate, usdHkdRate));
        unmatchedSellShares += matched.unmatchedShares;
      }
    }
    const netPnl = fifoGross.minus(totalCommission);
    out.push({
      symbol,
      name,
      assetType: tradeAssetType({ symbol }),
      accountId: symTrades[0].account_id || '',
      otherAmount: 0,
      totalBuyAmount: roundMoney(totalBuy),
      totalSellAmount: roundMoney(totalSell),
      totalCommission: roundMoney(totalCommission),
      fifoRealizedGross: roundMoney(fifoGross),
      netPnl: roundMoney(netPnl),
      soldCostAmount: roundMoney(soldCost),
      netPnlRate: soldCost.gt(0) && unmatchedSellShares <= 1e-8
        ? roundMoney(netPnl.div(soldCost).times(100)) : null,
      pnlRateUnavailableReason: unmatchedSellShares > 1e-8
        ? 'missing-buy-cost' : soldCost.lte(0) ? 'no-sold-cost' : null
    });
  }
  const otherGroups = new Map();
  for (const trade of trades) {
    if (trade.type !== 'other') continue;
    if (options.assetType && !['all', 'other'].includes(options.assetType)) continue;
    const d = dateKey(trade);
    if (!d || (startDate && d < startDate) || (endDate && d > endDate)) continue;
    const symbol = normalizeSymbol(trade.symbol);
    if (options.symbol && !symbol.includes(normalizeSymbol(options.symbol))) continue;
    const category = String(trade.other_category || '').trim() || '未分类收支';
    if (options.otherCategory && !category.includes(options.otherCategory)) continue;
    const key = JSON.stringify([symbol, category]);
    if (!otherGroups.has(key)) otherGroups.set(key, { symbol, name: category, assetType: 'other',
      otherCategory: category, otherAmount: 0, totalBuyAmount: 0, totalSellAmount: 0,
      totalCommission: 0, fifoRealizedGross: 0, soldCostAmount: 0,
      netPnlRate: null, pnlRateUnavailableReason: 'other-income' });
    const row = otherGroups.get(key);
    row.otherAmount += toUsd(trade.total_amount || 0, tradeCurrency(trade), rate, usdHkdRate);
    row.totalCommission += toUsd(trade.commission || 0, tradeCurrency(trade), rate, usdHkdRate);
  }
  for (const row of otherGroups.values()) {
    row.netPnl = roundMoney(row.otherAmount - row.totalCommission);
    row.otherAmount = roundMoney(row.otherAmount);
    row.totalCommission = roundMoney(row.totalCommission);
    out.push(row);
  }
  out.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.name.localeCompare(b.name));
  return out;
}

export function buildDailyCumulativeSeries(trades, options = {}) {
  if (!trades.length) return [];
  const usdHkdRate = options.usdHkdRate;
  const rate = Number(options.usdCnyRate) > 0 ? Number(options.usdCnyRate) : DEFAULT_USD_CNY_RATE;
  const sorted = trades.filter(t => !t.openingFund).sort(compareTrades);
  const byDay = new Map();
  for (const t of sorted) {
    const d = dateKey(t);
    if (!d) continue;
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(t);
  }
  const days = [...byDay.keys()].sort();
  if (!days.length) return [];

  const queues = new Map();
  for (const t of trades) {
    if (t.openingFund) queues.set(JSON.stringify([t.account_id || '', normalizeSymbol(t.symbol)]), [tradeLot(t)]);
  }
  let cumRealized = new Decimal(0);
  let cumCommission = new Decimal(0);
  let cumOther = new Decimal(0);
  let prevNet = 0;
  const out = [];

  for (const day of days) {
    for (const tr of byDay.get(day)) {
      const cur = tradeCurrency(tr);
      cumCommission = cumCommission.plus(decimalUsd(tr.commission, cur, rate, usdHkdRate));
      if (tr.type === 'other') {
        cumOther = cumOther.plus(decimalUsd(tr.total_amount, cur, rate, usdHkdRate));
        continue;
      }
      const key = JSON.stringify([tr.account_id || '', normalizeSymbol(tr.symbol)]);
      if (!queues.has(key)) queues.set(key, []);
      const q = queues.get(key);
      if (tr.type === 'buy') q.push(tradeLot(tr));
      else cumRealized = cumRealized.plus(decimalUsd(applyFifoSellToQueue(q, tr, tr.symbol), cur, rate, usdHkdRate));
    }
    const cumulativeNet = roundMoney(cumRealized.minus(cumCommission).plus(cumOther));
    out.push({ date: day, cumulativeNet, dayNet: roundMoney(new Decimal(cumulativeNet).minus(prevNet)) });
    prevNet = cumulativeNet;
  }
  return out;
}

function eachCalendarDay(start, end) {
  if (start > end) return [];
  let y = +start.slice(0, 4);
  let mo = +start.slice(5, 7);
  let day = +start.slice(8, 10);
  const out = [];
  for (;;) {
    const key = `${y}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    out.push(key);
    if (key === end) break;
    const d = new Date(y, mo - 1, day + 1);
    y = d.getFullYear();
    mo = d.getMonth() + 1;
    day = d.getDate();
  }
  return out;
}

export function expandDailySeries(sparse) {
  if (!sparse.length) return [];
  const map = new Map(sparse.map((p) => [p.date, p.cumulativeNet]));
  const start = sparse[0].date;
  const end = sparse[sparse.length - 1].date;
  let run = 0;
  return eachCalendarDay(start, end).map((d) => {
    if (map.has(d)) run = map.get(d);
    return { date: d, cumulativeNet: run };
  });
}

export function sliceSeries(series, startDate, endDate) {
  return series.filter((p) => {
    if (startDate && p.date < startDate) return false;
    if (endDate && p.date > endDate) return false;
    return true;
  });
}

export function enrichHoldings(holdings, quotes, cashOrState, meta = {}) {
  const cashState = typeof cashOrState === 'number'
    ? { cashUsd: cashOrState, cashCny: 0, usdCnyRate: DEFAULT_USD_CNY_RATE }
    : {
      cashUsd: Number(cashOrState?.cashUsd) || 0,
      cashCny: Number(cashOrState?.cashCny) || 0,
      usdCnyRate: Number(cashOrState?.usdCnyRate) > 0 ? Number(cashOrState.usdCnyRate) : DEFAULT_USD_CNY_RATE
    };
  const rate = cashState.usdCnyRate;
  const cashHkd = Number(cashOrState?.cashHkd) || 0;
  const usdHkdRate = cashOrState?.usdHkdRate;

  let stockMv = 0;
  let optionMv = 0;
  let ashareMv = 0;
  let ashareMvNative = 0;
  let unrealizedUsd = 0;
  let unrealizedCny = 0;
  let hkMv = 0;
  let unrealizedHkd = 0;
  let marketDailyUsd = 0;
  let marketDailyCny = 0;
  let hasMarketDailyUsd = false;
  let hasMarketDailyCny = false;
  const rows = holdings.map((h) => {
    const q = quotes[h.symbol] || {};
    const price = Number(q.price) || 0;
    const mult = optionMult(h.symbol);
    const currency = h.currency || (h.type === 'ashare' || isAShareSymbol(h.symbol) ? 'CNY' : 'USD');
    const isCny = currency === 'CNY';
    const valueNative = new Decimal(price).times(h.shares).times(mult);
    const mvNative = valueNative.toNumber();
    const costNative = h.costBasisNative ?? new Decimal(Number(h.avgCost)).times(h.shares).times(mult);
    const mv = toUsd(mvNative, currency, rate, usdHkdRate);
    const pnlNative = price > 0 ? roundMoney(valueNative.minus(costNative)) : null;
    const pnlUsd = pnlNative != null ? roundMoney(toUsd(pnlNative, currency, rate, usdHkdRate)) : null;
    const pnlPct = price > 0 && h.avgCost ? ((price - h.avgCost) / h.avgCost) * 100 : null;
    const change = q.change != null && q.change !== '' ? Number(q.change) : null;
    const changePct = q.changePercent != null && q.changePercent !== '' ? Number(q.changePercent) : null;
    const dailyPnlNative = price > 0 && change != null && Number.isFinite(change)
      ? roundMoney(change * h.shares * mult) : null;
    const dailyPnlUsd = dailyPnlNative != null ? roundMoney(toUsd(dailyPnlNative, currency, rate, usdHkdRate)) : null;
    const m = meta[h.symbol] || {};
    if (h.type === 'option') optionMv += mv;
    else if (h.type === 'ashare' || isCny) {
      ashareMv += mv;
      ashareMvNative += mvNative;
    } else if (currency === 'HKD') hkMv += mvNative;
    else stockMv += mv;
    if (pnlNative != null) {
      if (isCny) unrealizedCny += pnlNative;
      else if (currency === 'HKD') unrealizedHkd += pnlNative;
      else unrealizedUsd += pnlNative;
    }
    if (dailyPnlNative != null) {
      if (isCny) {
        marketDailyCny += dailyPnlNative;
        hasMarketDailyCny = true;
      } else if (currency !== 'HKD') {
        marketDailyUsd += dailyPnlNative;
        hasMarketDailyUsd = true;
      }
    }
    const opt = parseOptionInfo(h.symbol);
    const quoteName = String(q.name || '').trim();
    const displayName = (quoteName && quoteName !== h.symbol)
      ? quoteName
      : (h.name || h.symbol);
    return {
      ...h,
      name: displayName,
      currency,
      price,
      marketValueNative: roundMoney(mvNative),
      marketValue: roundMoney(mv),
      // 行内盈亏按本币；pnlUsd 供汇总折汇
      pnl: pnlNative,
      pnlUsd,
      pnlPct,
      dailyPnl: dailyPnlNative,
      dailyPnlUsd,
      dailyPnlNative,
      dailyPnlPct: price > 0 && changePct != null && Number.isFinite(changePct) ? changePct : null,
      change: change ?? 0,
      changePercent: changePct ?? 0,
      delayed: !!q.delayed,
      quoteAsOf: q.asOf || null,
      quoteSource: q.source || null,
      etfPremiumPct: q.etfPremiumPct ?? null,
      fundPremiumBasis: q.fundPremiumBasis || null,
      etfPremiumAsOf: q.etfPremiumAsOf || null,
      targetPrice: m.targetPrice ?? '',
      signal: m.signal ?? '',
      optionInfo: opt
    };
  });
  const totalMv = stockMv + optionMv + ashareMv + toUsd(hkMv, 'HKD', rate, usdHkdRate);
  const cashEq = cashUsdEquivalent(cashState.cashUsd, cashState.cashCny, rate, cashHkd, usdHkdRate);
  const totalAssets = totalMv + cashEq;
  // Native-currency asset pockets (holdings + cash in that currency).
  const assetsUsd = roundMoney(stockMv + optionMv + (Number(cashState.cashUsd) || 0));
  const assetsCny = roundMoney(ashareMvNative + (Number(cashState.cashCny) || 0));
  const assetsHkd = roundMoney(hkMv + cashHkd);
  const totalAssetsCny = roundMoney(assetsUsd * rate + assetsCny + toUsd(assetsHkd, 'HKD', rate, usdHkdRate) * rate);
  const unrealized = roundMoney(unrealizedUsd + toUsd(unrealizedCny, 'CNY', rate, usdHkdRate) + toUsd(unrealizedHkd, 'HKD', rate, usdHkdRate));
  rows.forEach((r) => {
    const symbol = r.tradeSymbol || r.symbol;
    r.groupKey = (() => {
      const manual = String(meta[symbol]?.groupWith || '').trim().toUpperCase();
      if (manual) return manual;
      const sym = String(symbol || '').trim().toUpperCase();
      if (r.type === 'option' || isOptionSymbol(sym)) {
        const match = sym.match(/^([A-Z]+)\d{6}[CP]/i);
        if (match) return match[1];
      }
      return sym;
    })();
    r.groupWith = String(meta[symbol]?.groupWith || '').trim();
  });
  const groupSum = new Map();
  for (const r of rows) {
    groupSum.set(r.groupKey, (groupSum.get(r.groupKey) ?? 0) + r.marketValue);
  }
  rows.forEach((r) => {
    const gs = groupSum.get(r.groupKey) ?? r.marketValue;
    r.groupMarketValue = gs;
    r.weight = totalAssets > 0 ? (gs / totalAssets) * 100 : 0;
  });
  return {
    rows,
    stockMv: roundMoney(stockMv),
    optionMv: roundMoney(optionMv),
    ashareMv: roundMoney(ashareMv),
    ashareMvNative: roundMoney(ashareMvNative),
    totalMv: roundMoney(totalMv),
    totalAssets: roundMoney(totalAssets),
    totalAssetsCny,
    assetsUsd,
    assetsCny,
    assetsHkd,
    hkMv: roundMoney(hkMv),
    unrealizedHkd: roundMoney(unrealizedHkd),
    cashUsdEq: cashEq,
    unrealized,
    unrealizedUsd: roundMoney(unrealizedUsd),
    unrealizedCny: roundMoney(unrealizedCny),
    marketDailyUsd: hasMarketDailyUsd ? roundMoney(marketDailyUsd) : null,
    marketDailyCny: hasMarketDailyCny ? roundMoney(marketDailyCny) : null
  };
}

/** 持仓涨跌和交易净变动均先按本币累计，再折成美元汇总。 */
export function computeDailySummary(holdingRows, trades, options = {}) {
  const usdHkdRate = options.usdHkdRate;
  const rate = Number(options.usdCnyRate) > 0 ? Number(options.usdCnyRate) : DEFAULT_USD_CNY_RATE;
  let marketDailyUsd = 0;
  let marketDailyCny = 0;
  let hasMarketUsd = false;
  let hasMarketCny = false;
  let marketDailyHkd = 0;
  let hasMarketHkd = false;
  for (const h of holdingRows) {
    const isCny = h.currency === 'CNY' || h.type === 'ashare';
    const native = h.dailyPnlNative != null ? h.dailyPnlNative : h.dailyPnl;
    if (native == null || !Number.isFinite(native)) continue;
    if (isCny) {
      marketDailyCny += native;
      hasMarketCny = true;
    } else if (h.currency === 'HKD') {
      marketDailyHkd += native;
      hasMarketHkd = true;
    } else {
      marketDailyUsd += native;
      hasMarketUsd = true;
    }
  }
  const today = zonedDateKey();
  const byCurrency = { USD: [], CNY: [], HKD: [] };
  for (const trade of trades) byCurrency[tradeCurrency(trade)].push(trade);
  const nativeTradePnl = (currency) => {
    const list = byCurrency[currency];
    if (!list.some(t => !t.openingFund && dateKey(t) === today)) return null;
    return buildDailyCumulativeSeries(list, { usdCnyRate: 1, usdHkdRate: 1 }).find(p => p.date === today)?.dayNet ?? null;
  };
  const tradeUsd = nativeTradePnl('USD');
  const tradeCny = nativeTradePnl('CNY');
  const tradeHkd = nativeTradePnl('HKD');
  const marketUsd = hasMarketUsd ? roundMoney(marketDailyUsd) : null;
  const marketCny = hasMarketCny ? roundMoney(marketDailyCny) : null;
  const marketHkd = hasMarketHkd ? roundMoney(marketDailyHkd) : null;
  const add = (a, b) => a == null && b == null ? null : roundMoney((a ?? 0) + (b ?? 0));
  const fold = (usd, cny, hkd) => usd == null && cny == null && hkd == null ? null
    : cashUsdEquivalent(usd, cny, rate, hkd, usdHkdRate);
  const dailyTotalPnlUsd = add(marketUsd, tradeUsd);
  const dailyTotalPnlCny = add(marketCny, tradeCny);
  const dailyTotalPnlHkd = add(marketHkd, tradeHkd);
  return {
    dailyTotalPnl: fold(dailyTotalPnlUsd, dailyTotalPnlCny, dailyTotalPnlHkd),
    marketDailyPnl: fold(marketUsd, marketCny, marketHkd),
    tradeDailyPnl: fold(tradeUsd, tradeCny, tradeHkd),
    marketDailyPnlUsd: marketUsd,
    marketDailyPnlCny: marketCny,
    dailyTotalPnlUsd,
    dailyTotalPnlCny,
    dailyTotalPnlHkd
  };
}

export function normalizeTrade(input) {
  const type = input.type;
  const symbol = normalizeSymbol(input.symbol);
  const currency = inferCurrency(symbol, input.currency);
  if (type === 'other') {
    const cat = String(input.other_category || '').trim();
    const amt = Number(input.total_amount);
    if (!cat || !Number.isFinite(amt) || amt === 0) throw new Error('其它收支需填写类别与非零金额');
    return {
      id: input.id || crypto.randomUUID(),
      ...(input.account_id ? { account_id: String(input.account_id) } : {}),
      symbol: symbol || 'OTHER',
      name: String(input.name || cat),
      type: 'other',
      other_category: cat,
      currency,
      shares: 1,
      price: 0,
      total_amount: roundMoney(normalizeOtherAmount(cat, amt)),
      commission: roundMoney(Number(input.commission) || 0),
      trade_date: input.trade_date || new Date().toISOString(),
      created_at: input.created_at || new Date().toISOString()
    };
  }
  if (currency === 'HKD' && holdingTypeForSymbol(symbol) !== 'hkstock') throw new Error('港股代码请填写 00700 或 00700.HK');
  const shares = Number(input.shares);
  const price = roundTradePrice(input.price, symbol);
  if (!symbol || !Number.isFinite(shares) || !Number.isFinite(price) || !(shares > 0) || !(price > 0)) throw new Error('买卖需填写代码、数量与价格');
  const mult = optionMult(symbol);
  const total = roundMoney(new Decimal(shares).times(price).times(mult));
  return {
    id: input.id || crypto.randomUUID(),
    ...(input.account_id ? { account_id: String(input.account_id) } : {}),
    symbol,
    name: String(input.name || symbol),
    type: type === 'sell' ? 'sell' : 'buy',
    currency,
    shares,
    price,
    total_amount: total,
    commission: roundMoney(Number(input.commission) || 0),
    trade_date: input.trade_date || new Date().toISOString(),
    created_at: input.created_at || new Date().toISOString()
  };
}

export function recalcCashFromTrades(trades, base = {}) {
  let state = {
    cashUsd: Number(base.cashUsd) || (typeof base === 'number' ? base : 0),
    cashCny: Number(base.cashCny) || 0,
    ...(base.usdHkdRate ? { usdHkdRate: base.usdHkdRate } : {}),
    usdCnyRate: Number(base.usdCnyRate) > 0 ? Number(base.usdCnyRate) : DEFAULT_USD_CNY_RATE
  };
  if (typeof base === 'number') {
    state = { cashUsd: base, cashCny: 0, usdCnyRate: DEFAULT_USD_CNY_RATE };
  }
  for (const t of trades) {
    state = applyCashDelta(state, t);
  }
  state.cash = cashUsdEquivalent(state.cashUsd, state.cashCny, state.usdCnyRate, state.cashHkd, state.usdHkdRate);
  return state;
}
