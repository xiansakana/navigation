import { selectAffordableCall } from './option-selection.js';
import { mediumOtmBand, shallowOtmBand, deepOtmBand } from './playbook.js';

// This changes plans only. It never transfers cash or records an estimated fill.
export function activatePendingOptions(round, ev) {
  if (ev.reset || ev.fakeRight) return { round, alerts: [] };
  const next = structuredClone(round);
  const alerts = [];
  let available = Math.max(0, Number(ev.cashUsd) || 0);
  for (const [tierId, plan] of Object.entries(next.executionPlans || {})) {
    const tier = ev.tiers?.find((t) => t.id === tierId);
    if (!tier || tier.status !== 'confirmed' || tier.pendingClose || tier.vxnGate?.blocked
      || (tierId.startsWith('R') && round.r2Frozen)
      || ev.sameDaySkip?.includes(tierId) || plan.cancelled || plan.inFlight) continue;
    // Re-evaluate the original tier, even when another tier is the primary signal.
    if (tierId.startsWith('T') && !(ev.qqq?.lastClose <= tier.triggerPrice)) continue;
    for (const leg of plan.legs) {
      if (leg.activatedAt && !leg.complete && !leg.spent) {
        alerts.push({ key: `${tierId}:option-ready:${plan.id}:${leg.id}`, event: tierId,
          symbol: 'QQQ', optionReady: true, message: `${tierId} 期权待用预算已具备补买条件，请在美股开盘后复核 ${leg.occSymbol} 最新卖价及本腿预算，再登记真实成交。` });
      }
      if (!leg.pendingOption || leg.complete || leg.spent > 0) continue;
      const band = leg.otmClass === 'deep' ? deepOtmBand(ev.qqq?.price)
        : ['shallow', 'shallow-medium'].includes(leg.otmClass) ? shallowOtmBand(ev.qqq?.price)
          : mediumOtmBand(ev.qqq?.price);
      const selection = selectAffordableCall(ev.suggestedContracts || [], { band,
        expiries: (ev.leaps?.expiries || []).map((e) => e.expiry),
        budget: Math.min(leg.usd, available, ev.remaining?.[tier.bag] ?? 0) });
      if (!selection.contract) { leg.pendingReason = selection.reason; continue; }
      const c = selection.contract;
      Object.assign(leg, { pendingOption: false, skipped: false, occSymbol: c.ticker,
        expiry: c.expiry, strike: c.strike, price: c.ask, quoteAsOf: c.asOf,
        shares: selection.shares, oneContractCost: selection.oneContractCost,
        activatedAt: new Date().toISOString() });
      available -= leg.usd;
      alerts.push({ key: `${tierId}:option-ready:${plan.id}:${leg.id}`, event: tierId,
        symbol: 'QQQ', optionReady: true,
        message: `${tierId} 期权待用预算可补买：${c.ticker}，预算 $${leg.usd.toFixed(2)}，一张约 $${selection.oneContractCost.toFixed(2)}，最多 ${selection.shares} 张（费用另计）。请复核真实报价，手动登记成交。` });
    }
  }
  return { round: next, alerts };
}
