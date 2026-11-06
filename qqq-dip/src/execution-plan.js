import { randomUUID } from 'node:crypto';
import { cnMarketStatus } from './cn-market-hours.js';
import { isRth, nyParts } from './market-hours.js';

export function canExecutePlan(encodedPermissions) {
  try {
    const permissions = JSON.parse(Buffer.from(encodedPermissions || '', 'base64url').toString());
    return Array.isArray(permissions) && ['*', 'service:qqq-dip:edit', 'service:qqq-dip:tier-exec:edit']
      .some((key) => permissions.includes(key));
  } catch { return false; }
}

export function canSpendDipFunds(encodedPermissions) {
  try {
    const permissions = JSON.parse(Buffer.from(encodedPermissions || '', 'base64url').toString());
    return Array.isArray(permissions) && ['*', 'service:stock-manage:edit', 'service:stock-manage:dip-spend:edit']
      .some((key) => permissions.includes(key));
  } catch { return false; }
}

export function captureExecutionPlan(round, preview, now = new Date(), { manual = false } = {}) {
  if (!preview?.available || round.executionPlans?.[preview.tier]) return round;
  const touch = manual && preview.pendingClose && /^[T][1-7]$/.test(preview.tier) && preview.equityMarket;
  if (!touch && (preview.pendingClose || preview.status !== 'confirmed')) return round;
  if (touch && !preview.legs.some((leg) => leg.kind === 'equity'
    && (leg.currency === 'CNY' ? 'CN' : 'US') === touch && leg.shares > 0)) return round;
  const legs = preview.legs.map((leg, index) => ({ ...leg, pendingOption: leg.kind === 'call' && !!(leg.skipped || touch),
    id: String(index), spent: 0, complete: false, expiresAt: null }));
  if (!legs.length) return round;
  const plan = { id: randomUUID(), tier: preview.tier, createdAt: now.toISOString(),
    intradayEquity: !!touch,
    expiresAt: legs.every((leg) => leg.expiresAt) ? legs.map((leg) => leg.expiresAt).sort().at(-1) : null,
    receipts: {}, totalUsd: preview.totalUsd, legs };
  return { ...round, executionPlans: { ...round.executionPlans, [preview.tier]: plan } };
}

export function executionPlanState(plan, now = new Date()) {
  if (plan.cancelled) return '已取消';
  if (plan.legs.every((leg) => leg.complete)) return '已完成';
  if (plan.legs.some((leg) => leg.spent > 0)) return '部分成交';
  return '待执行';
}

export function commitExecution(store, body, prepared, writePortfolio) {
  const round = store.getRound();
  const current = round.executionPlans?.[body.tier];
  if (!current || current.id !== body.planId || current.inFlight) throw new Error('计划已变化或写入待核对');
  current.inFlight = body.requestId;
  store.setRound(round);
  const result = writePortfolio();
  store.markExecuted(body.tier, { usd: prepared.usd, cashUsd: prepared.cashUsd,
    cashCny: prepared.cashCny, complete: prepared.plan.legs.every((leg) => leg.complete), note: body.note });
  const updated = store.getRound();
  prepared.plan.receipts[body.requestId] = new Date().toISOString();
  updated.executionPlans[body.tier] = prepared.plan;
  store.setRound(updated);
  return result;
}

