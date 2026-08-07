// ABOUTME: Client-side FIFO profit/loss and windowed trade aggregates

export interface TradeLike {
  id: string;
  symbol: string;
  name: string;
  type: 'buy' | 'sell' | 'other';
  /** 仅 type=other：用户自定义类别，如利息、分红、卡券 */
  other_category?: string;
  shares: number;
  price: number;
  /** 买卖为成交金额；other 为带符号毛额（正=入账，负=扣款），净额= total_amount − commission */
  total_amount: number;
  commission: number;
  trade_date: string;
  created_at: string;
}

export interface ProfitLossStats {
  totalBuyAmount: number;
  totalSellAmount: number;
  realizedPL: number;
  commission: number;
  /** 查询窗口内其它项毛额之和（利息/分红等， signed total_amount） */
  otherAmount: number;
  netPL: number;
}

function tradeTime(t: string): number {
  return new Date(t).getTime();
}

function isOptionContractSymbol(symbol: string): boolean {
  return /^[A-Z]+\d{6}[CP]\d+(?:\.\d+)?$/i.test(symbol.trim());
}

/** Trades in optional date range and exact symbol (case-insensitive). */
function filterTradesForWindow(
  trades: readonly TradeLike[],
  options?: { startDate?: string; endDate?: string; symbol?: string }
): TradeLike[] {
  return trades.filter((t) => {
    if (options?.symbol && t.symbol.toUpperCase() !== options.symbol.toUpperCase()) {
      return false;
    }
    const d = t.trade_date.slice(0, 10);
    if (options?.startDate && d < options.startDate) return false;
    if (options?.endDate && d > options.endDate) return false;
    return true;
  });
}

/**
 * Buy/sell totals and commission use the filtered window; FIFO realized P&L is all-time
 * (optional symbol filter only), matching previous server behavior.
 * Other-category rows (type=other) add their signed total_amount into both window "otherAmount"
 * and netPL: netPL = realizedPL − commission + otherAmount.
 */
export function computeProfitLoss(
  trades: readonly TradeLike[],
  options?: { startDate?: string; endDate?: string; symbol?: string }
): ProfitLossStats {
  const windowTrades = filterTradesForWindow(trades, options);

  let totalBuyAmount = 0;
  let totalSellAmount = 0;
  let commission = 0;
  let otherAmount = 0;
  for (const trade of windowTrades) {
    commission += trade.commission;
    if (trade.type === 'buy') {
      totalBuyAmount += trade.total_amount;
    } else if (trade.type === 'sell') {
      totalSellAmount += trade.total_amount;
    } else if (trade.type === 'other') {
      otherAmount += trade.total_amount;
    }
  }

  const fifoTrades = trades.filter((t) =>
    (options?.symbol ? t.symbol.toUpperCase() === options.symbol.toUpperCase() : true) &&
    (t.type === 'buy' || t.type === 'sell')
  );

  const tradesBySymbol = new Map<string, TradeLike[]>();
  for (const trade of fifoTrades) {
    const sym = trade.symbol;
    if (!tradesBySymbol.has(sym)) tradesBySymbol.set(sym, []);
    tradesBySymbol.get(sym)!.push(trade);
  }

  let realizedPL = 0;
  for (const [, symTrades] of tradesBySymbol) {
    symTrades.sort((a, b) => tradeTime(a.trade_date) - tradeTime(b.trade_date));
    const buyQueue: Array<{ shares: number; price: number }> = [];
    for (const trade of symTrades) {
      if (trade.type === 'buy') {
        buyQueue.push({ shares: trade.shares, price: trade.price });
      } else if (trade.type === 'sell') {
        let remaining = trade.shares;
        while (remaining > 0 && buyQueue.length > 0) {
          const first = buyQueue[0];
          const usedShares = Math.min(remaining, first.shares);
          const mult = isOptionContractSymbol(trade.symbol) ? 100 : 1;
          realizedPL += usedShares * (trade.price - first.price) * mult;
          first.shares -= usedShares;
          remaining -= usedShares;
          if (first.shares <= 0) {
            buyQueue.shift();
          }
        }
      }
    }
  }

  return {
    totalBuyAmount,
    totalSellAmount,
    realizedPL,
    commission,
    otherAmount,
    netPL: realizedPL - commission + otherAmount
  };
}

/** 单笔标的在筛选区间内的买卖汇总（FIFO 已实现毛额与扣费后净盈亏） */
export interface SymbolTradePnlSummary {
  symbol: string;
  totalBuyAmount: number;
  totalSellAmount: number;
  /** 该标的每笔买卖记录的 commission 之和 */
  totalCommission: number;
  /** 区间内的卖出按 FIFO（含区间前先入队的买入批次）匹配的已实现盈亏毛额 */
  fifoRealizedGross: number;
  /** 盈亏金额 = fifoRealizedGross − totalCommission */
  netPnl: number;
  /** 盈亏比例 = netPnl / totalBuyAmount（%），totalBuyAmount=0 时为 null */
  netPnlRate: number | null;
}

