export function isOptionSymbol(symbol) {
  return /^[A-Z]+\d{6}[CP]\d+(?:\.\d+)?$/i.test(String(symbol || '').trim());
}

export function optionMult(symbol) {
  return isOptionSymbol(symbol) ? 100 : 1;
}

export function roundMoney(n) {
  return Math.round(Number(n) * 100) / 100;
}

export function cashDelta(trade) {
  const fee = roundMoney(trade.commission || 0);
  const amt = roundMoney(trade.total_amount || 0);
  if (trade.type === 'buy') return roundMoney(-(amt + fee));
  return roundMoney(amt - fee);
}

function tradeTime(t) {
  return new Date(t).getTime();
}

function dateKey(t) {
  const d = String(t.trade_date || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
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
    const sym = String(t.symbol || '').trim().toUpperCase();
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
    out.push({
      symbol,
      name,
      shares,
      avgCost: cost / shares,
      costLots: queue.map((x) => ({ shares: x.shares, costPerShare: x.price })),
      type: isOptionSymbol(symbol) ? 'option' : 'stock'
    });
  }
  out.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return out;
}

export function computePnl(trades, options = {}) {
  const { startDate, endDate } = options;
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
    commission += t.commission || 0;
    if (t.type === 'buy') totalBuy += t.total_amount;
    else if (t.type === 'sell') totalSell += t.total_amount;
    else if (t.type === 'other') otherAmount += t.total_amount;
  }

  const fifoTrades = trades.filter((t) => t.type === 'buy' || t.type === 'sell');
  const bySym = new Map();
  for (const t of fifoTrades) {
    const sym = t.symbol.toUpperCase();
    if (!bySym.has(sym)) bySym.set(sym, []);
    bySym.get(sym).push(t);
  }

  let realized = 0;
  for (const [, list] of bySym) {
    list.sort((a, b) => tradeTime(a.trade_date) - tradeTime(b.trade_date));
    const queue = [];
    for (const tr of list) {
      if (tr.type === 'buy') queue.push({ shares: tr.shares, price: tr.price });
      else realized += applyFifoSellToQueue(queue, tr.shares, tr.price, tr.symbol);
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
  const symbolsInWindow = new Set();
  for (const t of trades) {
    if (t.type !== 'buy' && t.type !== 'sell') continue;
    const d = dateKey(t);
    if (!d) continue;
    if (startDate && d < startDate) continue;
    if (endDate && d > endDate) continue;
    symbolsInWindow.add(t.symbol.toUpperCase());
  }
  if (!symbolsInWindow.size) return [];

  const bySym = new Map();
  for (const t of trades) {
    if (t.type !== 'buy' && t.type !== 'sell') continue;
    const sym = t.symbol.toUpperCase();
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
      totalCommission += t.commission || 0;
      if (t.type === 'buy') {
        totalBuy += t.total_amount;
        queue.push({ shares: t.shares, price: t.price });
      } else {
        totalSell += t.total_amount;
        fifoGross += applyFifoSellToQueue(queue, t.shares, t.price, symbol);
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

export function buildDailyCumulativeSeries(trades) {
  if (!trades.length) return [];
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
      cumCommission += tr.commission || 0;
      if (tr.type === 'other') {
        cumOther += tr.total_amount;
        continue;
      }
      const key = tr.symbol.toUpperCase();
      if (!queues.has(key)) queues.set(key, []);
      const q = queues.get(key);
      if (tr.type === 'buy') q.push({ shares: tr.shares, price: tr.price });
      else cumRealized += applyFifoSellToQueue(q, tr.shares, tr.price, tr.symbol);
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

export function enrichHoldings(holdings, quotes, cash, meta = {}) {
  let stockMv = 0;
  let optionMv = 0;
  let unrealized = 0;
  const rows = holdings.map((h) => {
    const q = quotes[h.symbol] || {};
    const price = Number(q.price) || 0;
    const mult = optionMult(h.symbol);
    const mv = price * h.shares * mult;
    const cost = h.avgCost * h.shares * mult;
    const pnl = price > 0 ? mv - cost : null;
    const pnlPct = price > 0 && h.avgCost ? ((price - h.avgCost) / h.avgCost) * 100 : null;
    const change = q.change != null && q.change !== '' ? Number(q.change) : null;
    const changePct = q.changePercent != null && q.changePercent !== '' ? Number(q.changePercent) : null;
    const dailyPnl = price > 0 && change != null && Number.isFinite(change)
      ? roundMoney(change * h.shares * mult) : null;
    const m = meta[h.symbol] || {};
    if (h.type === 'option') optionMv += mv;
    else stockMv += mv;
    if (pnl != null) unrealized += pnl;
    const opt = parseOptionInfo(h.symbol);
    return {
      ...h,
      price,
      marketValue: mv,
      pnl,
      pnlPct,
      dailyPnl,
      dailyPnlPct: price > 0 && changePct != null && Number.isFinite(changePct) ? changePct : null,
      change: change ?? 0,
      changePercent: changePct ?? 0,
      targetPrice: m.targetPrice ?? '',
      signal: m.signal ?? '',
      optionInfo: opt
    };
  });
  const totalMv = stockMv + optionMv;
  const totalAssets = totalMv + cash;
  rows.forEach((r) => {
    r.weight = totalAssets > 0 ? (r.marketValue / totalAssets) * 100 : 0;
  });
  return { rows, stockMv, optionMv, totalMv, totalAssets, unrealized };
}

/** 当日总盈亏 = 持仓当日涨跌合计 + 今日交易净变动（已实现/费用/其它） */
export function computeDailySummary(holdingRows, trades) {
  let marketDaily = 0;
  let hasMarket = false;
  for (const h of holdingRows) {
    if (h.dailyPnl != null && Number.isFinite(h.dailyPnl)) {
      marketDaily += h.dailyPnl;
      hasMarket = true;
    }
  }
  const today = new Date().toISOString().slice(0, 10);
  const sparse = buildDailyCumulativeSeries(trades);
  const todayPoint = sparse.find((p) => p.date === today);
  const tradeDaily = todayPoint?.dayNet ?? 0;
  const hasTradeToday = !!todayPoint;

  if (!hasMarket && !hasTradeToday) {
    return { dailyTotalPnl: null, marketDailyPnl: null, tradeDailyPnl: null };
  }
  return {
    dailyTotalPnl: roundMoney(marketDaily + tradeDaily),
    marketDailyPnl: hasMarket ? roundMoney(marketDaily) : null,
    tradeDailyPnl: hasTradeToday ? roundMoney(tradeDaily) : null
  };
}

export function normalizeTrade(input) {
  const type = input.type;
  const symbol = String(input.symbol || '').trim().toUpperCase();
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
    shares,
    price: roundMoney(price),
    total_amount: total,
    commission: roundMoney(Number(input.commission) || 0),
    trade_date: input.trade_date || new Date().toISOString(),
    created_at: input.created_at || new Date().toISOString()
  };
}

export function recalcCashFromTrades(trades, baseCash = 0) {
  return roundMoney(trades.reduce((c, t) => c + cashDelta(t), baseCash));
}