// Validate the whole batch before any cash/portfolio write. No estimated fills.
export function prepareExecution(plan, body, evaluation, cash, now = new Date()) {
  if (!plan || body.planId !== plan.id) throw new Error('计划已变化，请刷新后重试');
  if (!/^[\w-]{8,80}$/.test(body.requestId || '')) throw new Error('缺少有效成交请求标识');
  if (plan.receipts?.[body.requestId]) return { duplicate: true };
  if (plan.inFlight) throw new Error('上次成交写入待核对，禁止重复扣款，请人工核对持仓与计划');
  if (plan.cancelled || plan.legs.every((leg) => leg.complete)) throw new Error('计划已结束');
  if (!body.reviewed) throw new Error('请确认已复核最新信号、报价、溢价与实际成交');
  const time = new Date(body.filledAt);
  if (!(Number(cash.usdCnyRate) > 0) || !Number.isFinite(Number(cash.usdCnyRate))) throw new Error('汇率无效');
  if (!Number.isFinite(time.getTime()) || time > now || time < new Date(plan.createdAt)) throw new Error('成交时间无效、晚于当前时间或早于计划创建');
  if (evaluation.reset || (plan.tier.startsWith('R') && evaluation.round?.r2Frozen)) throw new Error('信号已失效，请人工核对，不可继续登记此计划');
  const tier = evaluation.tiers?.find((row) => row.id === plan.tier);
  const touch = tier?.pendingClose && !evaluation.sameDaySkip?.includes(plan.tier) ? tier.equityMarket : null;
  if (!tier || (!touch && (!['confirmed', 'executed'].includes(tier.status) || tier.pendingClose))) {
    throw new Error('信号不再确认，或当前报价未满足盘中正股执行条件');
  }
  if (!Array.isArray(body.fills) || !body.fills.length) throw new Error('请填写至少一笔实际成交');
  const next = structuredClone(plan);
  const seen = new Set();
  const legs = [];
  let cashUsd = 0;
  let cashCny = 0;
  for (const fill of body.fills) {
    const leg = next.legs.find((row) => row.id === fill.legId);
    if (!leg || leg.complete || seen.has(leg.id)) throw new Error('交易腿已完成或重复提交');
    if (leg.pendingOption) throw new Error('期权预算待用，尚无可执行合约，禁止登记成交');
    seen.add(leg.id);
    const shares = Number(fill.shares);
    const price = Number(fill.price);
    const commission = Number(fill.commission || 0);
    if (!(shares > 0) || !Number.isInteger(shares) || !(price > 0) || !Number.isFinite(price)
      || !Number.isFinite(commission) || commission < 0) throw new Error('实际数量、价格或费用无效');
    if (touch) {
      if (leg.kind !== 'equity') throw new Error('期权必须等待收盘确认');
      const market = leg.currency === 'CNY' ? 'CN' : 'US';
      const sameSession = market === 'CN' ? cnMarketStatus(time).date === cnMarketStatus(now).date
        : nyParts(time).ymd === nyParts(now).ymd;
      if (market !== touch || !sameSession) {
        throw new Error('盘中正股须在对应市场开盘且现价仍达标时登记；较早的真实成交请在持仓页记账');
      }
      if (leg.symbol === 'QQQ' && price > tier.triggerPrice) throw new Error('QQQ 实际成交价高于盘中触发价');
    }
    if (leg.symbol === '159509') {
      if (!cnMarketStatus(time).open) throw new Error('159509 成交时间须在已维护的A股常规交易时段');
      if (shares % 100) throw new Error('159509 买入数量须为100份整数倍');
    }
    if (leg.currency === 'USD' && !isRth(time)) throw new Error('美元腿成交时间须在美股常规交易时段（暂不支持盘前盘后）');
    if (leg.kind === 'call' && (tier.closeConfirmed === false || tier.vxnGate?.blocked
      || (leg.activatedAt && time < new Date(leg.activatedAt)))) throw new Error('期权尚未满足收盘确认、波动率或合约启用条件');
    const amount = Math.round((shares * price * (leg.kind === 'call' ? 100 : 1) + commission) * 100) / 100;
    const futureCarry = (leg.budgetCarryIns || []).reduce((sum, entry) =>
      time < new Date(entry.at) ? sum + entry.usd : sum, 0);
    const budget = leg.currency === 'CNY' ? leg.cny : leg.usd - futureCarry;
    if (!Number.isFinite(amount) || !(budget > 0) || leg.spent + amount > budget + 0.01) throw new Error('实际成交超过该交易腿预算（含费用），请先核对');
    leg.spent += amount;
    leg.complete = fill.complete === true;
    legs.push({ ...leg, shares, contracts: shares, price, commission });
    if (leg.currency === 'CNY') cashCny += amount; else cashUsd += amount;
  }
  if (cashUsd > Number(cash.cashUsd) + 0.01 || cashCny > Number(cash.cashCny) + 0.01) throw new Error('对应币种现金不足');
  const usd = Math.round((cashUsd + cashCny / cash.usdCnyRate) * 100) / 100;
  if (Number.isFinite(plan.totalUsd) && Number(evaluation.round?.executed?.[plan.tier]?.usd || 0) + usd > plan.totalUsd + 0.01) {
    throw new Error('累计成交超过本档总预算（含费用）');
  }
  if (evaluation.remaining?.[tier.bag] != null && usd > evaluation.remaining[tier.bag] + 0.01) throw new Error('对应袋内预算不足');
  return { plan: next, legs, cashUsd, cashCny, intradayEquity: !!touch, filledAt: time.toISOString(),
    usd };
}
