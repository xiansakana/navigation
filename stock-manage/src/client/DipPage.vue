<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from 'vue';
import { createActionHistory } from '../../../qqq-dip/public/js/action-history.js';
import { can, canStock, isPortalMode, loadPortalContext } from '../../../qqq-dip/public/js/portal-auth.js';
import {
  EVENT_LABELS, bagLabel, escapeHtml, fmtCny, fmtFxHint, fmtPct, fmtPctB, fmtPrice, fmtUsd,
  formatDateTime, legRowHtml, nextLevelHint, pctClass, planLabel, renderTierBudget, sentimentReading, statusLabel
} from './dip-format';

async function api(path: string, opts: any = {}) {
  const res = await fetch('./api' + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function toast(type: string, msg: string) {
  const t = (window as any).portalToast;
  if (t && typeof t[type] === 'function') t[type](String(msg));
  else if (type === 'error') console.error(msg);
}

const ctxTick = ref(0);
const canP = (feature: string, action = 'view') => { ctxTick.value; return can(feature, action); };
const canStockP = (feature: string, action = 'view') => { ctxTick.value; return canStock(feature, action); };

const state = reactive<any>({
  cash: { cashUsd: 0, cashCny: 0, usdCnyRate: 7.2 },
  settings: {},
  notify: { qq: {}, targets: [], events: {} },
  evaluation: null,
  monitor: {},
  lots: [],
  tab: 'monitor'
});
const noAccess = ref(false);
const ready = ref(false);
const monitorError = ref('');
const fxSaving = ref(false);
const previewOpen = ref(false);
const noteOpen = ref(false);
const lotOpen = ref(false);
const execOpen = ref(false);
const docOpen = ref(false);
const docLoading = ref(false);
const docTitle = ref('');
const docHtml = ref('');
const docId = ref('cheatsheet');
const docWide = ref(false);
const docBodyEl = ref<HTMLElement | null>(null);
const docToc = ref<{ id: string; text: string; level: number }[]>([]);
const docActive = ref('');
const noteForm = reactive({ type: 'note', message: '', symbol: '', shares: '', price: '', currency: 'USD' });
const lotForm = reactive({ symbol: '', type: 'equity', cost: '', qty: 1, tier: '', otmClass: '', strike: '', expiry: '' });
const exec = ref<any>(null);
let actionHistory: any = null;
let events: EventSource | null = null;

const showMonitor = computed(() => { ctxTick.value; return can('tab-monitor'); });
const showQq = computed(() => { ctxTick.value; return can('tab-qq'); });
const cashView = computed(() => state.cash || {});
const evaluation = computed(() => state.evaluation || {});
const monitor = computed(() => state.monitor || {});
const market = computed(() => monitor.value.market || {});
const running = computed(() => !!monitor.value.running);
const marketLabel = computed(() => `${market.value.label || '—'} · ${market.value.clock || ''} ET`);
const monitorHint = computed(() => running.value
  ? `监听中 · 已检查 ${monitor.value.checks || 0} 次。现金与持仓账本共享，执行登记会同步扣款。`
  : '规则来自 QQQ 抄底手册。不是投资建议。可点「手册速查」或「操作手册」预览完整文档。');
const errorLine = computed(() => {
  if (monitorError.value) return monitorError.value;
  const err = evaluation.value.quoteErrors;
  if (err && Object.keys(err).length) return Object.entries(err).map(([k, v]) => `${k}: ${v}`).join('；');
  if (monitor.value.lastError && typeof monitor.value.lastError === 'string') return monitor.value.lastError;
  return '';
});
const canViewLotMoney = computed(() => {
  if (!isPortalMode()) return true;
  return canP('lots') || canP('lots-edit', 'edit');
});
function maskMoney(html: string) { return canViewLotMoney.value ? html : `<span class="sm-mask">••••••</span>`; }
function maskMoneyText(text: string) { return canViewLotMoney.value ? text : '••••••'; }
const showMoney = computed(() => canP('cash'));

const primary = computed(() => evaluation.value.primary);
const preview = computed(() => evaluation.value.buyPreview);
const prohibitions = computed(() => (primary.value?.prohibitions || []));
const previewHint = computed(() => {
  const p = preview.value;
  if (!p?.available || !canViewLotMoney.value) return p?.reason ? String(p.reason) : '';
  if (p.savedRemainder) {
    return `已成交约 ${fmtUsd(p.savedRemainder.executedUsd)} · 计划未用余额 ${fmtUsd(p.savedRemainder.remainingUsd)} + ${fmtCny(p.savedRemainder.remainingCny)}。点「预览买入」查看剩余计划。`;
  }
  return `本档预算 ${fmtUsd(p.totalUsd)}；拟用 ${fmtUsd(p.cashPlan?.useUsd ?? p.totalUsd)} + ${fmtCny(p.cashPlan?.useCny || 0)}（人民币按25%/10%溢价规则选券）。QQQ ${p.spot?.toFixed(3) ?? '—'} · 159509 ${p.proxyPrice != null ? p.proxyPrice.toFixed(3) : '—'}。点「预览买入」查看拆单。`;
});

const symbolRows = computed(() => {
  const ev = evaluation.value;
  const rows: any[] = [];
  const push = (label: string, stats: any) => {
    if (!stats) return;
    rows.push({
      label,
      price: stats.price != null ? stats.price.toFixed(3) : '—',
      changePct: fmtPct(stats.changePercent),
      changeClass: pctClass(stats.changePercent),
      drawdown: fmtPct(stats.drawdownLive),
      drawClass: pctClass(stats.drawdownLive),
      hint: nextLevelHint(label, stats, state.settings, ev),
      premium: stats.premiumStatus
        ? (stats.premiumStatus.valid
          ? `参考溢价 ${stats.premiumStatus.premium.toFixed(2)}% · 净值日期 ${stats.premiumStatus.navDate} · 非实时IOPV`
          : `${stats.premiumStatus.reason} · 非实时IOPV`)
        : ''
    });
  };
  push('QQQ', ev.qqq);
  if (state.settings?.showSpy !== false) push('SPY', ev.spy);
  if (ev.cnyFundStats) {
    for (const s of ['159509', '513850', '161128']) push(s, ev.cnyFundStats[s]);
  } else if (ev.cnyProxy) push('159509', ev.cnyProxy);
  push('TQQQ', ev.tqqq);
  if (state.settings?.soxlEnabled) push('SOXL', ev.soxl);
  return rows;
});

const leapHint = computed(() => {
  const ev = evaluation.value;
  const leaps = ev.leaps;
  if (!leaps?.medium) return '';
  const contracts = (ev.suggestedContracts || []).slice(0, 6).map((c: any) => `${c.expiry} ${fmtPrice(c.strike)}C`).join(' · ');
  return `中虚值行权价约 ${fmtPrice(leaps.medium.low)}–${fmtPrice(leaps.medium.high)}；1 月 LEAP：${(leaps.expiries || []).map((x: any) => x.expiry).join(' / ') || '—'}。${contracts ? `链上有量参考：${contracts}` : ''}`;
});

const vxnHint = computed(() => {
  const ev = evaluation.value;
  const source = ({ cboe: 'Cboe', fred: 'FRED', yahoo: 'Yahoo' } as any)[ev.vxnQuote?.source] || '';
  const gates = ev.vxn == null ? '期权门槛暂停判定'
    : `T2≥25 ${ev.vxnGates?.t2?.ok ? '过' : '未过'} · T3≥32 ${ev.vxnGates?.t3?.ok ? '过' : '未过'}`;
  const asOf = ev.vxnQuote?.asOf ? ` · ${source} 收盘 ${ev.vxnQuote.asOf}` : '';
  return `${gates}${asOf}`;
});

const tiers = computed(() => (evaluation.value.tiers || []).map((t: any) => {
  const plan = evaluation.value.round?.executionPlans?.[t.id];
  return {
    ...t,
    cond: t.triggerCondition || '—',
    action: t.recommendation || '—',
    bag: bagLabel(t.bag),
    pctB: fmtPctB(t.pctB),
    price: `${fmtPrice(t.triggerPrice)}${t.intradayPrice ? ` / 盘中 ${fmtPrice(t.intradayPrice)}` : ''}`,
    budgetHtml: renderTierBudget(t, plan, maskMoney, maskMoneyText),
    statusText: t.pendingClose
      ? (t.equityMarket ? '正股已触价 · 期权待确认' : '触价 · 等待收盘数据或有效现价')
      : statusLabel(t.status),
    planLabel: plan ? planLabel(plan, evaluation.value) : '',
    execVisible: canP('tier-exec', 'edit') && (!!plan
      || (t.pendingClose && t.equityMarket && !evaluation.value.sameDaySkip?.includes(t.id) && canStockP('dip-spend', 'edit'))),
    execText: plan ? '成交/计划' : '建立正股计划'
  };
}));

const lots = computed(() => (evaluation.value.lots || state.lots || []).map((lot: any) => {
  const qty = Number(lot.qty);
  const cost = Number(lot.cost);
  const mark = Number(lot.mark);
  const hasQty = Number.isFinite(qty) && qty > 0;
  const hasPnl = hasQty && Number.isFinite(cost) && cost > 0 && lot.mark != null && Number.isFinite(mark) && mark > 0;
  const pnl = (mark - cost) * qty * (lot.type === 'call' ? 100 : 1);
  const unit = lot.type === 'call' ? '张' : /^\d{6}$/.test(lot.symbol || '') ? '份' : '股';
  return {
    ...lot,
    typeLabel: lot.type === 'call' ? 'Call' : '正股',
    qtyText: hasQty ? maskMoney(`${qty.toLocaleString('zh-CN', { maximumFractionDigits: 8 })} ${unit}`) : '—',
    costText: maskMoney((lot.currency === 'CNY' ? '¥' : '$') + fmtPrice(lot.cost)),
    markText: lot.mark != null ? maskMoney((lot.currency === 'CNY' ? '¥' : '$') + fmtPrice(lot.mark)) : '—',
    pnlText: hasPnl ? maskMoney(`${pnl > 0 ? '+' : ''}${lot.currency === 'CNY' ? fmtCny(pnl) : fmtUsd(pnl)} (${fmtPct((mark / cost - 1) * 100)})`) : '—',
    pnlClass: hasPnl && canViewLotMoney.value ? pctClass(pnl) : '',
    multiple: lot.multiple != null ? lot.multiple.toFixed(2) + '×' : '—',
    alerts: (lot.alerts || []).map((a: any) => a.action).join('；') || '—',
    canDelete: canP('lots-edit', 'edit')
  };
}));

const canViewActions = computed(() => canP('actions') || canP('actions-note', 'edit'));

function applyState(data: any) {
  if (data.cash) state.cash = data.cash;
  if (data.settings) state.settings = data.settings;
  if (data.notify) state.notify = data.notify;
  if (data.evaluation) state.evaluation = data.evaluation;
  if (data.monitor) state.monitor = data.monitor;
  if (data.lots) state.lots = data.lots;
  if (actionHistory && canViewActions.value) {
    if (data.actions) actionHistory.acceptSnapshot(data.actions);
    if (ready.value) actionHistory.render();
  }
}

function guardEdit(feature: string, action = 'edit') {
  if (!canP(feature, action)) { toast('error', '无权执行此操作'); return false; }
  return true;
}

async function refreshQuotes() {
  if (!guardEdit('refresh')) return;
  try {
    const data = await api('/quotes/refresh', { method: 'POST' });
    applyState({ evaluation: data.evaluation, monitor: data.monitor });
    toast('success', '已刷新');
  } catch (error: any) { toast('error', error.message); }
}

async function toggleMonitor() {
  if (!guardEdit('monitor-control')) return;
  try {
    const data = await api(running.value ? '/monitor/stop' : '/monitor/start', { method: 'POST' });
    state.monitor = data.monitor;
  } catch (error: any) { toast('error', error.message); }
}

async function saveSettings() {
  if (!canP('settings', 'edit')) { toast('error', '无权修改规则开关'); return; }
  try {
    const data = await api('/settings', {
      method: 'PUT', body: {
        variant: state.settings.variant === 'vBoost' ? 'vBoost' : 'default',
        soxlEnabled: !!state.settings.soxlEnabled,
        showSpy: state.settings.showSpy !== false
      }
    });
    applyState(data);
    toast('success', '规则已更新');
  } catch (error: any) { toast('error', error.message); }
}

async function saveFx(event: any) {
  if (!canViewLotMoney.value) { toast('error', '无权查看弹药现金'); return; }
  if (!canP('cash', 'edit')) { toast('error', '无权修改弹药现金'); return; }
  fxSaving.value = true;
  try {
    const data = await api('/cash', { method: 'PUT', body: { usdCnyRate: Number(event.target.value) } });
    applyState(data);
    toast('success', '汇率已保存，专用现金由资金池同步');
  } catch (error: any) { toast('error', error.message); }
  finally { fxSaving.value = false; }
}

async function refreshFx() {
  if (!canViewLotMoney.value || !canP('cash', 'edit')) { toast('error', '无权修改弹药现金'); return; }
  try {
    const fx = await api('/fx');
    const data = await api('/cash', {
      method: 'PUT',
      body: { usdCnyRate: fx.rate, fxSource: fx.source, fxUpdatedAt: new Date().toISOString() }
    });
    applyState(data);
    toast('success', `汇率已更新 ${fx.rate}（${fx.source || '自动'}）`);
  } catch (error: any) { toast('error', error.message); }
}

function openBuyPreview() {
  if (!guardEdit('buy-preview', 'view')) return;
  if (!canViewLotMoney.value) { toast('error', '无权查看仓位金额'); return; }
  if (!preview.value?.available) { toast('error', preview.value?.reason || '当前无法预览买入'); return; }
  previewOpen.value = true;
}
const previewSummary = computed(() => {
  const p = preview.value;
  if (!p) return '';
  return [
    p.title,
    p.savedRemainder ? `未用余额 ${fmtUsd(p.savedRemainder.remainingUsd)} / ${fmtCny(p.savedRemainder.remainingCny)}` : `预算 ${fmtUsd(p.totalUsd)}`,
    `USD ${fmtUsd(p.cashPlan?.useUsd ?? 0)} / CNY ${fmtCny(p.cashPlan?.useCny || 0)}`,
    `QQQ ${p.spot?.toFixed(3) ?? '—'}`,
    p.pendingClose ? (p.equityMarket ? '正股已触价 · 期权待收盘确认' : '等待收盘数据或有效现价') : null
  ].filter(Boolean).join(' · ');
});
const previewLegsHtml = computed(() => (preview.value?.legs || []).map(legRowHtml).join(''));
const previewExec = computed(() => canP('tier-exec', 'edit') && (evaluation.value.round?.executionPlans?.[preview.value?.tier]
  || (preview.value?.pendingClose && preview.value?.equityMarket && canStockP('dip-spend', 'edit'))));
const previewExecLabel = computed(() => evaluation.value.round?.executionPlans?.[preview.value?.tier] ? '查看成交计划' : '建立正股计划');

async function copyBuyList() {
  const p = preview.value;
  if (!p) return;
  const summary = previewSummary.value;
  const lines = [
    summary, '',
    ...(p.legs || []).map((leg: any) => {
      if (leg.kind === 'equity') {
        if (leg.currency === 'CNY') return `${leg.symbol} 正股·CNY 买入 ${leg.shares}股 预算${fmtCny(leg.cny)}≈${fmtUsd(leg.usd)} @${leg.price?.toFixed(3)}`;
        return `${leg.symbol} 正股·USD 买入 ${leg.shares}股 预算${fmtUsd(leg.usd)} @${leg.price?.toFixed(3)}`;
      }
      if (leg.skipped) {
        const ref = leg.referenceContract;
        return `Call 跳过：${leg.reason}；保留预算${fmtUsd(leg.usd)}${ref ? `；参考 ${ref.ticker}，卖价 ${fmtUsd(ref.ask)}，一张 ${fmtUsd(leg.minimumCost)}` : ''}`;
      }
      return `${leg.occSymbol || leg.symbol} Call·USD 买入 ${leg.shares}张 卖价${fmtPrice(leg.price)} 一张${fmtUsd(leg.oneContractCost)}（手续费另计） 预算${fmtUsd(leg.usd)} K${fmtPrice(leg.strike)} 到期${leg.expiry}`;
    }), '',
    '核对:', ...(p.checklist || [])
  ];
  try {
    await navigator.clipboard.writeText(lines.join('\n'));
    toast('success', '已复制买入清单');
  } catch { toast('error', '复制失败'); }
}

function toDatetimeLocal(date = new Date()) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

async function openExecModal(tierId: string) {
  if (!guardEdit('tier-exec')) return;
  if (!evaluation.value.round?.executionPlans?.[tierId]) {
    try {
      const data = await api('/actions', { method: 'POST', body: { type: 'execute', operation: 'create', tier: tierId } });
      applyState(data);
    } catch (error: any) { toast('error', error.message); return; }
  }
  const plan = evaluation.value.round?.executionPlans?.[tierId];
  if (plan && !plan.cancelled && !plan.inFlight && canStockP('dip-spend', 'edit')
    && plan.legs.some((leg: any) => leg.currency === 'CNY' && !leg.complete && leg.cny > (leg.spent || 0))) {
    try {
      const data = await api('/actions', { method: 'POST', body: { type: 'execute', operation: 'sync-cny', tier: tierId, planId: plan.id } });
      applyState(data);
    } catch (error: any) { toast('error', `计划同步失败：${error.message}`); return; }
  }
  openPlanFill(tierId);
}

function openPlanFill(tierId: string) {
  const plan = evaluation.value.round?.executionPlans?.[tierId];
  if (!plan) { toast('error', '当前没有成交计划，请核对最新行情和市场状态'); return; }
  const tier = (evaluation.value.tiers || []).find((row: any) => row.id === tierId);
  const waitingClose = tier?.pendingClose || evaluation.value.closeDataPending;
  const requestId = crypto.randomUUID();
  exec.value = {
    tierId, plan, tier, waitingClose, requestId,
    time: toDatetimeLocal(),
    accountId: '',
    review: false,
    status: '正在获取各腿最新报价并估算数量；预填值不是实际成交，请核对后手动修改。本次仅登记所选资金池同币种的交易腿。',
    rows: plan.legs.filter((leg: any) => !leg.routingReplaced || leg.spent > 0).map((leg: any) => ({
      id: leg.id, leg, currency: leg.currency,
      disabled: leg.complete || leg.pendingOption || plan.cancelled
        || (waitingClose && (leg.kind === 'call' || tier?.equityMarket !== (leg.currency === 'CNY' ? 'CN' : 'US'))),
      qty: '', price: '', fee: 0, complete: false, dirty: false,
      quoteInfo: leg.pendingOption ? `期权待用预算 ${maskMoney(fmtUsd(leg.usd))}。有有效报价且不足一张时，可顺延到同袋后续符合条件的同类期权。` : ''
    }))
  };
  execOpen.value = true;
  void loadExecDefaults();
}

function recalcRow(row: any) {
  if (row.disabled) return;
  const leg = row.leg;
  const price = Number(row.price);
  const fee = Number(row.fee || 0);
  const budget = Math.max(0, Number(leg.currency === 'CNY' ? leg.cny : leg.usd) - Number(leg.spent || 0) - fee);
  const lot = ['159509', '513850', '161128'].includes(leg.symbol) ? 100 : 1;
  const multiplier = leg.kind === 'call' ? 100 : 1;
  row.qty = price > 0 ? Math.max(0, Math.floor(budget / (price * multiplier * lot) + 1e-10) * lot) : '';
}

async function loadExecDefaults() {
  const current = exec.value;
  if (!current) return;
  try {
    const data = await api(`/execution-plans/${encodeURIComponent(current.tierId)}/defaults`);
    if (!exec.value || exec.value !== current || data.planId !== current.plan.id) return;
    for (const quote of data.legs || []) {
      const row = current.rows.find((item: any) => item.id === quote.legId);
      if (!row || row.disabled) continue;
      row.quoteInfo = quote.error || `${quote.warning || ''}${quote.oneContractCost != null ? ` 一张成本 ${fmtUsd(quote.oneContractCost)}（报价 × 100，手续费另计）。` : ''}来源 ${quote.source}；报价时间 ${formatDateTime(quote.asOf, '接口未提供')}；获取时间 ${formatDateTime(quote.fetchedAt)}。休市或延迟报价仅供估算；数量按剩余预算计算，不含后续费用。`;
      if (!quote.error && !row.dirty) row.price = quote.price;
      if (!quote.error) recalcRow(row);
    }
    current.status = '报价加载完成，预填仅供估算，可手动修改。登记前须复核真实成交；本次只提交所选资金池同币种交易腿。';
  } catch (error: any) {
    if (exec.value === current) current.status = `报价预填失败：${error.message}。可手动填写。`;
  }
}

async function submitExec() {
  const current = exec.value;
  if (!current) return;
  try {
    const fund = (state.cash?.strategyFunds || []).find((item: any) => item.accountId === current.accountId);
    if (!fund) throw new Error('请选择本次成交所属抄底资金池');
    const fills = current.rows.filter((row: any) => !row.disabled && row.currency === fund.currency && Number(row.qty) > 0)
      .map((row: any) => ({
        legId: row.id, shares: Number(row.qty), price: Number(row.price),
        commission: Number(row.fee), complete: row.complete
      }));
    const date = new Date(current.time);
    if (!Number.isFinite(date.getTime())) throw new Error('请填写实际成交时间');
    const data = await api('/actions', {
      method: 'POST',
      body: {
        type: 'execute', tier: current.tierId, planId: current.plan.id, requestId: current.requestId,
        fills, accountId: current.accountId, reviewed: current.review, filledAt: date.toISOString(),
        message: `登记 ${current.tierId} 分腿实际成交`
      }
    });
    execOpen.value = false;
    exec.value = null;
    applyState(data);
    if (canViewActions.value) await actionHistory?.load();
  } catch (error: any) { toast('error', error.message); }
}

async function cancelPlan() {
  const current = exec.value;
  if (!current) return;
  try {
    const data = await api('/actions', { method: 'POST', body: { type: 'execute', operation: 'cancel', tier: current.tierId, planId: current.plan.id } });
    execOpen.value = false; exec.value = null;
    applyState(data);
  } catch (error: any) { toast('error', error.message); }
}

async function refreshCnyPlan() {
  const current = exec.value;
  if (!current) return;
  try {
    const data = await api('/actions', { method: 'POST', body: { type: 'execute', operation: 'refresh-cny', tier: current.tierId, planId: current.plan.id } });
    applyState(data);
    openPlanFill(current.tierId);
  } catch (error: any) { toast('error', error.message); }
}

function openNoteModal() {
  if (!guardEdit('actions-note')) return;
  Object.assign(noteForm, { type: 'note', message: '', symbol: '', shares: '', price: '', currency: 'USD' });
  noteOpen.value = true;
}

async function submitNote() {
  try {
    const type = noteForm.type;
    const body: any = { type, message: noteForm.message };
    if (type === 'sell') {
      body.symbol = noteForm.symbol;
      body.shares = Number(noteForm.shares) || 0;
      body.price = Number(noteForm.price) || 0;
      body.currency = noteForm.currency;
      body.note = body.message;
      if (!body.symbol || !(body.shares > 0) || !(body.price > 0)) throw new Error('卖出需填写代码、数量与价格');
      body.message = body.message || `卖出 ${body.symbol} × ${body.shares} @ ${fmtPrice(body.price)}`;
    }
    const data = await api('/actions', { method: 'POST', body });
    noteOpen.value = false;
    applyState(data);
    if (canViewActions.value) await actionHistory?.load();
    toast('success', type === 'sell' ? '已同步卖出到持仓' : '已保存');
  } catch (err: any) { toast('error', err.message); }
}

async function submitLot() {
  try {
    const data = await api('/lots', {
      method: 'POST',
      body: {
        symbol: lotForm.symbol.trim().toUpperCase(),
        type: lotForm.type,
        cost: Number(lotForm.cost),
        qty: Number(lotForm.qty) || 1,
        tier: lotForm.tier,
        otmClass: lotForm.otmClass || (lotForm.type === 'call' ? 'medium' : 'equity'),
        strike: Number(lotForm.strike) || undefined,
        expiry: lotForm.expiry || undefined,
        openedAt: new Date().toISOString()
      }
    });
    lotOpen.value = false;
    applyState(data);
  } catch (err: any) { toast('error', err.message); }
}

function openLotModal() {
  if (!guardEdit('lots-edit')) return;
  Object.assign(lotForm, { symbol: '', type: 'equity', cost: '', qty: 1, tier: '', otmClass: '', strike: '', expiry: '' });
  lotOpen.value = true;
}

async function deleteLot(id: string) {
  if (!guardEdit('lots-edit')) return;
  try {
    const data = await api('/lots/' + id, { method: 'DELETE' });
    applyState(data);
  } catch (err: any) { toast('error', err.message); }
}

async function openDoc(id: string) {
  if (!canP('docs')) { toast('error', '无权查看手册'); return; }
  docOpen.value = true;
  docId.value = id;
  docWide.value = sessionStorage.getItem('qqq-dip-doc-wide-v2') !== '0';
  docTitle.value = '加载中…';
  docHtml.value = '<p class="hint">加载中…</p>';
  docToc.value = [];
  docLoading.value = true;
  try {
    const data = await api(`/docs/${id}`);
    const doc = data.doc;
    docTitle.value = doc.version ? `${doc.title}（${doc.version}）` : doc.title;
    docHtml.value = doc.html;
    docLoading.value = false;
    await nextTick();
    buildDocToc();
  } catch (e: any) {
    docTitle.value = '加载失败';
    docHtml.value = `<p class="hint sm-error">${escapeHtml(e.message)}</p>`;
    docLoading.value = false;
  }
}

function buildDocToc() {
  const body = docBodyEl.value;
  if (!body) return;
  const used = new Set<string>();
  const toc: any[] = [];
  body.querySelectorAll('h1,h2,h3,h4').forEach((h, i) => {
    let id = h.id;
    if (!id) {
      const slug = String(h.textContent || '').trim().replace(/\s+/g, '-').replace(/[^\w\u4e00-\u9fff-]+/g, '').slice(0, 48) || `section-${i}`;
      let candidate = slug;
      let n = 0;
      while (used.has(candidate)) candidate = `${slug}-${++n}`;
      used.add(candidate);
      id = candidate;
      h.id = id;
    } else used.add(id);
    toc.push({ id, text: (h.textContent || '').trim(), level: Number(h.tagName.slice(1)) });
  });
  docToc.value = toc;
  body.querySelectorAll('a[href^="doc:"]').forEach((a: any) => {
    a.addEventListener('click', (event) => {
      event.preventDefault();
      void openDoc(a.getAttribute('href').slice(4));
    });
  });
  body.addEventListener('scroll', () => {
    for (const item of toc) {
      const target = body.querySelector(`#${CSS.escape(item.id)}`) as HTMLElement | null;
      if (!target) continue;
      if (target.offsetTop - body.scrollTop <= 80) docActive.value = item.id;
    }
  }, { passive: true });
}

function scrollDoc(id: string) {
  const body = docBodyEl.value;
  const target = body?.querySelector(`#${CSS.escape(id)}`) as HTMLElement | null;
  target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function toggleDocWide() {
  docWide.value = !docWide.value;
  sessionStorage.setItem('qqq-dip-doc-wide-v2', docWide.value ? '1' : '0');
}

function currentTab() {
  const q = new URLSearchParams(location.search).get('tab');
  return q === 'qq' ? 'qq' : 'monitor';
}

function enforceTabs() {
  const tab = currentTab();
  if (!showMonitor.value && !showQq.value) {
    noAccess.value = true;
    monitorError.value = '无权访问抄底监控，请联系管理员在权限管理中分配 Tab 权限。';
    return false;
  }
  if (tab === 'qq' || (!showMonitor.value && showQq.value)) {
    location.replace('/notifications/#business-stock');
    return false;
  }
  state.tab = 'monitor';
  document.title = '抄底监控';
  return true;
}

onMounted(async () => {
  await loadPortalContext();
  ctxTick.value++;
  if (!enforceTabs()) { ready.value = true; window.navigationSkeleton?.finish?.(); return; }
  actionHistory = createActionHistory(document, {
    api, escapeHtml, formatDateTime, sentimentReading,
    onError: (error: any) => toast('error', error.message)
  });
  await nextTick();
  if (canViewActions.value) actionHistory.bind();
  try {
    applyState(await api('/state'));
  } catch (e: any) {
    monitorError.value = e.message;
  }
  ready.value = true;
  if (canViewActions.value) actionHistory.render();
  connectSse();
  window.navigationSkeleton?.finish?.();
});

function connectSse() {
  try {
    events = new EventSource('./api/events');
    events.addEventListener('state', (ev) => { try { applyState(JSON.parse((ev as MessageEvent).data)); } catch { /* ignore */ } });
    events.addEventListener('cash', (ev) => { try { applyState(JSON.parse((ev as MessageEvent).data)); } catch { /* retry */ } });
  } catch { /* ignore */ }
}

onUnmounted(() => { events?.close(); events = null; });

function toggleSetting(key: string, event: any) {
  if (!canP('settings', 'edit')) { event.target.checked = !event.target.checked; toast('error', '无权修改规则开关'); return; }
  state.settings = { ...state.settings, [key]: event.target.checked };
  void saveSettings();
}
</script>

<template>
  <nav class="sm-feature-tabs" id="feature-tabs" aria-label="股票功能">
    <a class="sm-feature-tab" href="/stock-manage/">持仓</a>
    <a v-if="showMonitor" class="sm-feature-tab active" href="/stock-manage/dip/">抄底监控</a>
    <a v-if="canP('tab-quant')" class="sm-feature-tab" href="/stock-manage/quant/">量化分析</a>
  </nav>

  <section v-if="noAccess" class="sm-panel">
    <p class="hint sm-error" id="error-line">无权访问抄底监控，请联系管理员在权限管理中分配 Tab 权限。</p>
  </section>

  <section v-else id="panel-monitor">
    <div class="sm-panel-head">
      <h2>抄底监控</h2>
      <div class="sm-panel-head-actions">
        <button v-if="canP('docs')" type="button" class="btn ghost sm-btn-sm" data-doc="cheatsheet" @click="openDoc('cheatsheet')">手册速查</button>
        <button v-if="canP('docs')" type="button" class="btn ghost sm-btn-sm" data-doc="manual" @click="openDoc('manual')">操作手册</button>
        <span class="sm-market-pill" :class="{ open: !!market.rth }">{{ marketLabel }}</span>
        <button v-if="canP('refresh', 'edit')" type="button" class="btn ghost sm-btn-sm" @click="refreshQuotes">刷新行情</button>
        <button v-if="canP('monitor-control', 'edit')" type="button" class="btn primary sm-btn-sm" @click="toggleMonitor">{{ running ? '停止监听' : '开始监听' }}</button>
      </div>
    </div>
    <p class="hint" id="monitor-hint">{{ monitorHint }}</p>
    <p v-if="errorLine" class="hint sm-error" id="error-line">{{ errorLine }}</p>

    <div class="sm-dashboard" id="ammo-cards">
      <div class="sm-summary-card"><div class="label">抄底美元现金</div>
        <input v-if="showMoney" type="number" readonly id="cash-usd" :value="cashView.strategyCashUsd ?? 0" aria-label="抄底美元现金">
        <div v-else class="value sm-mask">••••••</div>
        <div class="hint">专用资金池可用余额，约2秒同步</div>
      </div>
      <div class="sm-summary-card"><div class="label">抄底人民币现金</div>
        <input v-if="showMoney" type="number" readonly id="cash-cny" :value="cashView.strategyCashCny ?? 0" aria-label="抄底人民币现金">
        <div v-else class="value sm-mask">••••••</div>
        <div class="hint">专用资金池可用余额，账户管理中划拨／释放</div>
      </div>
      <div class="sm-summary-card"><div class="label">USD/CNY 汇率</div>
        <input type="number" step="0.0001" id="cash-fx" :value="cashView.usdCnyRate ?? 7.2"
               :readonly="!showMoney || !canP('cash', 'edit')" @change="saveFx">
        <div class="hint" id="fx-hint">{{ fmtFxHint(cashView) }}</div>
        <button v-if="showMoney && canP('cash', 'edit')" type="button" class="btn link" id="btn-fx" @click="refreshFx">立即刷新汇率</button>
      </div>
      <div class="sm-summary-card"><div class="label">本轮预算 B₀</div><div class="value" v-html="maskMoney(fmtUsd(evaluation.B ?? 0))"></div>
        <div class="hint">{{ evaluation.budgetLocked ? '已触发／已有计划，预算已锁定' : '尚未触发，预算随专用资金更新' }}</div>
        <div class="hint">专用可用：{{ maskMoneyText(fmtUsd(cashView.strategyCashUsd ?? 0)) }} / {{ maskMoneyText(fmtCny(cashView.strategyCashCny ?? 0)) }}；账户管理中划拨，不重复增加资产</div>
        <div v-if="(cashView.strategyFunds || []).some((f) => f.deficit > 0)" class="hint">存在策略资金缺口：受影响账户暂停执行，请核对外部成交或释放预留。</div>
        <div class="hint">{{ state.settings.variant === 'vBoost' ? 'V 型加强 55/20/25' : '默认 40/30/30' }}</div>
      </div>
      <div class="sm-summary-card"><div class="label">实际专用可用（美元等价）</div><div class="value" v-html="maskMoney(fmtUsd(evaluation.availableCash))"></div>
        <div class="hint">总预算余额 {{ maskMoneyText(fmtUsd(evaluation.budgetRemaining)) }} · 资金缺口 {{ maskMoneyText(fmtUsd(evaluation.fundingGap)) }}</div>
        <div class="hint">预算额度不等于现金；各袋不各自占有一份可用余额</div>
      </div>
      <div class="sm-summary-card"><div class="label">左侧预算余额</div><div class="value" v-html="maskMoney(fmtUsd(evaluation.remaining?.left))"></div>
        <div class="hint">预算上限 {{ maskMoneyText(fmtUsd(evaluation.bags?.left)) }}，非独立现金</div>
      </div>
      <div class="sm-summary-card"><div class="label">危机预算余额</div><div class="value" v-html="maskMoney(fmtUsd(evaluation.remaining?.crisis))"></div>
        <div class="hint">预算上限 {{ maskMoneyText(fmtUsd(evaluation.bags?.crisis)) }}，非独立现金</div>
      </div>
      <div class="sm-summary-card"><div class="label">右侧预算余额</div><div class="value" v-html="maskMoney(fmtUsd(evaluation.remaining?.right))"></div>
        <div class="hint">预算上限 {{ maskMoneyText(fmtUsd(evaluation.bags?.right)) }}，非独立现金</div>
      </div>
      <div class="sm-summary-card"><div class="label">VXN</div>
        <div class="value">{{ evaluation.vxnStale && Number(evaluation.vxnQuote?.price) > 0 ? Number(evaluation.vxnQuote.price).toFixed(2) : evaluation.vxn != null ? evaluation.vxn.toFixed(2) : '—' }}</div>
        <div v-if="evaluation.vxnStale" class="hint">最新收盘值待更新 · 旧值仅供参考</div>
        <div class="hint">{{ vxnHint }}</div>
      </div>
      <div class="sm-summary-card" id="market-sentiment-card"><div class="label">恐惧与贪婪指数</div>
        <div class="value">{{ evaluation.sentiment ? sentimentReading(evaluation.sentiment) : '—' }}</div>
        <div class="hint">{{ evaluation.sentiment ? `${evaluation.sentiment.asOf} · CNN 公开归档${evaluation.sentiment.stale ? ' · 数据待更新' : ''}` : '暂无可用数据' }}</div>
        <div class="hint">{{ Number.isFinite(evaluation.sentiment?.change5) ? `较 5 期前 ${evaluation.sentiment.change5 > 0 ? '+' : ''}${evaluation.sentiment.change5.toFixed(1)} 点 · ` : '' }}仅供观察</div>
      </div>
      <div class="sm-summary-card"><div class="label">规则</div>
        <label class="hint"><input type="checkbox" id="opt-vboost" :checked="state.settings.variant === 'vBoost'" :disabled="!canP('settings', 'edit')" @change="toggleSetting('variant', { target: { checked: $event.target.checked ? 'vBoost' : 'default' } })"> V 型加强 55/20/25</label>
        <label class="hint"><input type="checkbox" id="opt-soxl" :checked="!!state.settings.soxlEnabled" :disabled="!canP('settings', 'edit')" @change="toggleSetting('soxlEnabled', $event)"> 启用 SOXL 芯片观点（−70%／−90%）</label>
        <label class="hint"><input type="checkbox" id="opt-spy" :checked="state.settings.showSpy !== false" :disabled="!canP('settings', 'edit')" @change="toggleSetting('showSpy', $event)"> 显示 SPY</label>
      </div>
    </div>

    <section class="sm-panel">
      <div class="sm-panel-head">
        <h2>当前推荐</h2>
        <div class="sm-panel-head-actions" id="primary-actions">
          <button v-if="preview?.available && canP('buy-preview') && canViewLotMoney" type="button" class="btn primary sm-btn-sm" @click="openBuyPreview">预览买入</button>
        </div>
      </div>
      <div id="primary-rec" class="sm-rec">
        <p v-if="!primary" class="hint">暂无推荐。配置 API Key 后刷新行情。</p>
        <template v-else>
          <h3>{{ primary.title }}</h3>
          <p>{{ primary.body }}</p>
          <p v-if="previewHint" class="hint">{{ previewHint }}</p>
          <ul v-if="prohibitions.length"><li v-for="x in prohibitions" :key="x">{{ x }}</li></ul>
        </template>
      </div>
    </section>

    <section class="sm-panel">
      <div class="sm-panel-head"><h2>标的与档位</h2></div>
      <div class="sm-table-wrap">
        <table class="sm-table" id="symbol-table">
          <thead><tr><th>代码</th><th>现价</th><th>当日涨跌幅</th><th>相对 H 回撤</th><th>H / 下一档（规则）</th></tr></thead>
          <tbody>
            <tr v-for="row in symbolRows" :key="row.label">
              <td>{{ row.label }}</td>
              <td>{{ row.price }}</td>
              <td :class="row.changeClass">{{ row.changePct }}</td>
              <td :class="row.drawClass">{{ row.drawdown }}</td>
              <td>{{ row.hint }}<div v-if="row.premium" class="hint">{{ row.premium }}</div></td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="sm-table-wrap" style="margin-top:16px">
        <table class="sm-table" id="tier-table">
          <thead><tr><th>档</th><th>袋</th><th>触发条件</th><th>触发价</th><th>占 B</th><th>金额</th><th>状态</th><th>操作说明</th><th></th></tr></thead>
          <tbody>
            <tr v-for="t in tiers" :key="t.id" :class="'tier-row st-row-' + (t.status || '')">
              <td><strong>{{ t.id }}</strong></td>
              <td>{{ t.bag }}</td>
              <td class="tier-cond" :title="t.cond">{{ t.cond }}</td>
              <td>{{ t.price }}</td>
              <td>{{ t.pctB }}%</td>
              <td v-html="t.budgetHtml"></td>
              <td :class="'st-' + t.status">{{ t.statusText }}<div v-if="t.planLabel" class="hint">{{ t.planLabel }}</div></td>
              <td class="tier-action" :title="t.action">{{ t.action }}</td>
              <td><button v-if="t.execVisible" class="btn link" @click="openExecModal(t.id)">{{ t.execText }}</button></td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="hint" id="leap-hint">{{ leapHint }}</p>
    </section>

    <section class="sm-panel">
      <div class="sm-panel-head">
        <h2>抄底仓位（止盈）</h2>
        <button v-if="canP('lots-edit', 'edit')" type="button" class="btn ghost sm-btn-sm" @click="openLotModal">登记仓位</button>
      </div>
      <div class="sm-table-wrap">
        <table class="sm-table" id="lot-table">
          <thead><tr><th>标的</th><th>类型</th><th>剩余数量</th><th>成本</th><th>现价</th><th>浮动盈亏（未扣费）</th><th>倍数</th><th>止盈</th><th></th></tr></thead>
          <tbody>
            <tr v-for="lot in lots" :key="lot.id">
              <td>{{ lot.symbol || '' }}</td>
              <td>{{ lot.typeLabel }}</td>
              <td v-html="lot.qtyText"></td>
              <td v-html="lot.costText"></td>
              <td v-html="lot.markText"></td>
              <td :class="lot.pnlClass" v-html="lot.pnlText"></td>
              <td>{{ lot.multiple }}</td>
              <td>{{ lot.alerts }}</td>
              <td><button v-if="lot.canDelete" class="btn link danger" @click="deleteLot(lot.id)">删除</button></td>
            </tr>
            <tr v-if="!lots.length"><td colspan="9" class="hint">还没有登记抄底仓位</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <section v-if="canViewActions" class="sm-panel">
      <div class="sm-panel-head">
        <h2>操作记录</h2>
        <div class="sm-panel-head-actions">
          <select id="action-filter">
            <option value="all">全部</option>
            <option value="auto">自动</option>
            <option value="user">手动</option>
          </select>
          <button v-if="canP('actions-note', 'edit')" type="button" class="btn ghost sm-btn-sm" @click="openNoteModal">记一笔</button>
        </div>
      </div>
      <div id="action-list" class="sm-action-list"></div>
      <div class="sm-pagination" id="action-pagination">
        <span class="hint" id="action-page-info">第 1 / 1 页 · 共 0 条</span>
        <div class="sm-pagination-actions">
          <button type="button" class="btn ghost sm-btn-sm" id="action-prev">上一页</button>
          <button type="button" class="btn ghost sm-btn-sm" id="action-next">下一页</button>
          <select id="action-page-size" aria-label="操作记录每页条数">
            <option value="10">10 条/页</option><option value="20" selected>20 条/页</option><option value="50">50 条/页</option><option value="100">100 条/页</option>
          </select>
        </div>
      </div>
    </section>
  </section>

  <div v-if="previewOpen && preview" class="sm-modal-backdrop sm-modal-backdrop--buy" @click.self="previewOpen = false">
    <div class="sm-modal sm-modal--buy" role="dialog" aria-modal="true">
      <h3>{{ previewSummary }}</h3>
      <p class="hint">{{ preview.recommendation || '' }}</p>
      <ul v-if="preview.notes?.length" class="sm-buy-notes"><li v-for="n in preview.notes" :key="n">{{ n }}</li></ul>
      <div class="sm-table-wrap">
        <table class="sm-table sm-buy-table">
          <thead><tr><th>类型</th><th>标的</th><th>方向</th><th>占比</th><th>预算</th><th>数量/合约</th><th>参考</th><th>说明</th></tr></thead>
          <tbody v-html="previewLegsHtml"></tbody>
        </table>
      </div>
      <template v-if="preview.checklist?.length"><h4>下单前核对</h4><ul class="sm-buy-checklist"><li v-for="n in preview.checklist" :key="n">{{ n }}</li></ul></template>
      <template v-if="preview.prohibitions?.length"><h4>禁令</h4><ul><li v-for="n in preview.prohibitions" :key="n">{{ n }}</li></ul></template>
      <p class="hint">期权张数需按实际买卖价重算；有效期权链会填入 OCC 代码。Cboe 备用数据为延迟参考报价，下单前须复核券商实时卖价。标记已执行会按填写金额扣减美元/人民币现金。</p>
      <div class="sm-modal-actions">
        <button type="button" class="btn ghost" @click="copyBuyList">复制清单</button>
        <button v-if="previewExec" type="button" class="btn ghost" @click="previewOpen = false; openExecModal(preview.tier)">{{ previewExecLabel }}</button>
        <button type="button" class="btn primary" @click="previewOpen = false">关闭</button>
      </div>
    </div>
  </div>

  <div v-if="execOpen && exec" class="sm-modal-backdrop" @click.self="execOpen = false">
    <div class="sm-modal sm-modal--plan" role="dialog" aria-modal="true">
      <h3>{{ exec.tierId }} {{ exec.plan.intradayEquity ? '盘中正股计划与' : '分腿' }}实际成交登记</h3>
      <p class="hint">当前计划预算 {{ maskMoneyText(fmtUsd(exec.plan.totalUsd)) }}（含期权预算顺延调整）。</p>
      <p class="hint">{{ evaluation.cnMarket?.label || '等待A股交易时段' }}。这里只补记券商实际成交，不自动下单。未填写数量的交易腿保持待执行。</p>
      <p class="hint">不设固定截止时间；当前策略条件仍满足时可继续分批成交。仍须在对应市场交易时段登记真实成交；取消不撤销已成交持仓。</p>
      <p v-if="exec.waitingClose" class="hint">期权待收盘确认。盘中正股须在对应市场开盘、现价仍达标时登记；人民币标的须复核当前价格、参考溢价和停牌状态。已成交但超出策略条件的交易可在持仓页如实补记。</p>
      <p class="hint">{{ exec.status }}</p>
      <label class="field">实际成交时间（本机时区）<input v-model="exec.time" type="datetime-local" step="1"></label>
      <label class="field">本次成交所属抄底资金池<select v-model="exec.accountId"><option value="">请选择同币种证券账户</option>
        <option v-for="f in cashView.strategyFunds || []" :key="f.accountId" :value="f.accountId">{{ f.name }} · {{ f.currency }} · 策略可用 {{ maskMoneyText(String(f.strategyAvailable)) }} · 缺口 {{ maskMoneyText(String(f.deficit)) }}</option>
      </select></label>
      <fieldset v-for="row in exec.rows" :key="row.id" :data-fill-leg="row.id" :data-currency="row.currency" :disabled="row.disabled">
        <legend>{{ row.leg.occSymbol || row.leg.symbol }} · {{ row.leg.budgetCarryOut ? '已顺延' : row.leg.complete ? '已完成' : row.leg.spent > 0 ? '部分成交' : '待执行' }} · {{ row.currency }} 已用 {{ maskMoneyText(String(row.leg.spent)) }} · 按当前策略条件复核</legend>
        <p v-if="row.leg.budgetCarryOut" class="hint">已将 {{ maskMoneyText(fmtUsd(row.leg.budgetCarryOut.usd)) }} 顺延到 {{ row.leg.budgetCarryOut.tier }} 的同类期权。</p>
        <label class="field">本次实际数量（期权填张数）<input v-model="row.qty" type="number" min="0" :step="['159509', '513850', '161128'].includes(row.leg.symbol) ? '100' : '1'" @input="row.dirty = true"></label>
        <label class="field">实际成交单价<input v-model="row.price" type="number" min="0" step="0.001" @input="row.dirty = true; recalcRow(row)"></label>
        <label class="field">本次费用<input v-model="row.fee" type="number" min="0" step="0.01" @input="recalcRow(row)"></label>
        <p class="hint">{{ row.quoteInfo }}</p>
        <label><input v-model="row.complete" type="checkbox">此腿已全部完成（不再补单）</label>
      </fieldset>
      <p class="hint">打开计划时自动按25%/10%溢价规则同步未成交的人民币标的。行情或净值缺失时保留原计划及预算，等待有效数据。</p>
      <label><input v-model="exec.review" type="checkbox">已复核当前信号、人民币标的最新报价/停牌/参考溢价及真实成交；不使用昨夜估价</label>
      <div class="sm-modal-actions">
        <button class="btn ghost" @click="execOpen = false">关闭</button>
        <button class="btn ghost" @click="cancelPlan">取消剩余计划</button>
        <button v-if="canP('cny-routing', 'edit') && canStockP('dip-spend', 'edit')" class="btn ghost" @click="refreshCnyPlan">更新未成交人民币标的</button>
        <button v-if="canStockP('dip-spend', 'edit')" class="btn primary" @click="submitExec">登记本次成交</button>
      </div>
    </div>
  </div>

  <div v-if="noteOpen" class="sm-modal-backdrop" @click.self="noteOpen = false">
    <div class="sm-modal" role="dialog" aria-modal="true">
      <h3>手动记录</h3>
      <label class="field">类型
        <select v-model="noteForm.type">
          <option value="note">备注</option>
          <option v-if="canP('tier-exec', 'edit')" value="sell">卖出（同步持仓）</option>
        </select>
      </label>
      <label class="field">内容<textarea v-model="noteForm.message" rows="3"></textarea></label>
      <div v-if="noteForm.type === 'sell'" class="sm-grid">
        <label class="field">代码<input v-model="noteForm.symbol" placeholder="QQQ / 159509 / OCC"></label>
        <label class="field">数量<input v-model="noteForm.shares" type="number" step="1"></label>
        <label class="field">价格<input v-model="noteForm.price" type="number" step="0.001"></label>
        <label class="field">币种<select v-model="noteForm.currency"><option value="USD">USD</option><option value="CNY">CNY</option></select></label>
      </div>
      <div class="sm-modal-actions">
        <button class="btn ghost" @click="noteOpen = false">取消</button>
        <button class="btn primary" @click="submitNote">保存</button>
      </div>
    </div>
  </div>

  <div v-if="lotOpen" class="sm-modal-backdrop" @click.self="lotOpen = false">
    <div class="sm-modal" role="dialog" aria-modal="true">
      <h3>登记抄底仓位</h3>
      <div class="sm-grid">
        <label class="field">代码<input v-model="lotForm.symbol" placeholder="QQQ 或 QQQ270115C00700000"></label>
        <label class="field">类型<select v-model="lotForm.type"><option value="equity">正股</option><option value="call">Call</option></select></label>
        <label class="field">成本<input v-model="lotForm.cost" type="number" step="0.001"></label>
        <label class="field">数量<input v-model="lotForm.qty" type="number" step="1"></label>
        <label class="field">档位<input v-model="lotForm.tier" placeholder="T2"></label>
        <label class="field">虚值分类<select v-model="lotForm.otmClass"><option value="">正股</option><option value="medium">中虚值</option><option value="deep">深虚值</option><option value="shallow">浅虚值</option></select></label>
        <label class="field">行权价<input v-model="lotForm.strike" type="number" step="0.001"></label>
        <label class="field">到期<input v-model="lotForm.expiry" type="date"></label>
      </div>
      <div class="sm-modal-actions">
        <button class="btn ghost" @click="lotOpen = false">取消</button>
        <button class="btn primary" @click="submitLot">保存</button>
      </div>
    </div>
  </div>

  <div v-if="docOpen" class="sm-modal-backdrop" :class="{ 'sm-modal-backdrop--wide': docWide }" @click.self="docOpen = false">
    <div class="sm-modal sm-modal--doc" :class="{ 'sm-modal--doc-wide': docWide }" role="dialog" aria-modal="true">
      <div class="sm-doc-toolbar">
        <strong id="doc-title">{{ docTitle }}</strong>
        <div class="sm-doc-toolbar-actions">
          <button type="button" class="btn ghost sm-btn-sm" :class="{ active: docId === 'cheatsheet' }" @click="openDoc('cheatsheet')">速查</button>
          <button type="button" class="btn ghost sm-btn-sm" :class="{ active: docId === 'manual' }" @click="openDoc('manual')">完整手册</button>
          <button type="button" class="btn ghost sm-btn-sm" :aria-pressed="docWide" @click="toggleDocWide">{{ docWide ? '退出宽屏' : '宽屏' }}</button>
          <button type="button" class="btn ghost sm-btn-sm" @click="docOpen = false">关闭</button>
        </div>
      </div>
      <div class="sm-doc-layout">
        <aside v-if="docToc.length" class="sm-doc-toc">
          <div class="sm-doc-toc-title">目录</div>
          <nav class="sm-doc-toc-nav">
            <a v-for="item in docToc" :key="item.id" href="#" class="sm-doc-toc-item" :class="['sm-doc-toc-l' + item.level, { active: docActive === item.id }]" @click.prevent="scrollDoc(item.id)">{{ item.text }}</a>
          </nav>
        </aside>
        <div class="sm-doc-body sm-doc-content" ref="docBodyEl" v-html="docHtml"></div>
      </div>
    </div>
  </div>
</template>
