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
    list.sort((a, b) => new Date(a.trade_date) - new Date(b.trade_date));
    const queue = [];
    let name = symbol;
    for (const tr of list) {
      if (tr.name) name = tr.name;
      if (tr.type === 'buy') queue.push({ shares: tr.shares, price: tr.price });
      else {
        let rem = tr.shares;
        while (rem > 0 && queue.length) {
          const u = Math.min(rem, queue[0].shares);
          queue[0].shares -= u;
          rem -= u;
          if (queue[0].shares <= 0) queue.shift();
        }
      }
    }
    const shares = queue.reduce((s, x) => s + x.shares, 0);
    if (shares <= 0) continue;
    const cost = queue.reduce((s, x) => s + x.shares * x.price, 0);
    out.push({ symbol, name, shares, avgCost: cost / shares, type: isOptionSymbol(symbol) ? 'option' : 'stock' });
  }
  out.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return out;
}

export function computePnl(trades, options = {}) {
  const { startDate, endDate } = options;
  const inWindow = (t) => {
    const d = String(t.trade_date || '').slice(0, 10);
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
    list.sort((a, b) => new Date(a.trade_date) - new Date(b.trade_date));
    const queue = [];
    for (const tr of list) {
      if (tr.type === 'buy') queue.push({ shares: tr.shares, price: tr.price });
      else {
        let rem = tr.shares;
        const mult = optionMult(tr.symbol);
        while (rem > 0 && queue.length) {
          const u = Math.min(rem, queue[0].shares);
          realized += u * (tr.price - queue[0].price) * mult;
          queue[0].shares -= u;
          rem -= u;
          if (queue[0].shares <= 0) queue.shift();
        }
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

export function enrichHoldings(holdings, quotes, cash) {
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
    if (h.type === 'option') optionMv += mv;
    else stockMv += mv;
    if (pnl != null) unrealized += pnl;
    return { ...h, price, marketValue: mv, pnl, change: q.change, changePercent: q.changePercent };
  });
  const totalMv = stockMv + optionMv;
  const totalAssets = totalMv + cash;
  rows.forEach((r) => {
    r.weight = totalAssets > 0 ? (r.marketValue / totalAssets) * 100 : 0;
  });
  return { rows, stockMv, optionMv, totalMv, totalAssets, unrealized };
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
