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
  return Math.round(Number(n) * 100) / 100;
}

export function tradeCurrency(trade) {
  return inferCurrency(trade?.symbol, trade?.currency);
}

/** Cash delta in the trade's native currency. */
export function cashDelta(trade) {
  const fee = roundMoney(trade.commission || 0);
  const amt = roundMoney(trade.total_amount || 0);
  if (trade.type === 'buy') return roundMoney(-(amt + fee));
  return roundMoney(amt - fee);
}

export function toUsd(amount, currency, rate = DEFAULT_USD_CNY_RATE) {
  const n = Number(amount) || 0;
  const r = Number(rate) > 0 ? Number(rate) : DEFAULT_USD_CNY_RATE;
  if (String(currency).toUpperCase() === 'CNY') return n / r;
  return n;
}

export function cashUsdEquivalent(cashUsd, cashCny, rate = DEFAULT_USD_CNY_RATE) {
  return roundMoney(toUsd(cashUsd, 'USD', rate) + toUsd(cashCny, 'CNY', rate));
}

export function applyCashDelta(cashState, trade) {
  const delta = cashDelta(trade);
  const cur = tradeCurrency(trade);
  const next = {
    cashUsd: Number(cashState.cashUsd) || 0,
    cashCny: Number(cashState.cashCny) || 0,
    usdCnyRate: Number(cashState.usdCnyRate) > 0 ? Number(cashState.usdCnyRate) : DEFAULT_USD_CNY_RATE
  };
  if (cur === 'CNY') next.cashCny = roundMoney(next.cashCny + delta);
  else next.cashUsd = roundMoney(next.cashUsd + delta);
  next.cash = cashUsdEquivalent(next.cashUsd, next.cashCny, next.usdCnyRate);
  return next;
}

/** Reverse a previously applied trade cash effect. */
export function undoCashDelta(cashState, trade) {
  const delta = cashDelta(trade);
  const cur = tradeCurrency(trade);
  const next = {
    cashUsd: Number(cashState.cashUsd) || 0,
    cashCny: Number(cashState.cashCny) || 0,
    usdCnyRate: Number(cashState.usdCnyRate) > 0 ? Number(cashState.usdCnyRate) : DEFAULT_USD_CNY_RATE
  };
  if (cur === 'CNY') next.cashCny = roundMoney(next.cashCny - delta);
  else next.cashUsd = roundMoney(next.cashUsd - delta);
  next.cash = cashUsdEquivalent(next.cashUsd, next.cashCny, next.usdCnyRate);
  return next;
}

export const APP_TIME_ZONE = process.env.STOCK_TZ || 'Asia/Shanghai';

