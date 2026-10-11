export function isDividendTax(category) {
  return String(category || '').normalize('NFKC').trim() === '股息税';
}

export function normalizeOtherAmount(category, amount) {
  const value = Number(amount);
  return isDividendTax(category) && Number.isFinite(value) && value > 0 ? -value : value;
}

export function normalizeDividendTaxTrade(trade) {
  if (trade?.type !== 'other' || !isDividendTax(trade.other_category) || !(Number(trade.total_amount) > 0)) return trade;
  return { ...trade, total_amount: -Number(trade.total_amount) };
}

/** Preserve current cash adjustments; correct only the delta caused by sign fixes. */
export function correctDividendTaxPortfolio(portfolio) {
  let usdDelta = 0, cnyDelta = 0;
  const trades = portfolio.trades.map((trade) => {
    const normalized = normalizeDividendTaxTrade(trade);
    if (normalized !== trade) {
      const delta = normalized.total_amount - Number(trade.total_amount);
      const cny = trade.currency ? String(trade.currency).toUpperCase() === 'CNY' : /^(?:(?:SH|SZ|SS)\.?)?\d{6}(?:\.(?:SH|SZ|SS))?$/i.test(String(trade.symbol || ''));
      if (cny) cnyDelta += delta;
      else usdDelta += delta;
    }
    return normalized;
  });
  const round = (value) => Math.round(value * 100) / 100;
  const cashUsd = round(portfolio.cashUsd + usdDelta), cashCny = round(portfolio.cashCny + cnyDelta);
  return { ...portfolio, trades, cashUsd, cashCny, cash: round(cashUsd + cashCny / portfolio.usdCnyRate) };
}
