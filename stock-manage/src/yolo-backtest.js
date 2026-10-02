const etClock = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit'
});

function etMinute(iso) {
  const parts = etClock.formatToParts(new Date(iso));
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Number(value.hour) * 60 + Number(value.minute);
}

export function summarizeYoloTrades(trades, initialCapital) {
  let equity = initialCapital;
  let peak = equity;
  let maxDrawdown = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let wins = 0;
  for (const trade of trades) {
    equity += trade.netPnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity / peak - 1);
    if (trade.netPnl > 0) { wins += 1; grossProfit += trade.netPnl; }
    else grossLoss += Math.abs(trade.netPnl);
  }
  return {
    trades: trades.length,
    wins,
    winRate: trades.length ? wins / trades.length : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    initialCapital,
    finalEquity: equity,
    totalReturn: equity / initialCapital - 1,
    maxDrawdown
  };
}

export function backtestYoloDataset(captures, raw = {}) {
  const config = {
    targetDelta: Math.min(0.8, Math.max(0.1, Number(raw.targetDelta) || 0.45)),
    minMovePct: Math.min(0.02, Math.max(0, Number.isFinite(Number(raw.minMovePct)) ? Number(raw.minMovePct) : 0.0015)),
    stopLoss: -Math.min(0.95, Math.max(0.05, Number(raw.stopLoss) || 0.35)),
    profitTarget: Math.min(5, Math.max(0.05, Number(raw.profitTarget) || 0.55)),
    lockTrigger: Math.min(5, Math.max(0.05, Number(raw.lockTrigger) || 0.35)),
    lockedStop: Math.min(2, Math.max(0, Number(raw.lockedStop) || 0.10)),
    entryMinute: 9 * 60 + 45,
    noFollowMinute: 13 * 60,
    exitMinute: 15 * 60 + 30,
    initialCapital: Math.max(1000, Number(raw.initialCapital) || 100000),
    riskPerTrade: Math.min(0.05, Math.max(0.001, Number(raw.riskPerTrade) || 0.005)),
    commission: Math.max(0, Number.isFinite(Number(raw.commission)) ? Number(raw.commission) : 0.65),
    expirationRule: 'nearest-collected-expiration-after-market-date'
  };
  const byDate = new Map();
  for (const capture of captures || []) {
    if (!byDate.has(capture.marketDate)) byDate.set(capture.marketDate, []);
    byDate.get(capture.marketDate).push({ ...capture, minute: etMinute(capture.capturedAt) });
  }
  const trades = [];
  const diagnostics = [];
  for (const [marketDate, dayRaw] of byDate) {
    const expiration = [...new Set(dayRaw.flatMap((item) => item.expiration ? [item.expiration] : (item.quotes || []).map((q) => q.expiration)))].filter((value) => value > marketDate).sort()[0];
    const info = { marketDate, expiration: expiration || null, status: 'skipped', reason: '', captures: 0 };
    diagnostics.push(info);
    if (!expiration) { info.reason = '没有下一到期日的日内报价（排除0DTE）'; continue; }
    const day = dayRaw.filter((item) => !item.expiration || item.expiration === expiration)
      .map((item) => ({ ...item, quotes: (item.quotes || []).filter((quote) => quote.expiration === expiration) }))
      .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
    info.captures = day.length;
    const open = day.find((item) => item.minute >= 9 * 60 + 30 && item.minute <= 9 * 60 + 35);
    const entryCapture = day.find((item) => item.minute >= config.entryMinute && item.minute <= config.entryMinute + 3);
    if (!open || !(open.underlyingPrice > 0)) { info.reason = '缺少09:30–09:35开盘报价'; continue; }
    if (!entryCapture || !(entryCapture.underlyingPrice > 0)) { info.reason = '缺少09:45–09:48入场报价'; continue; }
    const move = entryCapture.underlyingPrice / open.underlyingPrice - 1;
    info.underlyingMove = move;
    info.openAt = open.capturedAt;
    info.entryAt = entryCapture.capturedAt;
    if (Math.abs(move) < config.minMovePct) { info.reason = '开盘涨跌幅未达到入场阈值'; continue; }
    const right = move > 0 ? 'C' : 'P';
    const candidates = (entryCapture.quotes || []).filter((quote) => quote.right === right && quote.ask > 0 && quote.bid >= 0 && quote.ask >= quote.bid && Number.isFinite(quote.delta));
    if (!candidates.length) { info.reason = '入场缺少有效方向、Delta或买卖报价'; continue; }
    candidates.sort((a, b) => Math.abs(Math.abs(a.delta) - config.targetDelta) - Math.abs(Math.abs(b.delta) - config.targetDelta));
    const contract = candidates[0];
    const entryAsk = contract.ask;
    const riskPerContract = entryAsk * 100 * Math.abs(config.stopLoss) + 2 * config.commission;
    const contracts = Math.floor(config.initialCapital * config.riskPerTrade / riskPerContract);
    if (contracts < 1) { info.reason = '风险预算不足以购买1张'; continue; }
    let peakReturn = -Infinity;
    let exit = null;
    let reason = 'data ended';
    let completed = false;
    for (const capture of day) {
      if (capture.capturedAt < entryCapture.capturedAt) continue;
      const quote = (capture.quotes || []).find((item) => item.optionSymbol === contract.optionSymbol);
      if (!quote || !(quote.bid >= 0) || !(quote.ask >= quote.bid)) continue;
      const optionReturn = quote.bid / entryAsk - 1;
      peakReturn = Math.max(peakReturn, optionReturn);
      const locked = peakReturn >= config.lockTrigger;
      const activeStop = locked ? config.lockedStop : config.stopLoss;
      if (optionReturn <= activeStop) { exit = { capture, quote }; reason = locked ? 'locked stop' : 'premium stop'; completed = true; break; }
      if (optionReturn >= config.profitTarget) { exit = { capture, quote }; reason = 'profit target'; completed = true; break; }
      if (capture.minute >= config.exitMinute) { exit = { capture, quote }; reason = '15:30 time'; completed = true; break; }
      if (capture.minute >= config.noFollowMinute && !locked) { exit = { capture, quote }; reason = '13:00 no follow-through'; completed = true; break; }
      exit = { capture, quote };
    }
    if (!exit || !completed) { info.reason = '退出前数据中断，未计入已完成交易'; info.status = 'incomplete'; continue; }
    const grossPnl = (exit.quote.bid - entryAsk) * 100 * contracts;
    const fees = 2 * config.commission * contracts;
    trades.push({
      marketDate, direction: right === 'C' ? 'CALL' : 'PUT', underlyingMove: move,
      optionSymbol: contract.optionSymbol, expiration: contract.expiration, strike: contract.strike,
      entryDelta: contract.delta, entryAt: entryCapture.capturedAt, entryAsk,
      exitAt: exit.capture.capturedAt, exitBid: exit.quote.bid, contracts,
      optionReturn: exit.quote.bid / entryAsk - 1, grossPnl, fees, netPnl: grossPnl - fees, reason
    });
    info.status = 'traded';
    info.reason = reason;
    info.optionSymbol = contract.optionSymbol;
    info.netPnl = grossPnl - fees;
  }
  return { config, ...summarizeYoloTrades(trades, config.initialCapital), trades, diagnostics };
}