function tradeCalendarDateKey(trade: TradeLike): string | null {
  const d = trade.trade_date.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

/**
 * 按标的汇总：区间内的总买/卖/手续费；
 * FIFO 已实现仅来自「成交日在区间内」的卖出，但与累计盈亏日历一致地消耗「区间内及之前」的买入队列（跨月仍可匹配数量）。
 */
export function computeSymbolTradePnlSummaries(
  trades: readonly TradeLike[],
  options?: { startDate?: string; endDate?: string }
): SymbolTradePnlSummary[] {
  const start = options?.startDate;
  const end = options?.endDate;

  const symbolsInWindow = new Set<string>();
  for (const t of trades) {
    if (t.type !== 'buy' && t.type !== 'sell') continue;
    const raw = t.symbol.trim();
    if (!raw) continue;
    const d = tradeCalendarDateKey(t);
    if (!d) continue;
    if (start && d < start) continue;
    if (end && d > end) continue;
    symbolsInWindow.add(raw.toUpperCase());
  }

  if (symbolsInWindow.size === 0) {
    return [];
  }
  const bySymAll = new Map<string, TradeLike[]>();
  for (const t of trades) {
    if (t.type !== 'buy' && t.type !== 'sell') continue;
    const symU = t.symbol.trim().toUpperCase();
    if (!symU) continue;
    if (!symbolsInWindow.has(symU)) continue;
    const d = tradeCalendarDateKey(t);
    if (!d) continue;
    if (end && d > end) continue;
    if (!bySymAll.has(symU)) bySymAll.set(symU, []);
    bySymAll.get(symU)!.push(t);
  }

  const out: SymbolTradePnlSummary[] = [];

  for (const [symbol, symTrades] of bySymAll) {
    symTrades.sort((a, b) => {
      const ta = tradeTime(a.trade_date);
      const tb = tradeTime(b.trade_date);
      if (ta !== tb) return ta - tb;
      return a.id.localeCompare(b.id);
    });

    const preStart: TradeLike[] = [];
    const inWindow: TradeLike[] = [];
    for (const t of symTrades) {
      const d = tradeCalendarDateKey(t)!;
      if (start && d < start) {
        preStart.push(t);
      } else {
        inWindow.push(t);
      }
    }

    if (inWindow.length === 0) {
      continue;
    }

    const buyQueue: Array<{ shares: number; price: number }> = [];
    for (const t of preStart) {
      if (t.type === 'buy') {
        buyQueue.push({ shares: t.shares, price: t.price });
      } else {
        applyFifoSellToQueue(buyQueue, t.shares, t.price, t.symbol.trim());
      }
    }

    let totalBuyAmount = 0;
    let totalSellAmount = 0;
    let totalCommission = 0;
    let fifoRealizedGross = 0;

    for (const trade of inWindow) {
      totalCommission += trade.commission;
      if (trade.type === 'buy') {
        totalBuyAmount += trade.total_amount;
        buyQueue.push({ shares: trade.shares, price: trade.price });
      } else {
        totalSellAmount += trade.total_amount;
        fifoRealizedGross += applyFifoSellToQueue(
          buyQueue,
          trade.shares,
          trade.price,
          trade.symbol.trim()
        );
      }
    }

    const netPnl = fifoRealizedGross - totalCommission;
    const netPnlRate = totalBuyAmount !== 0 ? (netPnl / totalBuyAmount) * 100 : null;
    out.push({
      symbol,
      totalBuyAmount,
      totalSellAmount,
      totalCommission,
      fifoRealizedGross,
      netPnl,
      netPnlRate
    });
  }

  out.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return out;
}

/** 剩余持仓一笔买入层（与 CostLot 一致：costPerShare = 单价） */
export interface DerivedLot {
  shares: number;
  costPerShare: number;
}

export interface DerivedHolding {
  symbol: string;
  name: string;
  shares: number;
  avgCost: number;
  costLots: DerivedLot[];
}

/** 按标的分组，FIFO 消耗卖出后得到的当前持仓、加权成本与余下批次 */
export function deriveHoldingsFromTrades(trades: readonly TradeLike[]): DerivedHolding[] {
  const bySym = new Map<string, TradeLike[]>();
  for (const t of trades) {
    const sym = t.symbol.trim().toUpperCase();
    if (!sym) continue;
    if (!bySym.has(sym)) bySym.set(sym, []);
    bySym.get(sym)!.push(t);
  }

  const out: DerivedHolding[] = [];

  for (const [symbol, symTrades] of bySym) {
    symTrades.sort((a, b) => {
      const ta = tradeTime(a.trade_date);
      const tb = tradeTime(b.trade_date);
      if (ta !== tb) return ta - tb;
      return a.id.localeCompare(b.id);
    });

    const queue: Array<{ shares: number; price: number }> = [];
    let latestName = symbol;

    for (const tr of symTrades) {
      if (tr.name && tr.name.trim()) latestName = tr.name.trim();
      if (tr.type === 'buy') {
        queue.push({ shares: tr.shares, price: tr.price });
      } else if (tr.type === 'sell') {
        let rem = tr.shares;
        while (rem > 0 && queue.length > 0) {
          const first = queue[0];
          const u = Math.min(rem, first.shares);
          first.shares -= u;
          rem -= u;
          if (first.shares <= 0) queue.shift();
        }
      }
    }

    const netShares = queue.reduce((s, x) => s + x.shares, 0);
    if (netShares <= 0) continue;

    const totalCost = queue.reduce((s, x) => s + x.shares * x.price, 0);
    const avgCost = totalCost / netShares;
    const costLots = queue.map((x) => ({ shares: x.shares, costPerShare: x.price }));

    out.push({
      symbol,
      name: latestName,
      shares: netShares,
      avgCost,
      costLots
    });
  }

  out.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return out;
}

function applyFifoSellToQueue(
  buyQueue: Array<{ shares: number; price: number }>,
  sellShares: number,
  sellPrice: number,
  symbol: string
): number {
  const mult = isOptionContractSymbol(symbol) ? 100 : 1;
  let gain = 0;
  let remaining = sellShares;
  while (remaining > 0 && buyQueue.length > 0) {
    const first = buyQueue[0];
    const used = Math.min(remaining, first.shares);
    gain += used * (sellPrice - first.price) * mult;
    first.shares -= used;
    remaining -= used;
    if (first.shares <= 0) {
      buyQueue.shift();
    }
  }
  return gain;
}

export interface DailyCumulativeNetPnlPoint {
  date: string;
  cumulativeNet: number;
  /** 当日对累计净盈亏的增量（当日成交：已实现变动 − 当日手续费）；无交易日的日历格为 0 */
  dayNet: number;
}

/**
 * 按日历日递进处理全部交易（与 computeProfitLoss 相同 FIFO / 期权乘数），输出每个有交易日的日终累计净盈亏。
 * 累计净盈亏包含「其它」类毛额累计与全部手续费。
 */
export function buildDailyCumulativeNetPnlSeries(trades: readonly TradeLike[]): DailyCumulativeNetPnlPoint[] {
  if (trades.length === 0) return [];

  const sorted = [...trades].sort((a, b) => {
    const ta = tradeTime(a.trade_date);
    const tb = tradeTime(b.trade_date);
    if (ta !== tb) return ta - tb;
    return a.id.localeCompare(b.id);
  });

  const byDay = new Map<string, TradeLike[]>();
  for (const t of sorted) {
    const d = t.trade_date.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d)!.push(t);
  }

  const dayKeys = [...byDay.keys()].sort((a, b) => a.localeCompare(b));
  if (dayKeys.length === 0) return [];

  const queues = new Map<string, Array<{ shares: number; price: number }>>();
  let cumRealized = 0;
  let cumCommission = 0;
  let cumOther = 0;
  let prevNet = 0;
  const out: DailyCumulativeNetPnlPoint[] = [];

  for (const day of dayKeys) {
    const list = byDay.get(day)!;
    for (const tr of list) {
      cumCommission += tr.commission;
      if (tr.type === 'other') {
        cumOther += tr.total_amount;
        continue;
      }

      const key = tr.symbol.trim().toUpperCase();
      if (!key) continue;

      let q = queues.get(key);
      if (!q) {
        q = [];
        queues.set(key, q);
      }

      if (tr.type === 'buy') {
        q.push({ shares: tr.shares, price: tr.price });
      } else if (tr.type === 'sell') {
        cumRealized += applyFifoSellToQueue(q, tr.shares, tr.price, tr.symbol.trim());
      }
    }
    const cumulativeNet = cumRealized - cumCommission + cumOther;
    const dayNet = cumulativeNet - prevNet;
    out.push({ date: day, cumulativeNet, dayNet });
    prevNet = cumulativeNet;
  }

  return out;
}

function eachCalendarDayInclusive(start: string, end: string): string[] {
  if (start > end) return [];
  let y = Number(start.slice(0, 4));
  let mo = Number(start.slice(5, 7));
  let day = Number(start.slice(8, 10));
  const out: string[] = [];
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

/** 从首笔到有交易日区间内每个自然日的累计净盈亏（非交易日沿用上一日终值，便于绘制折线） */
export function expandCumulativeDailyToAllDays(sparse: readonly DailyCumulativeNetPnlPoint[]): Array<{ date: string; cumulativeNet: number }> {
  if (sparse.length === 0) return [];
  const byExact = new Map(sparse.map((p) => [p.date, p.cumulativeNet]));
  const start = sparse[0].date;
  const end = sparse[sparse.length - 1].date;
  let run = 0;
  const expanded: Array<{ date: string; cumulativeNet: number }> = [];
  for (const d of eachCalendarDayInclusive(start, end)) {
    const v = byExact.get(d);
    if (v !== undefined) {
      run = v;
    }
    expanded.push({ date: d, cumulativeNet: run });
  }
  return expanded;
}
