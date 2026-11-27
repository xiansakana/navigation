export const EVENT_LABELS: Record<string, string> = {
  T1: 'T1', T2: 'T2', T3: 'T3', T4: 'T4', T5: 'T5', T6: 'T6', T7: 'T7',
  R1: 'R1', R2: 'R2', T4_intraday: 'T4 盘中限价', takeProfit: '止盈',
  fakeRight: '假右侧', reset: '高点重置', openSummary: '开盘摘要（每交易日开盘 5 分钟后）',
  sleeveTqqq: 'TQQQ 袖仓', sleeveSoxl: 'SOXL 袖仓'
};

const SENTIMENT_LABELS: Record<string, string> = {
  'extreme fear': '极度恐惧', fear: '恐惧', neutral: '中性', greed: '贪婪', 'extreme greed': '极度贪婪'
};

export function sentimentReading(value: any) {
  return `${Number(value.score).toFixed(1)} / 100 · ${SENTIMENT_LABELS[value.rating] || '—'}`;
}

export function escapeHtml(text: unknown) {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function formatDateTime(value: any, fallback = '—') {
  if (value == null || value === '') return fallback;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('sv-SE') : fallback;
}

export function fmtCny(n: any) {
  if (!Number.isFinite(Number(n))) return '—';
  return `¥${Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;
}
export function fmtUsd(n: any) {
  if (!Number.isFinite(Number(n))) return '—';
  return Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}
export function fmtPrice(value: any) {
  return value != null && Number.isFinite(Number(value)) ? Number(value).toFixed(3) : '—';
}
export function fmtPctB(pctB: any) {
  const pct = (Number(pctB) || 0) * 100;
  const rounded = Math.round(pct * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}
export function fmtPct(n: any, digits = 2) {
  if (n == null || n === '') return '—';
  if (!Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(digits)}%`;
}
export function fmtFxHint(cash: any) {
  if (!cash?.fxUpdatedAt) return '打开页面或刷新行情时自动更新';
  const src = cash.fxSource === 'manual' ? '手动' : (cash.fxSource || '自动');
  const ts = Date.parse(cash.fxUpdatedAt);
  if (!Number.isFinite(ts)) return `${src}更新`;
  const mins = Math.max(1, Math.round((Date.now() - ts) / 60000));
  if (mins < 60) return `${src} · ${mins} 分钟前`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${src} · ${hours} 小时前`;
  return `${src} · ${Math.round(hours / 24)} 天前`;
}
export function pctClass(n: any) {
  if (!Number.isFinite(Number(n))) return '';
  return Number(n) >= 0 ? 'up' : 'down';
}
export function statusLabel(s: string) {
  return ({ confirmed: '已触发', intraday: '盘中触及', executed: '已执行', locked: '锁定', frozen: '冻结', void: '已作废', idle: '未到' } as any)[s] || s || '—';
}
export function bagLabel(bag: string) {
  return ({ left: '左侧', crisis: '危机', right: '右侧' } as any)[bag] || bag || '—';
}
export function roundPriceClient(n: any) {
  return Math.round((Number(n) || 0) * 1000) / 1000;
}

export function sleeveBySymbol(evaluation: any, symbol: string) {
  return (evaluation?.sleeves || []).find((item: any) => item.symbol === symbol) || null;
}

export function nextLevelHint(label: string, stats: any, settings: any, evaluation: any) {
  if (['159509', '513850', '161128'].includes(label)) {
    return `${stats?.H ? `自身 H ${stats.H.toFixed(3)}（近60根日线）` : '自身 H — · 历史行情不可用'} · 梯度按 QQQ 触发`;
  }
  if (!stats?.H) return '—';
  const H = stats.H;
  const hTxt = `H ${H.toFixed(3)}`;
  if (label === 'QQQ') return `${hTxt} · T1(−8%) ${fmtPrice(stats.triggers?.T1)}`;
  if (label === 'SPY') return `${hTxt} · 非独立梯子（最多可作 QQQ T1 的 20% 降波）`;
  if (label === 'TQQQ') {
    const sleeve = sleeveBySymbol(evaluation, 'TQQQ');
    const t35 = sleeve?.trigger35 ?? roundPriceClient(H * 0.65);
    const t50 = sleeve?.trigger50 ?? roundPriceClient(H * 0.5);
    const dd = stats.drawdownLive;
    if (dd != null && dd <= -50) return `${hTxt} · 袖仓已到 −50%（上限档 ${fmtPrice(t50)}）`;
    if (dd != null && dd <= -35) return `${hTxt} · 下一袖仓 −50% ${fmtPrice(t50)}`;
    return `${hTxt} · 下一袖仓 −35% ${fmtPrice(t35)}`;
  }
  if (label === 'SOXL') {
    const sleeve = sleeveBySymbol(evaluation, 'SOXL');
    const t70 = sleeve?.trigger70 ?? roundPriceClient(H * 0.3);
    const t90 = sleeve?.trigger90 ?? roundPriceClient(H * 0.1);
    const dd = stats.drawdownLive;
    if (!settings?.soxlEnabled) return `${hTxt} · 芯片观点未开`;
    if (dd != null && dd <= -90) return `${hTxt} · 袖仓已到 −90% 上限档（${fmtPrice(t90)}）`;
    if (dd != null && dd <= -70) return `${hTxt} · 已到开始档 −70% ${fmtPrice(t70)}；下一袖仓 −90% ${fmtPrice(t90)}`;
    return `${hTxt} · 下一袖仓 −70% ${fmtPrice(t70)}；上限档 −90% ${fmtPrice(t90)}`;
  }
  return hTxt;
}

export function planLabel(plan: any, evaluation: any) {
  if (plan.cancelled) return '已取消';
  if (plan.legs.every((leg: any) => leg.complete)) return '已完成';
  return `${plan.legs.some((leg: any) => leg.spent > 0) ? '部分成交' : '待执行'} · ${evaluation?.cnMarket?.label || ''}`;
}

export function renderTierBudget(tier: any, plan: any, maskMoney: (html: string) => string, maskMoneyText: (text: string) => string) {
  const original = `<div>原档预算 ${maskMoney(fmtUsd(tier.usd))}</div>`;
  if (!plan || !tier.planBalance) return `${original}<div class="hint">尚未建计划</div>`;
  const { remainingUsd, remainingCny } = tier.planBalance;
  const total = `<div><strong>未用余额 ${maskMoney(fmtUsd(remainingUsd))} + ${maskMoney(fmtCny(remainingCny))}</strong></div>`;
  const transfers = plan.legs.flatMap((leg: any) => [
    ...(leg.budgetCarryIns || []).map((entry: any) => `从 ${escapeHtml(entry.tier)} 顺延入 ${maskMoney(fmtUsd(entry.usd))}`),
    ...(leg.budgetCarryOut ? [`顺延至 ${escapeHtml(leg.budgetCarryOut.tier)} ${maskMoney(fmtUsd(leg.budgetCarryOut.usd))}`] : [])
  ]);
  const callLabels: any = { medium: '中虚值 Call', deep: '深虚值 Call', shallow: '浅虚值 Call', 'shallow-medium': '中浅虚值 Call' };
  const legs = plan.legs.flatMap((leg: any) => {
    const cny = leg.currency === 'CNY';
    const format = cny ? fmtCny : fmtUsd;
    const amount = (value: any) => maskMoney(format(value));
    const allocated = Number(cny ? leg.cny : leg.usd) || 0;
    const spent = Number(leg.spent) || 0;
    if (allocated <= 0 && spent <= 0) return [];
    const label = leg.kind === 'call' ? callLabels[leg.otmClass] || '期权 Call' : escapeHtml(leg.symbol);
    const left = Math.max(0, Math.round((allocated - spent) * 100) / 100);
    const remainder = plan.cancelled ? '已取消' : leg.complete
      ? (left > 0 ? `已结束，余款 ${amount(left)}` : '已完成')
      : `剩 ${amount(left)}${leg.pendingOption ? '（待补买）' : ''}`;
    return [`<div class="hint">${label}：分配 ${amount(allocated)} · 已成交 ${amount(spent)} · ${remainder}</div>`];
  });
  return `${total}${original}${transfers.map((line: string) => `<div class="hint">${line}</div>`).join('')}${legs.join('')}`;
}

export function legRowHtml(leg: any) {
  if (leg.kind === 'equity') {
    const isCny = leg.currency === 'CNY';
    const budget = isCny ? `${fmtCny(leg.cny)}（≈${fmtUsd(leg.usd)}）` : fmtUsd(leg.usd);
    const qty = `${leg.shares} 股 @ ${leg.price != null ? leg.price.toFixed(3) : '—'}`;
    const ref = isCny ? (leg.estCny != null ? `≈ ${fmtCny(leg.estCny)}` : '—') : `≈ ${fmtUsd(leg.estUsd)}`;
    return `<tr><td>正股${isCny ? '·CNY' : '·USD'}</td><td>${escapeHtml(leg.symbol)}</td><td>${leg.routeBlocked ? '保留预算' : '买入'}</td><td>${leg.pct}%</td><td>${budget}</td><td>${leg.routeBlocked ? '0 股（待条件满足）' : qty}</td><td>${ref}</td><td>${escapeHtml(leg.note || '')}</td></tr>`;
  }
  const carry = leg.carryInfo ? `<div class="hint">${escapeHtml(leg.carryInfo)}</div>` : '';
  if (leg.skipped) {
    const reference = leg.referenceContract;
    const cost = leg.minimumCost != null ? `最低一张 ${fmtUsd(leg.minimumCost)}（手续费另计）` : '报价不可用';
    const contract = reference ? `${escapeHtml(reference.ticker)}<div class="hint">${escapeHtml(reference.expiry)} · ${fmtPrice(reference.strike)} Call</div>` : '暂不推荐';
    const price = reference ? `卖价 ${fmtUsd(reference.ask)} × 100 · ${cost}` : cost;
    return `<tr><td>Call·USD</td><td>${contract}</td><td>跳过</td><td>${leg.pct}%</td><td>${fmtUsd(leg.usd)}（保留）</td><td>0 张</td><td>${price}</td><td>${escapeHtml(leg.reason)}${carry}</td></tr>`;
  }
  return `<tr><td>Call·USD</td><td>${escapeHtml(leg.occSymbol || leg.symbol)}</td><td>买入</td><td>${leg.pct}%</td><td>${fmtUsd(leg.usd)}</td><td>${leg.shares ?? 0} 张 · ${fmtPrice(leg.strike)} / ${escapeHtml(leg.expiry || '—')}</td><td>${leg.otmPct != null ? leg.otmPct.toFixed(1) + '% 虚值' : '—'} · 卖价 ${fmtPrice(leg.price)} × 100 = ${fmtUsd(leg.oneContractCost)} / 张（手续费另计）</td><td>${escapeHtml(leg.note || '')}${carry}</td></tr>`;
}
