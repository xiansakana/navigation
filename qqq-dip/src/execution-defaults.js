import { withDeadline } from './deadline.js';
import { canExecutePlan } from './execution-plan.js';

export function suggestedQuantity(leg, price, fee = 0) {
  const budget = Math.max(0, Number(leg.currency === 'CNY' ? leg.cny : leg.usd) - Number(leg.spent || 0) - fee);
  const lot = leg.symbol === '159509' ? 100 : 1;
  const multiplier = leg.kind === 'call' ? 100 : 1;
  return price > 0 && Number.isFinite(price) && Number.isFinite(budget)
    ? Math.max(0, Math.floor(budget / (price * multiplier * lot) + 1e-10) * lot) : 0;
}

export async function executionDefaults(plan, quotes, now = new Date()) {
  const legs = await Promise.all((plan.legs || []).map(async (leg) => {
    const base = { legId: leg.id, currency: leg.currency };
    if (plan.cancelled || plan.inFlight || leg.complete) {
      return { ...base, error: '此腿已完成、取消或写入待核对，不自动填充' };
    }
    try {
      const quote = await withDeadline(() => leg.kind === 'call'
        ? quotes.getOptionSnapshot(leg.occSymbol)
        : leg.symbol === '159509' ? quotes.getCnyProxyQuote() : quotes.getStock(leg.symbol), 15000, '计划报价');
      const price = Number(quote.price);
      const quoteTime = Date.parse(quote.asOf || '');
      if (!(price > 0) || !Number.isFinite(price) || quote.stale || quote.previousCloseOnly
        || (Number.isFinite(quoteTime) && (now.getTime() - quoteTime > 86400000 || quoteTime > now.getTime() + 300000))) {
        throw new Error('缺少有效最新报价（不使用历史收盘价），请手动填写');
      }
      return { ...base, price, shares: suggestedQuantity(leg, price), source: quote.source || '行情接口',
        asOf: quote.asOf || null, fetchedAt: new Date().toISOString() };
    } catch (error) {
      return { ...base, error: error.message };
    }
  }));
  return { planId: plan.id, legs };
}

export function createExecutionDefaultsHandler({ store, quotes }) {
  return async (req, res) => {
    if (!canExecutePlan(req.headers['x-portal-permissions'])) return res.status(403).json({ error: '无档位成交登记权限' });
    const current = store.getRound().executionPlans?.[req.params.tier];
    if (!current) return res.status(404).json({ error: '计划不存在' });
    const plan = structuredClone(current);
    const defaults = await executionDefaults(plan, quotes);
    if (JSON.stringify(store.getRound().executionPlans?.[req.params.tier]) !== JSON.stringify(plan)) {
      return res.status(409).json({ error: '计划已变化，请关闭并重新打开' });
    }
    res.json(defaults);
  };
}
