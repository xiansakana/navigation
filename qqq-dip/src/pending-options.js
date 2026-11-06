import { selectAffordableCall } from './option-selection.js';
import { mediumOtmBand, shallowOtmBand, deepOtmBand, roundMoney, TIER_ORDER } from './playbook.js';

function selectForLeg(ev, leg, budget, contracts = ev.suggestedContracts || []) {
  const band = leg.otmClass === 'deep' ? deepOtmBand(ev.qqq?.price)
    : ['shallow', 'shallow-medium'].includes(leg.otmClass) ? shallowOtmBand(ev.qqq?.price)
      : mediumOtmBand(ev.qqq?.price);
  return selectAffordableCall(contracts, { band,
    expiries: (ev.leaps?.expiries || []).map((e) => e.expiry), budget });
}

function confirmedPlans(round, ev) {
  return TIER_ORDER.flatMap((id, index) => {
    const plan = round.executionPlans?.[id];
    const tier = ev.tiers?.find((row) => row.id === id);
    if (!plan || plan.cancelled || plan.inFlight || tier?.status !== 'confirmed' || tier.pendingClose
      || (id.startsWith('R') && round.r2Frozen)
      || (id.startsWith('T') && !(ev.qqq?.lastClose <= tier.triggerPrice))) return [];
    return [{ id, index, plan, tier }];
  });
}

function canReceive(entry, ev) {
  return !entry.tier.vxnGate?.blocked && !ev.sameDaySkip?.includes(entry.id);
}

function carryBudgets(plans, ev, round) {
  const sources = plans.flatMap((entry) => entry.plan.legs.flatMap((leg) => {
    if (leg.kind !== 'call' || leg.currency !== 'USD' || !leg.otmClass || leg.complete
      || !leg.pendingOption || leg.spent > 0 || !(leg.usd > 0)) return [];
    const result = selectForLeg(ev, leg, leg.usd);
    return result.minimumCost > leg.usd ? [{ ...entry, leg, minimumCost: result.minimumCost }] : [];
  }));
  for (const target of plans) {
    if (!canReceive(target, ev)) continue;
    for (const leg of target.plan.legs) {
      if (leg.kind !== 'call' || leg.currency !== 'USD' || !leg.otmClass || leg.complete || leg.spent > 0) continue;
      const donors = sources.filter((source) => !source.leg.complete && source.minimumCost > source.leg.usd && source.index < target.index
        && source.tier.bag === target.tier.bag && source.leg.otmClass === leg.otmClass);
      if (!donors.length) continue;
      const budget = roundMoney(donors.reduce((sum, source) => sum + source.leg.usd, leg.usd));
      const capacity = Math.min(ev.cashUsd || 0, ev.remaining?.[target.tier.bag] ?? 0);
      // Preserve a contract already published in the target plan.
      const contracts = leg.pendingOption ? ev.suggestedContracts || []
        : (ev.suggestedContracts || []).filter((c) => c.ticker === leg.occSymbol);
      const selection = selectForLeg(ev, leg, Math.min(budget, capacity), contracts);
      const original = selectForLeg(ev, leg, Math.min(leg.usd, capacity), contracts);
      if (!selection.contract || selection.shares <= original.shares) continue;
      const at = new Date().toISOString();
      for (const donor of donors) {
        const usd = donor.leg.usd;
        donor.leg.budgetCarryOut = { tier: target.id, usd, at };
        donor.leg.usd = 0;
        donor.leg.complete = true;
        donor.leg.pendingOption = false;
        donor.plan.totalUsd = roundMoney(donor.plan.totalUsd - usd);
        if (round.executed?.[donor.id] && donor.plan.legs.every((item) => item.complete)) round.executed[donor.id].complete = true;
        leg.budgetCarryIns = [...(leg.budgetCarryIns || []), { tier: donor.id, usd, at }];
      }
      target.plan.totalUsd = roundMoney(target.plan.totalUsd + budget - leg.usd);
      leg.usd = budget;
      if (!leg.pendingOption) leg.shares = selection.shares;
    }
  }
}

// This changes plans only. It never transfers cash or records an estimated fill.
export function activatePendingOptions(round, ev) {
  if (ev.reset || ev.fakeRight) return { round, alerts: [] };
  const next = structuredClone(round);
  const alerts = [];
  const plans = confirmedPlans(next, ev);
  carryBudgets(plans, ev, next);
  let available = Math.max(0, Number(ev.cashUsd) || 0);
  for (const entry of plans) {
    const { id: tierId, plan, tier } = entry;
    if (!canReceive(entry, ev)) continue;
    for (const leg of plan.legs) {
      const carryCount = leg.budgetCarryIns?.length || 0;
      const key = `${tierId}:option-ready:${plan.id}:${leg.id}${carryCount ? `:carry:${carryCount}` : ''}`;
      const carry = carryCount ? `，含 ${leg.budgetCarryIns.map((row) => `${row.tier} $${row.usd.toFixed(2)}`).join('、')} 顺延` : '';
      if ((leg.activatedAt || carryCount) && !leg.complete && !leg.spent) {
        alerts.push({ key, event: tierId,
          symbol: 'QQQ', optionReady: true, message: `${tierId} 期权预算 $${leg.usd.toFixed(2)}${carry}，请在美股开盘后复核 ${leg.occSymbol} 最新卖价及本腿预算，再登记真实成交。` });
      }
      if (!leg.pendingOption || leg.complete || leg.spent > 0) continue;
      const selection = selectForLeg(ev, leg, Math.min(leg.usd, available, ev.remaining?.[tier.bag] ?? 0));
      if (!selection.contract) { leg.pendingReason = selection.reason; continue; }
      const c = selection.contract;
      Object.assign(leg, { pendingOption: false, skipped: false, occSymbol: c.ticker,
        expiry: c.expiry, strike: c.strike, price: c.ask, quoteAsOf: c.asOf,
        shares: selection.shares, oneContractCost: selection.oneContractCost,
        activatedAt: new Date().toISOString() });
      available -= leg.usd;
      alerts.push({ key, event: tierId,
        symbol: 'QQQ', optionReady: true,
        message: `${tierId} 期权待用预算可补买：${c.ticker}，预算 $${leg.usd.toFixed(2)}${carry}，一张约 $${selection.oneContractCost.toFixed(2)}，最多 ${selection.shares} 张（费用另计）。请复核真实报价，手动登记成交。` });
    }
  }
  return { round: next, alerts };
}
