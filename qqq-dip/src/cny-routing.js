export const CNY_FUNDS = {
  '159509': { name: '纳指科技ETF景顺', cap: 25 },
  '513850': { name: '美国50ETF易方达', cap: 10 },
  '161128': { name: '标普信息科技LOF', cap: 10 }
};
const money = (n) => Math.round(n * 100) / 100;

export function premiumStatus(quote, now = new Date()) {
  const price = Number(quote?.price), nav = Number(quote?.nav);
  const quoteTime = Date.parse(quote?.asOf);
  const navTime = /^\d{4}-\d{2}-\d{2}$/.test(quote?.navDate || '')
    ? Date.parse(quote.navDate + 'T00:00:00+08:00') : NaN;
  // Published QDII NAVs lag. This is a disclosed NAV reference, not realtime IOPV.
  if (quote?.stale || quote?.suspended || !(price > 0) || !(nav > 0) || !Number.isFinite(price) || !Number.isFinite(nav) || !Number.isFinite(quoteTime) || !Number.isFinite(navTime)
    || now - quoteTime > 4 * 86400000 || quoteTime > now.getTime() + 300000
    || quoteTime - navTime > 4 * 86400000 || navTime > quoteTime) {
    return { valid: false, reason: '行情或净值缺失/过旧，保留人民币预算' };
  }
  return { valid: true, premium: (price / nav - 1) * 100, nav, navDate: quote.navDate,
    asOf: quote.asOf, source: quote.navSource || 'eastmoney-published-nav' };
}

export function selectCnyFunds(quotes, now = new Date()) {
  const primary = premiumStatus(quotes?.['159509'], now);
  if (!primary.valid) return [{ symbol: '159509', weight: 1, blocked: true, ...primary }];
  const symbols = primary.premium > 25 + 1e-8 ? ['513850', '161128'] : ['159509'];
  return symbols.map((symbol) => {
    const status = premiumStatus(quotes?.[symbol], now);
    const blocked = !status.valid || status.premium > CNY_FUNDS[symbol].cap + 1e-8;
    return { symbol, weight: 1 / symbols.length, ...status, blocked,
      reason: !status.valid ? status.reason : blocked ? '溢价超过10%上限，保留本部分预算' : '',
      price: quotes?.[symbol]?.price, name: CNY_FUNDS[symbol].name,
      selection: primary.premium > 25 ? '159509 溢价超过25%，替代标的各50%' : '159509 溢价未超过25%' };
  });
}

export function routeCnyBudget(cny, usd, quotes, now = new Date()) {
  const rows = selectCnyFunds(quotes, now);
  let allocatedCny = 0, allocatedUsd = 0;
  return rows.map((row, i) => {
    const last = i === rows.length - 1;
    const amount = last ? money(cny - allocatedCny) : money(cny * row.weight);
    const equiv = last ? money(usd - allocatedUsd) : money(usd * row.weight);
    allocatedCny += amount; allocatedUsd += equiv;
    return { ...row, cny: amount, usd: equiv, cnyPolicyVersion: 1,
      note: [row.selection, row.valid ? `参考溢价 ${row.premium.toFixed(2)}%（净值 ${row.navDate}，行情 ${row.asOf}）` : '', row.reason].filter(Boolean).join('；') };
  });
}

export function validateCnyLeg(leg, quotes, now = new Date(), price = null) {
  const row = selectCnyFunds(quotes, now).find((r) => r.symbol === leg.symbol);
  if (!row || row.blocked) throw new Error('人民币标的不符合当前25%/10%溢价规则，请更新未成交人民币标的或保留预算');
  const cap = CNY_FUNDS[leg.symbol].cap;
  if (price != null && price / row.nav - 1 > cap / 100 + 1e-10) throw new Error('实际成交价超过本标的溢价上限，请在持仓页如实登记策略外成交');
  return row;
}

// Explicitly refresh only the unfilled CNY remainder. Receipts, spent amounts,
// original fills and every USD/option leg remain unchanged.
export function refreshCnyPlan(plan, quotes, now = new Date()) {
  if (!plan || plan.cancelled || plan.inFlight) throw new Error('计划不可调整');
  const next = structuredClone(plan);
  const remaining = next.legs.filter((leg) => leg.kind === 'equity' && leg.currency === 'CNY' && !leg.complete);
  const cny = money(remaining.reduce((s, l) => s + Math.max(0, l.cny - (l.spent || 0)), 0));
  const usd = money(remaining.reduce((s, l) => s + (l.cny > 0 ? Math.max(0, l.cny - (l.spent || 0)) / l.cny * l.usd : 0), 0));
  if (!(cny > 0)) throw new Error('没有未成交的人民币预算');
  for (const leg of remaining) {
    const used = Number(leg.spent) || 0;
    leg.usd = money(leg.cny > 0 ? leg.usd * used / leg.cny : 0);
    leg.cny = used;
    leg.complete = true;
    leg.routingReplaced = true;
  }
  const revision = (next.cnyRevision || 0) + 1;
  const rows = routeCnyBudget(cny, usd, quotes, now);
  next.legs.push(...rows.map((row, index) => ({ ...row, id: `cny-${revision}-${index}`,
    kind: 'equity', currency: 'CNY', spent: 0, complete: false, shares: row.blocked ? 0
      : Math.floor(row.cny / row.price / 100) * 100, routeBlocked: row.blocked })));
  next.cnyRevision = revision;
  next.cnyRoutingAt = now.toISOString();
  return next;
}
