function etMinute(iso) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit'
  }).formatToParts(new Date(iso));
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Number(value.hour) * 60 + Number(value.minute);
}

function summarize(trades, initialCapital) {
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
    minMovePct: Math.min(0.02, Math.max(0, Number(raw.minMovePct) || 0.0015)),
    stopLoss: -Math.min(0.95, Math.max(0.05, Number(raw.stopLoss) || 0.35)),
    profitTarget: Math.min(5, Math.max(0.05, Number(raw.profitTarget) || 0.55)),
    lockTrigger: Math.min(5, Math.max(0.05, Number(raw.lockTrigger) || 0.35)),
    lockedStop: Math.min(2, Math.max(0, Number(raw.lockedStop) || 0.10)),
    entryMinute: 9 * 60 + 45,
    noFollowMinute: 13 * 60,
    exitMinute: 15 * 60 + 30,
    initialCapital: Math.max(1000, Number(raw.initialCapital) || 100000),
    riskPerTrade: Math.min(0.05, Math.max(0.001, Number(raw.riskPerTrade) || 0.005)),
    commission: Math.max(0, Number(raw.commission) || 0.65)
  };
  const byDate = new Map();
  for (const capture of captures || []) {
    if (!byDate.has(capture.marketDate)) byDate.set(capture.marketDate, []);
    byDate.get(capture.marketDate).push({ ...capture, minute: etMinute(capture.capturedAt) });
  }
  const trades = [];
  for (const [marketDate, dayRaw] of byDate) {
    const day = dayRaw.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
    const open = day.find((item) => item.minute >= 9 * 60 + 30 && item.minute <= 9 * 60 + 35);
    const entryCapture = day.find((item) => item.minute >= config.entryMinute && item.minute <= config.entryMinute + 3);
    if (!open || !entryCapture || !(open.underlyingPrice > 0) || !(entryCapture.underlyingPrice > 0)) continue;
    const move = entryCapture.underlyingPrice / open.underlyingPrice - 1;
    if (Math.abs(move) < config.minMovePct) continue;
    const right = move > 0 ? 'C' : 'P';
    const candidates = (entryCapture.quotes || []).filter((quote) => quote.right === right && quote.ask > 0 && quote.bid >= 0 && Number.isFinite(quote.delta));
    if (!candidates.length) continue;
    candidates.sort((a, b) => Math.abs(Math.abs(a.delta) - config.targetDelta) - Math.abs(Math.abs(b.delta) - config.targetDelta));
    const contract = candidates[0];
    const entryAsk = contract.ask;
    const riskPerContract = entryAsk * 100 * Math.abs(config.stopLoss) + 2 * config.commission;
    const contracts = Math.floor(config.initialCapital * config.riskPerTrade / riskPerContract);
    if (contracts < 1) continue;
    let peakReturn = -Infinity;
    let exit = null;
    let reason = '15:30 time';
    for (const capture of day) {
      if (capture.capturedAt < entryCapture.capturedAt) continue;
      const quote = (capture.quotes || []).find((item) => item.optionSymbol === contract.optionSymbol);
      if (!quote || !(quote.bid >= 0)) continue;
      const optionReturn = quote.bid / entryAsk - 1;
      peakReturn = Math.max(peakReturn, optionReturn);
      const locked = peakReturn >= config.lockTrigger;
      const activeStop = locked ? config.lockedStop : config.stopLoss;
      if (optionReturn <= activeStop) { exit = { capture, quote }; reason = locked ? 'locked stop' : 'premium stop'; break; }
      if (optionReturn >= config.profitTarget) { exit = { capture, quote }; reason = 'profit target'; break; }
      if (capture.minute >= config.noFollowMinute && !locked) { exit = { capture, quote }; reason = '13:00 no follow-through'; break; }
      if (capture.minute >= config.exitMinute) { exit = { capture, quote }; reason = '15:30 time'; break; }
      exit = { capture, quote };
    }
    if (!exit) continue;
    const grossPnl = (exit.quote.bid - entryAsk) * 100 * contracts;
    const fees = 2 * config.commission * contracts;
    trades.push({
      marketDate, direction: right === 'C' ? 'CALL' : 'PUT', underlyingMove: move,
      optionSymbol: contract.optionSymbol, expiration: contract.expiration, strike: contract.strike,
      entryDelta: contract.delta, entryAt: entryCapture.capturedAt, entryAsk,
      exitAt: exit.capture.capturedAt, exitBid: exit.quote.bid, contracts,
      optionReturn: exit.quote.bid / entryAsk - 1, grossPnl, fees, netPnl: grossPnl - fees, reason
    });
  }
  return { config, ...summarize(trades, config.initialCapital), trades };
}