export function zonedDateKey(date = new Date(), timeZone = APP_TIME_ZONE) {
  return new Intl.DateTimeFormat('en-CA', {
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
  const parts = new Intl.DateTimeFormat('en-GB', {
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

function dateKey(t) {
  return tradeCalendarDate(t.trade_date);
}

function applyFifoSellToQueue(buyQueue, sellShares, sellPrice, symbol) {
  const mult = optionMult(symbol);
  let gain = 0;
  let rem = sellShares;
  while (rem > 0 && buyQueue.length) {
    const u = Math.min(rem, buyQueue[0].shares);
    gain += u * (sellPrice - buyQueue[0].price) * mult;
    buyQueue[0].shares -= u;
    rem -= u;
    if (buyQueue[0].shares <= 0) buyQueue.shift();
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
    if (!bySym.has(sym)) bySym.set(sym, []);
    bySym.get(sym).push(t);
  }

  const out = [];
  for (const [symbol, list] of bySym) {
    list.sort((a, b) => tradeTime(a.trade_date) - tradeTime(b.trade_date) || a.id.localeCompare(b.id));
    const queue = [];
    let name = symbol;
    for (const tr of list) {
      if (tr.name) name = tr.name;
      if (tr.type === 'buy') queue.push({ shares: tr.shares, price: tr.price });
      else applyFifoSellToQueue(queue, tr.shares, tr.price, symbol);
    }
    const shares = queue.reduce((s, x) => s + x.shares, 0);
    if (shares <= 0) continue;
    const cost = queue.reduce((s, x) => s + x.shares * x.price, 0);
    const type = holdingTypeForSymbol(symbol);
    out.push({
      symbol,
      name,
      shares,
      avgCost: cost / shares,
      costLots: queue.map((x) => ({ shares: x.shares, costPerShare: x.price })),
      type,
      currency: type === 'ashare' ? 'CNY' : 'USD'
    });
  }
  out.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return out;
}

export function computePnl(trades, options = {}) {
  const { startDate, endDate } = options;
  const rate = Number(options.usdCnyRate) > 0 ? Number(options.usdCnyRate) : DEFAULT_USD_CNY_RATE;
  const inWindow = (t) => {
    const d = dateKey(t);
    if (!d) return false;
    if (startDate && d < startDate) return false;
    if (endDate && d > endDate) return false;
    return true;
  };

  let totalBuy = 0;
  let totalSell = 0;
  let commission = 0;
  let otherAmount = 0;
  for (const t of trades) {
    if (!inWindow(t)) continue;
    const cur = tradeCurrency(t);
    commission += toUsd(t.commission || 0, cur, rate);
    if (t.type === 'buy') totalBuy += toUsd(t.total_amount, cur, rate);
    else if (t.type === 'sell') totalSell += toUsd(t.total_amount, cur, rate);
    else if (t.type === 'other') otherAmount += toUsd(t.total_amount, cur, rate);
  }

  const fifoTrades = trades.filter((t) => t.type === 'buy' || t.type === 'sell');
  const bySym = new Map();
  for (const t of fifoTrades) {
    const sym = normalizeSymbol(t.symbol);
    if (!bySym.has(sym)) bySym.set(sym, []);
    bySym.get(sym).push(t);
  }

  let realized = 0;
  for (const [symbol, list] of bySym) {
    list.sort((a, b) => tradeTime(a.trade_date) - tradeTime(b.trade_date));
    const queue = [];
    const cur = isAShareSymbol(symbol) ? 'CNY' : 'USD';
    for (const tr of list) {
      if (tr.type === 'buy') queue.push({ shares: tr.shares, price: tr.price });
      else {
        const gainNative = applyFifoSellToQueue(queue, tr.shares, tr.price, tr.symbol);
        realized += toUsd(gainNative, tradeCurrency(tr) || cur, rate);
      }
    }
  }

  return {
    totalBuy: roundMoney(totalBuy),
    totalSell: roundMoney(totalSell),
    commission: roundMoney(commission),
    otherAmount: roundMoney(otherAmount),
    realizedPL: roundMoney(realized),
    netPL: roundMoney(realized - commission + otherAmount)
  };
}

export function computeSymbolSummaries(trades, options = {}) {
  const { startDate, endDate } = options;
  const rate = Number(options.usdCnyRate) > 0 ? Number(options.usdCnyRate) : DEFAULT_USD_CNY_RATE;
  const symbolsInWindow = new Set();
  for (const t of trades) {
    if (t.type !== 'buy' && t.type !== 'sell') continue;
    const d = dateKey(t);
    if (!d) continue;
    if (startDate && d < startDate) continue;
    if (endDate && d > endDate) continue;
    symbolsInWindow.add(normalizeSymbol(t.symbol));
  }
  if (!symbolsInWindow.size) return [];

  const bySym = new Map();
  for (const t of trades) {
    if (t.type !== 'buy' && t.type !== 'sell') continue;
    const sym = normalizeSymbol(t.symbol);
    if (!symbolsInWindow.has(sym)) continue;
    const d = dateKey(t);
    if (!d || (endDate && d > endDate)) continue;
    if (!bySym.has(sym)) bySym.set(sym, []);
    bySym.get(sym).push(t);
  }

  const out = [];
  for (const [symbol, symTrades] of bySym) {
    symTrades.sort((a, b) => tradeTime(a.trade_date) - tradeTime(b.trade_date) || a.id.localeCompare(b.id));
    const pre = [];
    const win = [];
    for (const t of symTrades) {
      const d = dateKey(t);
      if (startDate && d < startDate) pre.push(t);
      else win.push(t);
    }
    if (!win.length) continue;

    const queue = [];
    for (const t of pre) {
      if (t.type === 'buy') queue.push({ shares: t.shares, price: t.price });
      else applyFifoSellToQueue(queue, t.shares, t.price, symbol);
    }

    let totalBuy = 0;
    let totalSell = 0;
    let totalCommission = 0;
    let fifoGross = 0;
    for (const t of win) {
      const cur = tradeCurrency(t);
      totalCommission += toUsd(t.commission || 0, cur, rate);
      if (t.type === 'buy') {
        totalBuy += toUsd(t.total_amount, cur, rate);
        queue.push({ shares: t.shares, price: t.price });
      } else {
        totalSell += toUsd(t.total_amount, cur, rate);
        fifoGross += toUsd(applyFifoSellToQueue(queue, t.shares, t.price, symbol), cur, rate);
      }
    }
    const netPnl = fifoGross - totalCommission;
    out.push({
      symbol,
      totalBuyAmount: roundMoney(totalBuy),
      totalSellAmount: roundMoney(totalSell),
      totalCommission: roundMoney(totalCommission),
      fifoRealizedGross: roundMoney(fifoGross),
      netPnl: roundMoney(netPnl),
      netPnlRate: totalBuy ? roundMoney((netPnl / totalBuy) * 10000) / 100 : null
    });
  }
  out.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return out;
}

export function buildDailyCumulativeSeries(trades, options = {}) {
  if (!trades.length) return [];
  const rate = Number(options.usdCnyRate) > 0 ? Number(options.usdCnyRate) : DEFAULT_USD_CNY_RATE;
  const sorted = [...trades].sort((a, b) => tradeTime(a.trade_date) - tradeTime(b.trade_date) || a.id.localeCompare(b.id));
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
  let cumRealized = 0;
  let cumCommission = 0;
  let cumOther = 0;
  let prevNet = 0;
  const out = [];

  for (const day of days) {
    for (const tr of byDay.get(day)) {
      const cur = tradeCurrency(tr);
      cumCommission += toUsd(tr.commission || 0, cur, rate);
      if (tr.type === 'other') {
        cumOther += toUsd(tr.total_amount, cur, rate);
        continue;
      }
      const key = normalizeSymbol(tr.symbol);
      if (!queues.has(key)) queues.set(key, []);
      const q = queues.get(key);
      if (tr.type === 'buy') q.push({ shares: tr.shares, price: tr.price });
      else cumRealized += toUsd(applyFifoSellToQueue(q, tr.shares, tr.price, tr.symbol), cur, rate);
    }
    const cumulativeNet = roundMoney(cumRealized - cumCommission + cumOther);
    out.push({ date: day, cumulativeNet, dayNet: roundMoney(cumulativeNet - prevNet) });
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

  let stockMv = 0;
  let optionMv = 0;
  let ashareMv = 0;
  let ashareMvNative = 0;
  let unrealizedUsd = 0;
  let unrealizedCny = 0;
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
    const mvNative = price * h.shares * mult;
    const costNative = h.avgCost * h.shares * mult;
    const mv = toUsd(mvNative, currency, rate);
    const pnlNative = price > 0 ? roundMoney(mvNative - costNative) : null;
    const pnlUsd = pnlNative != null ? roundMoney(toUsd(pnlNative, currency, rate)) : null;
    const pnlPct = price > 0 && h.avgCost ? ((price - h.avgCost) / h.avgCost) * 100 : null;
    const change = q.change != null && q.change !== '' ? Number(q.change) : null;
    const changePct = q.changePercent != null && q.changePercent !== '' ? Number(q.changePercent) : null;
    const dailyPnlNative = price > 0 && change != null && Number.isFinite(change)
      ? roundMoney(change * h.shares * mult) : null;
    const dailyPnlUsd = dailyPnlNative != null ? roundMoney(toUsd(dailyPnlNative, currency, rate)) : null;
    const m = meta[h.symbol] || {};
    if (h.type === 'option') optionMv += mv;
    else if (h.type === 'ashare' || isCny) {
      ashareMv += mv;
      ashareMvNative += mvNative;
    } else stockMv += mv;
    if (pnlNative != null) {
      if (isCny) unrealizedCny += pnlNative;
      else unrealizedUsd += pnlNative;
    }
    if (dailyPnlNative != null) {
      if (isCny) {
        marketDailyCny += dailyPnlNative;
        hasMarketDailyCny = true;
      } else {
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
      targetPrice: m.targetPrice ?? '',
      signal: m.signal ?? '',
      optionInfo: opt
    };
  });
  const totalMv = stockMv + optionMv + ashareMv;
  const cashEq = cashUsdEquivalent(cashState.cashUsd, cashState.cashCny, rate);
  const totalAssets = totalMv + cashEq;
  const unrealized = roundMoney(unrealizedUsd + toUsd(unrealizedCny, 'CNY', rate));
  rows.forEach((r) => {
    r.groupKey = (() => {
      const manual = String(meta[r.symbol]?.groupWith || '').trim().toUpperCase();
      if (manual) return manual;
      const sym = String(r.symbol || '').trim().toUpperCase();
      if (r.type === 'option' || isOptionSymbol(sym)) {
        const match = sym.match(/^([A-Z]+)\d{6}[CP]/i);
        if (match) return match[1];
      }
      return sym;
    })();
    r.groupWith = String(meta[r.symbol]?.groupWith || '').trim();
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
    cashUsdEq: cashEq,
    unrealized,
    unrealizedUsd: roundMoney(unrealizedUsd),
    unrealizedCny: roundMoney(unrealizedCny),
    marketDailyUsd: hasMarketDailyUsd ? roundMoney(marketDailyUsd) : null,
    marketDailyCny: hasMarketDailyCny ? roundMoney(marketDailyCny) : null
  };
}

/** 当日总盈亏：美股/期权按美元，A 股按人民币分开累计；交易净变动仍按当前汇率折美元（兼容旧字段） */
export function computeDailySummary(holdingRows, trades, options = {}) {
  const rate = Number(options.usdCnyRate) > 0 ? Number(options.usdCnyRate) : DEFAULT_USD_CNY_RATE;
  let marketDailyUsd = 0;
  let marketDailyCny = 0;
  let hasMarketUsd = false;
  let hasMarketCny = false;
  for (const h of holdingRows) {
    const isCny = h.currency === 'CNY' || h.type === 'ashare';
    const native = h.dailyPnlNative != null ? h.dailyPnlNative : h.dailyPnl;
    if (native == null || !Number.isFinite(native)) continue;
    if (isCny) {
      marketDailyCny += native;
      hasMarketCny = true;
    } else {
      marketDailyUsd += native;
      hasMarketUsd = true;
    }
  }
  const today = zonedDateKey();
  const sparse = buildDailyCumulativeSeries(trades, options);
  const todayPoint = sparse.find((p) => p.date === today);
  const tradeDaily = todayPoint?.dayNet ?? 0;
  const hasTradeToday = !!todayPoint;
  const hasMarket = hasMarketUsd || hasMarketCny;

  if (!hasMarket && !hasTradeToday) {
    return {
      dailyTotalPnl: null,
      marketDailyPnl: null,
      tradeDailyPnl: null,
      marketDailyPnlUsd: null,
      marketDailyPnlCny: null,
      dailyTotalPnlUsd: null,
      dailyTotalPnlCny: null
    };
  }

  const marketUsd = hasMarketUsd ? roundMoney(marketDailyUsd) : null;
  const marketCny = hasMarketCny ? roundMoney(marketDailyCny) : null;
  const marketUsdEq = roundMoney(
    (marketUsd || 0) + toUsd(marketCny || 0, 'CNY', rate)
  );
  const tradeUsd = hasTradeToday ? roundMoney(tradeDaily) : null;

  return {
    dailyTotalPnl: roundMoney(marketUsdEq + (tradeUsd || 0)),
    marketDailyPnl: hasMarket ? marketUsdEq : null,
    tradeDailyPnl: tradeUsd,
    marketDailyPnlUsd: marketUsd,
    marketDailyPnlCny: marketCny,
    dailyTotalPnlUsd: hasMarketUsd || hasTradeToday
      ? roundMoney((marketUsd || 0) + (tradeUsd || 0))
      : null,
    dailyTotalPnlCny: marketCny
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
      symbol: symbol || 'OTHER',
      name: String(input.name || cat),
      type: 'other',
      other_category: cat,
      currency: currency === 'CNY' ? 'CNY' : 'USD',
      shares: 1,
      price: 0,
      total_amount: roundMoney(amt),
      commission: roundMoney(Number(input.commission) || 0),
      trade_date: input.trade_date || new Date().toISOString(),
      created_at: input.created_at || new Date().toISOString()
    };
  }
  const shares = Number(input.shares);
  const price = Number(input.price);
  if (!symbol || !(shares > 0) || !(price > 0)) throw new Error('买卖需填写代码、数量与价格');
  const mult = optionMult(symbol);
  const total = roundMoney(shares * price * mult);
  return {
    id: input.id || crypto.randomUUID(),
    symbol,
    name: String(input.name || symbol),
    type: type === 'sell' ? 'sell' : 'buy',
    currency,
    shares,
    price: roundMoney(price),
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
    usdCnyRate: Number(base.usdCnyRate) > 0 ? Number(base.usdCnyRate) : DEFAULT_USD_CNY_RATE
  };
  if (typeof base === 'number') {
    state = { cashUsd: base, cashCny: 0, usdCnyRate: DEFAULT_USD_CNY_RATE };
  }
  for (const t of trades) {
    state = applyCashDelta(state, t);
  }
  state.cash = cashUsdEquivalent(state.cashUsd, state.cashCny, state.usdCnyRate);
  return state;
}
