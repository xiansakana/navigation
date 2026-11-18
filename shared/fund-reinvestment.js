import { Decimal, roundDecimal } from './portfolio-decimal.js';

export const REINVESTMENT_INCOME_CATEGORY = '红利再投资（估算）';

export function parseReinvestmentNav(value) {
  if (value == null || String(value).trim() === '') return undefined;
  const nav = Number(value);
  if (!Number.isFinite(nav) || nav <= 0) throw new Error('折算净值必须大于 0');
  return nav;
}

export function estimatedReinvestmentIncome(trade) {
  if (trade.type !== 'buy' || !trade.reinvestedDividend || !(trade.reinvestmentNav > 0)) return 0;
  return roundDecimal(new Decimal(trade.shares).times(trade.reinvestmentNav), 2);
}

// These entries are only used in performance calculations. The saved trade
// still carries no cash movement.
export function tradesWithReinvestmentIncome(trades) {
  return trades.flatMap(trade => {
    const amount = estimatedReinvestmentIncome(trade);
    if (!(amount > 0)) return [trade];
    return [
      { ...trade, price: trade.reinvestmentNav, total_amount: amount },
      { ...trade, id: 'reinvestment-income:' + trade.id, type: 'other', other_category: REINVESTMENT_INCOME_CATEGORY,
        shares: 1, price: 0, total_amount: amount, commission: 0 }
    ];
  });
}
