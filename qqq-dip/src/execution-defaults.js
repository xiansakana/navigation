import { withDeadline } from './deadline.js';
import { canExecutePlan } from './execution-plan.js';
import { CNY_FUNDS, premiumStatus } from './cny-routing.js';
import { cnMarketStatus } from './cn-market-hours.js';

function latestCnyQuoteSession(now, market) {
  if (market.session && now >= new Date(`${market.date}T09:30:00+08:00`)) return market.date;
  for (let days = 1; days <= 4; days++) {
    const previous = cnMarketStatus(new Date(now.getTime() - days * 86400000));
    if (previous.session) return previous.date;
  }
  return null;
}

export function suggestedQuantity(leg, price, fee = 0) {
  const budget = Math.max(0, Number(leg.currency === 'CNY' ? leg.cny : leg.usd) - Number(leg.spent || 0) - fee);
  const lot = ['159509', '513850', '161128'].includes(leg.symbol) ? 100 : 1;
  const multiplier = leg.kind === 'call' ? 100 : 1;
  return price > 0 && Number.isFinite(price) && Number.isFinite(budget)
    ? Math.max(0, Math.floor(budget / (price * multiplier * lot) + 1e-10) * lot) : 0;
}

export async function executionDefaults(plan, quotes, now = new Date()) {
  const legs = await Promise.all((plan.legs || []).map(async (leg) => {
    const base = { legId: leg.id, currency: leg.currency };
    if (leg.pendingOption) return { ...base, error: '本档期权预算待用，等待信号、有效卖价及整数张数条件满足；预算未扣除' };
    if (plan.cancelled || plan.inFlight || leg.complete) {
      return { ...base, error: '此腿已完成、取消或写入待核对，不自动填充' };
    }
    try {
      const quote = await withDeadline(() => leg.kind === 'call'
        ? quotes.getOptionSnapshot(leg.occSymbol)
        : ['159509', '513850', '161128'].includes(leg.symbol)
          ? (quotes.getCnyFundQuote ? quotes.getCnyFundQuote(leg.symbol) : quotes.getCnyProxyQuote())
          : quotes.getStock(leg.symbol), 15000, '计划报价');
      const price = Number(quote.price);
      const cnyFund = CNY_FUNDS[leg.symbol] && quotes.getCnyFundQuote;
      const quoteTime = Date.parse(quote.asOf || '');
      let closedCny = false;
      if (cnyFund) {
        const status = premiumStatus(quote, now);
        if (!status.valid || status.premium > CNY_FUNDS[leg.symbol].cap + 1e-8) throw new Error('参考溢价无效或超限，保留本部分预算');
        const market = cnMarketStatus(now);
        closedCny = !market.open;
        if (cnMarketStatus(new Date(quoteTime)).date !== latestCnyQuoteSession(now, market)
          || (market.open && now.getTime() - quoteTime > 120000)) {
          throw new Error('当前交易日报价缺失或过旧，暂不预填');
        }
      }
      if (!(price > 0) || !Number.isFinite(price) || quote.stale || quote.previousCloseOnly
        || (!cnyFund && Number.isFinite(quoteTime) && (now.getTime() - quoteTime > 86400000 || quoteTime > now.getTime() + 300000))) {
        throw new Error('缺少有效最新报价（不使用历史收盘价），请手动填写');
      }
      const shares = suggestedQuantity(leg, price);
      const oneContractCost = leg.kind === 'call' ? Math.round(price * 10000) / 100 : null;
      return { ...base, price, shares, oneContractCost,
        warning: closedCny ? 'A股休市，按最近交易日的报价预填。'
          : leg.kind === 'call' && shares === 0
          ? `剩余预算不足一张（约 $${oneContractCost.toFixed(2)}，手续费另计）；本腿不买，保留预算，不挪用其他档位资金` : null,
        source: quote.source || '行情接口',
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
