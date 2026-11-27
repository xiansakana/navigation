<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import {
  HOLDINGS_COLUMNS, LS_COL_VIS, LS_DASHBOARD, LS_FULL_WIDTH, LS_PNL_VISIBLE, LS_TABLE_SORT,
  colFeatureId, defaultColVis, defaultTableSort, loadJson, saveJson
} from '../../public/js/constants.js';
import { buildHoldingsGroups, effectiveGroupKey, isHoldingsSortable, sortMark, toggleTableSort } from '../../public/js/holdings-table.js';
import { disposePnlChart, renderPnlVisualization } from '../../public/js/pnl-viz.js';
import {
  can, canDip, getStockManagePrefs, isPortalMode, loadPortalContext, saveStockManagePrefs
} from '../../public/js/portal-auth.js';
import { openInvestmentAccounts } from '../../public/js/investment-accounts.js';
import {
  MASK, cls, escapeHtml, fmt, fmtCommission, fmtCny, fmtMoney, fmtMoneyPair, fmtMoneySigned, fmtPct,
  fmtUsd, fmtUsdSigned, localDateKey, pnlIso, pnlToday
} from './stock-format';
import { api, openModal, readProgressResponse } from './stock-modal';
import { openTradeModal, type StockTradeDeps } from './stock-trade';
import { openImportModal, type StockImportDeps } from './stock-import';
import { openTradeHistoryForRange, openTradeHistoryModal, type StockHistoryDeps } from './stock-history';
import { createHoldingsRenderer } from './stock-holdings-view';

const ctxTick = ref(0);
const canP = (feature: string, action = 'view') => { ctxTick.value; return can(feature, action); };
const canDipP = (feature: string, action = 'view') => { ctxTick.value; return canDip(feature, action); };

const data = ref<any>(null);
const state = computed(() => data.value || {});
const loading = ref(true);
const error = ref('');
const accountId = ref(new URLSearchParams(location.search).get('accountId') || '');
const dashboardVisible = ref(true);
const pnlVisible = ref(true);
const fullWidth = ref(false);
const tableSort = ref<any>(defaultTableSort());
const colVis = reactive<Record<string, boolean>>(defaultColVis() as any);
const colPanelOpen = ref(false);
const collapsed = reactive(new Set<string>());
const quotesBusy = ref(false);
const quoteVisible = ref(false);
const quoteMessage = ref('');
const quoteMax = ref(0);
const quoteValue = ref(0);
const pnlPeriod = ref<'week' | 'month' | 'year' | 'all' | 'range'>('all');
const pnlAnchor = ref(pnlToday());
const pnlCaption = ref('');
const pnlStart = ref('');
const pnlEnd = ref('');
const pnlVizMode = ref('line');
const pnlChartEl = ref<HTMLElement | null>(null);
let prefSaveTimer: any = null;
let portfolioLoadRevision = 0;
let quoteSyncBusy = false;
let dragSourceSymbol = '';

const showPnl = computed(() => { ctxTick.value; return can('pnl'); });
const showDashboardBlock = computed(() => { ctxTick.value; return can('dashboard') || can('pnl-toggle'); });
const showDashToggle = computed(() => { ctxTick.value; return can('dashboard'); });
const showPnlToggle = computed(() => { ctxTick.value; return can('pnl-toggle'); });
const showAccounts = computed(() => { ctxTick.value; return can('accounts'); });
const showTrades = computed(() => { ctxTick.value; return can('trades'); });
const showImport = computed(() => { ctxTick.value; return can('import', 'edit'); });
const showAdd = computed(() => { ctxTick.value; return can('trade', 'edit'); });
const showRefresh = computed(() => { ctxTick.value; return can('refresh', 'edit'); });
const showColumns = computed(() => { ctxTick.value; return can('columns'); });
const showQuantTab = computed(() => { ctxTick.value; return can('tab-quant'); });
const showDipTab = computed(() => { ctxTick.value; return canDip('tab-monitor'); });
const cashVisible = computed(() => { ctxTick.value; return can('cash') && state.value.cashVisible !== false; });
const cashEditable = computed(() => cashVisible.value && canP('cash', 'edit') && !state.value.accountCashEnabled);

function canCol(key: string) { return canP(colFeatureId(key)); }
const visibleCols = computed(() => {
  ctxTick.value;
  return HOLDINGS_COLUMNS.filter((c: any) => canCol(c.key));
});

const renderer = createHoldingsRenderer({
  getState: () => state.value,
  getColVis: () => colVis,
  isPnlVisible: () => pnlVisible.value,
  isQuotesBusy: () => quotesBusy.value,
  can: canP,
  canCol
});

const activeSort = computed(() => {
  const sort = tableSort.value;
  return isHoldingsSortable(sort?.key) && canCol(sort.key) && colVis[sort.key] !== false
    ? sort : canCol('weight') && colVis.weight !== false ? defaultTableSort() : { key: 'symbol', dir: 1 };
});

const funds = computed(() => (state.value.fundHoldings || []).map((fund: any, fundIndex: number) => ({
  ...fund, type: 'fund', fundIndex,
  avgCost: fund.cost / fund.shares, marketValueNative: fund.marketValue,
  marketValue: fund.marketValueUsd,
  pnlPct: fund.cost > 0 && fund.pnl != null ? fund.pnl / fund.cost * 100 : null
})));

const groups = computed(() => buildHoldingsGroups(
  [...(state.value.holdings || []), ...funds.value],
  activeSort.value.key, activeSort.value.dir, state.value
));

const cashPct = computed(() => {
  const summary = state.value.summary || {};
  const cashEq = Number.isFinite(summary.cashUsdEq) ? summary.cashUsdEq : state.value.cash;
  return summary.totalAssets > 0 ? (cashEq / summary.totalAssets * 100) : 0;
});

const dashboardCards = computed(() => {
  if (!dashboardVisible.value) return [];
  const s = state.value.summary || {};
  const rate = Number(state.value.usdCnyRate);
  const hkdRate = Number(state.value.usdHkdRate);
  const hasHkd = (state.value.investmentAccounts || []).some((a: any) =>
    a.currency === 'HKD' && (!accountId.value || a.id === accountId.value));
  const currencies = hasHkd ? ['USD', 'CNY', 'HKD'] : ['USD', 'CNY'];
  const currencyLabel: any = { USD: '美元', CNY: '人民币', HKD: '港币' };
  const cash = { USD: state.value.cashUsd, CNY: state.value.cashCny, HKD: state.value.cashHkd };
  const cashRatio = s.totalAssets > 0 && Number.isFinite(s.cashUsdEq) ? s.cashUsdEq / s.totalAssets * 100 : null;
  const missing = new Set(state.value.missingQuotes || []);
  const unpriced = [...(state.value.holdings || []), ...(state.value.fundHoldings || [])]
    .filter((h: any) => missing.has(h.tradeSymbol || h.symbol));
  const available = (values: any, holdings: any[]) => {
    const unavailable = new Set(holdings.map((h: any) => h.currency));
    return Object.fromEntries(Object.entries(values).map(([currency, amount]) => [currency, unavailable.has(currency) ? null : amount]));
  };
  const stock = available({ USD: s.stockMv, CNY: s.ashareMvNative, HKD: s.hkMv }, unpriced.filter((h: any) => h.type !== 'option'));
  const option = available({ USD: s.optionMv, CNY: 0, HKD: 0 }, unpriced.filter((h: any) => h.type === 'option'));
  const pnl = available({ USD: s.totalPnlUsd, CNY: s.totalPnlCny, HKD: s.totalPnlHkd }, unpriced);
  const daily = { USD: s.dailyTotalPnlUsd, CNY: s.dailyTotalPnlCny, HKD: s.dailyTotalPnlHkd };

  function convert(values: any, allowPartial = false) {
    if (!(rate > 0) || (!allowPartial && currencies.some((cur) => !Number.isFinite(values[cur])))
      || !currencies.some((cur) => Number.isFinite(values[cur]))) return {};
    const hkd = values.HKD || 0;
    if (hkd && !(hkdRate > 0)) return {};
    const usd = (values.USD || 0) + (hkd ? hkd / hkdRate : 0);
    const cny = values.CNY || 0;
    return { USD: usd + cny / rate, CNY: usd * rate + cny };
  }

  const quoteNotice = missing.size
    ? `缺少报价：${[...missing].map(escapeHtml).join('、')}。请刷新价格；报价补齐后恢复总资产。`
    : '';
  const dailyHint = !Object.values(daily).some(Number.isFinite)
    ? '刷新行情后显示持仓涨跌'
    : s.tradeDailyPnl ? `含今日交易净变动 ${fmtUsdSigned(s.tradeDailyPnl)}` : '持仓当日涨跌';
  const cashHint = rate > 0
    ? `美元兑人民币 ${rate.toFixed(4)}${hkdRate > 0 && hasHkd ? ` · 美元兑港币 ${hkdRate.toFixed(4)}` : ''}${cashRatio == null ? '' : ` · 占组合 ${fmtPct(cashRatio)}`}`
    : '';
  const fxNotice = hasHkd && !(hkdRate > 0) ? '缺少美元兑港币汇率，暂不能折算含港币的合计。' : '';

  function card(label: string, values: any, opts: any = {}) {
    const { total = convert(values), classes = '', signed = false, assets = false, editCash = false, notice = '', hint = '' } = opts;
    const format = signed ? fmtMoneySigned : fmtMoney;
    const hidden = !dashboardVisible.value || (signed && !pnlVisible.value);
    const mask = (html: string) => hidden ? MASK : html;
    const color = (amount: number) => signed && !hidden ? cls(amount) : '';
    const splits = currencies.map((currency) => {
      const name = currencyLabel[currency] + (assets ? '资产' : '');
      const value = values[currency];
      const editable = editCash && !hidden && currency !== 'HKD';
      return {
        name,
        editable,
        currency,
        raw: value ?? 0,
        cls: color(value as number),
        html: editable ? '' : mask(format(value as number, currency))
      };
    });
    return {
      key: label,
      label,
      classes,
      totalHtml: mask(fmtMoneyPair((total as any).USD, (total as any).CNY, format)),
      totalClass: color((total as any).USD),
      notice: notice && !hidden ? notice : '',
      hint: hint && !hidden ? hint : '',
      splits
    };
  }

  const cards: any[] = [];
  if (cashVisible.value) {
    cards.push(card('总资产', { USD: s.assetsUsd, CNY: s.assetsCny, HKD: s.assetsHkd }, {
      total: { USD: s.totalAssets, CNY: s.totalAssetsCny }, classes: 'sm-summary-card--accent', assets: true,
      notice: [fxNotice, quoteNotice].filter(Boolean).join(' '), hint: '分币种资产为持仓市值与现金的本币合计'
    }));
  }
  cards.push(card('股票市值', stock, { hint: state.value.fundHoldings?.length ? '含场外基金' : '' }));
  cards.push(card('期权市值', option));
  cards.push(card('总盈亏', pnl, { signed: true, classes: 'sm-summary-card--green', hint: '持仓未实现盈亏' }));
  cards.push(card('当日总盈亏', daily, { total: convert(daily, true), signed: true, classes: 'sm-summary-card--amber', hint: dailyHint }));
  if (cashVisible.value) {
    cards.push(card('现金', cash, {
      editCash: canP('cash', 'edit') && !state.value.accountCashEnabled,
      notice: fxNotice, hint: cashHint
    }));
  }
  return cards;
});

const pnlStats = computed(() => {
  const s = state.value.summary || {};
  const stat = (label: string, val: any, kind?: string) => {
    if (!pnlVisible.value) return { label, value: MASK, cls: '', html: true };
    if (kind === 'commission') return { label, value: fmtCommission(val), cls: 'neg', html: false };
    if (kind === 'signed') return { label, value: fmtUsdSigned(val), cls: cls(val), html: false };
    return { label, value: fmtUsd(val), cls: '', html: false };
  };
  return [
    stat('买入总额', s.totalBuy, 'money'),
    stat('卖出总额', s.totalSell, 'money'),
    stat('已实现盈亏', s.realizedPL, 'signed'),
    stat('手续费', s.commission, 'commission'),
    stat('其它收支', s.otherAmount, 'signed'),
    stat('净盈亏', s.netPL, 'signed')
  ];
});

const sortedAccounts = computed(() => state.value.investmentAccounts || []);

function pnlQuery() {
  const q = new URLSearchParams();
  if (accountId.value) q.set('accountId', accountId.value);
  if (pnlStart.value) q.set('start', pnlStart.value);
  if (pnlEnd.value) q.set('end', pnlEnd.value);
  const s = q.toString();
  return s ? '?' + s : '';
}

function schedulePrefsSave(partial: any) {
  clearTimeout(prefSaveTimer);
  prefSaveTimer = setTimeout(() => {
    persistPrefs(partial).catch((e: any) => toastErr(e.message));
  }, 300);
}

async function persistPrefs(partial: any) {
  if (isPortalMode()) {
    await saveStockManagePrefs(partial);
    return;
  }
  if ('dashboardVisible' in partial) saveJson(LS_DASHBOARD, partial.dashboardVisible);
  if ('pnlVisible' in partial) saveJson(LS_PNL_VISIBLE, partial.pnlVisible);
  if ('colVis' in partial) saveJson(LS_COL_VIS, partial.colVis);
}

function applyPortalPrefs() {
  if (isPortalMode()) {
    const prefs = getStockManagePrefs() as any;
    dashboardVisible.value = prefs.dashboardVisible !== false;
    pnlVisible.value = prefs.pnlVisible !== false;
    if (prefs.colVis && typeof prefs.colVis === 'object') Object.assign(colVis, defaultColVis(), prefs.colVis);
    return;
  }
  Object.assign(colVis, defaultColVis(), loadJson(LS_COL_VIS, defaultColVis()));
  dashboardVisible.value = loadJson(LS_DASHBOARD, true);
  pnlVisible.value = loadJson(LS_PNL_VISIBLE, true);
}

function applyLayoutPrefs() {
  fullWidth.value = loadJson(LS_FULL_WIDTH, false);
  document.getElementById('app')?.classList.toggle('sm-app--full', fullWidth.value);
}

function applyPortfolio(next: any) {
  data.value = next;
  renderPnlChartSoon();
}

async function loadPortfolio() {
  const revision = ++portfolioLoadRevision;
  const result = await api('/portfolio' + pnlQuery());
  if (revision === portfolioLoadRevision) applyPortfolio(result);
}

function toastErr(message: string) {
  if (typeof (window as any).portalToast?.error === 'function') (window as any).portalToast.error(message);
  else window.alert(message);
}
function toastOk(message: string) {
  if (typeof (window as any).portalToast?.success === 'function') (window as any).portalToast.success(message);
  else window.alert(message);
}
function toastInfo(message: string) {
  if (typeof (window as any).portalToast?.info === 'function') (window as any).portalToast.info(message);
  else window.alert(message);
}

function saveCash(currency: string, event: any) {
  const value = Number(event.target.value);
  const body = {
    cashUsd: currency === 'USD' ? value : Number(state.value.cashUsd) || 0,
    cashCny: currency === 'CNY' ? value : Number(state.value.cashCny) || 0,
    usdCnyRate: state.value.usdCnyRate
  };
  api('/cash' + pnlQuery(), { method: 'PUT', body })
    .then((result) => { applyPortfolio(result); toastOk('现金已更新'); })
    .catch((err) => toastErr(err.message));
}

function toggleDashboard(event: any) {
  dashboardVisible.value = event.target.checked;
  schedulePrefsSave({ dashboardVisible: dashboardVisible.value });
}
function togglePnlVisible(event: any) {
  pnlVisible.value = event.target.checked;
  schedulePrefsSave({ pnlVisible: pnlVisible.value });
  renderPnlChartSoon();
}
function toggleColPanel() {
  if (!showColumns.value) return;
  colPanelOpen.value = !colPanelOpen.value;
}
function toggleCol(key: string, event: any) {
  colVis[key] = event.target.checked;
  schedulePrefsSave({ colVis: { ...colVis } });
}

function sortBy(key: string) {
  if (!isHoldingsSortable(key) || !canCol(key) || colVis[key] === false) return;
  tableSort.value = toggleTableSort(activeSort.value, key);
  saveJson(LS_TABLE_SORT, tableSort.value);
}

function isExpanded(key: string) { return !collapsed.has(key); }
function toggleGroup(key: string) {
  if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key);
  nextTick(() => {
    const buttons = document.querySelectorAll('[data-toggle-holding-group]');
    for (const btn of buttons) {
      if ((btn as HTMLElement).dataset.toggleHoldingGroup === key) { (btn as HTMLElement).focus({ preventScroll: true }); break; }
    }
  });
}
function holdingRowClass(h: any, group: any, gi: number, i: number) {
  const merged = group.items.length > 1;
  return [
    !merged && gi > 0 && i === 0 ? 'sm-holding-group-start' : '',
    merged ? 'sm-holding-group-detail' : '',
    h.type === 'option' ? 'sm-holding-option' : '',
    (h.type === 'ashare' || h.currency === 'CNY') ? 'sm-holding-ashare' : ''
  ].filter(Boolean).join(' ');
}
function holdingRowAttrs(h: any) {
  return h.type === 'fund' ? { 'data-fund-holding': '' } : { 'data-symbol': h.symbol };
}
function summaryFor(group: any, col: any) { return renderer.groupSummaryCell(group, isExpanded(group.key), col, visibleCols.value); }

const tradeDeps: StockTradeDeps = {
  api, can: canP, getPortfolio: () => state.value, getSelectedAccountId: () => accountId.value,
  applyPortfolio, pnlQuery, toastErr, toastOk
};
const importDeps: StockImportDeps = {
  api, getPortfolio: () => state.value, getSelectedAccountId: () => accountId.value,
  applyPortfolio, loadPortfolio, toastErr, toastOk,
  getQuoteSyncUntil: () => importQuoteSyncUntil,
  setQuoteSyncUntil: (value: number) => { importQuoteSyncUntil = value; }
};
const historyDeps: StockHistoryDeps = {
  api, can: canP, getPortfolio: () => state.value, getSelectedAccountId: () => accountId.value,
  applyPortfolio, pnlQuery,
  openTradeModal: (trade?: any) => openTradeModal(trade || {}, tradeDeps),
  openImportModal: () => openImportModal(importDeps),
  toastErr, toastOk, toastInfo,
  isPnlVisible: () => pnlVisible.value,
  fundPriceDigits: (symbol?: string) => /^HK\d{10}$/i.test(symbol || '') ? 5 : 4
};

function openAccounts() {
  if (!canP('accounts')) return;
  openInvestmentAccounts({
    api, openModal, reload: loadPortfolio, can: canP, toastErr, toastOk
  });
}

function openFundModal(fund: any) {
  const accounts = (state.value.investmentAccounts || []).filter((a: any) => a.currency === 'CNY');
  const selected = fund?.accountId || accountId.value;
  const layer = openModal('编辑基金持仓', `
    <form class="sm-form-grid" id="fund-form" data-validate>
      <label>渠道账户<select name="account" required ${fund ? 'disabled' : ''}>
        <option value="">请选择人民币渠道账户</option>
        ${accounts.map((a: any) => `<option value="${escapeHtml(a.id)}" ${a.id === selected ? 'selected' : ''}>${escapeHtml(a.name)}</option>`).join('')}
      </select></label>
      <label>基金代码<input name="code" required pattern="[0-9]{6}" inputmode="numeric" value="${escapeHtml(fund?.symbol || '')}" ${fund ? 'readonly' : ''}></label>
      <label>基金名称<input name="name" required maxlength="100" value="${escapeHtml(fund?.name || '')}"></label>
      <label>已确认份额<input name="shares" required type="number" min="0.000001" step="any" value="${fund?.shares ?? ''}"></label>
      <label>剩余持仓总成本（元）<input name="cost" required type="number" min="0" step="0.01" value="${fund?.cost ?? ''}"></label>
    </form>`, null, async (modal) => {
    const fd: any = (modal as any)._formData;
    const path = `/fund-holdings/${encodeURIComponent(fund?.accountId || fd.get('account'))}/${encodeURIComponent(fd.get('code'))}`;
    await api(path, { method: 'PUT', body: { name: fd.get('name'), shares: fd.get('shares'), cost: fd.get('cost'), edit: !!fund } });
    return '基金持仓已保存';
  });
  return layer;
}

function openNoteModal(symbol: string, account: string, holding: any) {
  const layer = openModal('编辑持仓备注', `
    <form data-validate class="sm-holding-note-form">
      <label>${escapeHtml(holding.symbol)}${holding.accountName ? ` · ${escapeHtml(holding.accountName)}` : ''}
        <textarea name="note" rows="4" maxlength="500" aria-label="持仓备注" placeholder="最多 500 字">${escapeHtml(holding.note || '')}</textarea>
      </label>
    </form>`, null, async (modal) => {
    await api('/holdings-note/' + encodeURIComponent(symbol), {
      method: 'PUT', body: { accountId: account, note: (modal as any)._formData.get('note') }
    });
    return '备注已保存';
  });
  setTimeout(() => layer.querySelector('textarea')?.focus(), 0);
}

async function saveMeta(symbol: string, patch: any) {
  if (!canP('meta', 'edit')) throw new Error('无权修改');
  applyPortfolio(await api('/holdings-meta/' + encodeURIComponent(symbol) + pnlQuery(), { method: 'PUT', body: patch }));
}

async function onBodyClick(event: any) {
  const button = event.target.closest('button');
  if (button) {
    const { fundEdit, fundRefresh, fundDelete } = button.dataset;
    if (fundEdit != null || fundRefresh != null || fundDelete != null) {
      const fund = state.value.fundHoldings?.[fundEdit ?? fundRefresh ?? fundDelete];
      if (!fund) return;
      if (fundEdit != null) return openFundModal(fund);
      if (fundDelete != null && !window.confirm(`移除 ${fund.name} 的场外持仓？`)) return;
      button.disabled = true;
      try {
        const path = `/fund-holdings/${encodeURIComponent(fund.accountId)}/${encodeURIComponent(fund.symbol)}`;
        await api(fundRefresh != null ? `${path}/refresh` : path, { method: fundRefresh != null ? 'POST' : 'DELETE' });
        await loadPortfolio();
        toastOk(fundRefresh != null ? '净值已更新' : '持仓已移除');
      } catch (err: any) {
        toastErr(err.message);
      } finally {
        button.disabled = false;
      }
      return;
    }
  }
  const toggle = event.target.closest('[data-toggle-holding-group]');
  if (toggle) {
    toggleGroup(toggle.dataset.toggleHoldingGroup);
    return;
  }
  const clearSym = event.target.closest('[data-clear-group]')?.dataset.clearGroup;
  if (clearSym) {
    if (!canP('meta', 'edit')) return;
    try {
      await saveMeta(clearSym, { groupWith: '' });
      toastOk('已恢复自动分组');
    } catch (err: any) { toastErr(err.message); }
    return;
  }
  const noteButton = event.target.closest('[data-edit-note]');
  if (noteButton && canCol('note') && canP('holding-note', 'edit')) {
    const { editNote: symbol, account } = noteButton.dataset;
    const holding = [...(state.value.holdings || []), ...(state.value.fundHoldings || [])].find((row: any) =>
      (row.tradeSymbol || row.symbol) === symbol && (row.accountId || '') === account);
    if (!holding) return;
    openNoteModal(symbol, account, holding);
    return;
  }
  const sym = event.target.closest('[data-refresh]')?.dataset.refresh;
  if (sym) { await refreshQuotes(sym); return; }
  const tradeButton = event.target.closest('[data-trade]');
  const tradeType = tradeButton?.dataset.trade;
  const tradeSym = tradeButton?.dataset.symbol;
  if (tradeType && tradeSym) {
    const account = tradeButton.dataset.account || '';
    const holding = (state.value.fundHoldings || []).find((h: any) => h.tradeSymbol === tradeSym && h.accountId === account)
      || (state.value.holdings || []).find((h: any) => h.symbol === tradeSym && h.accountId === account);
    openTradeModal({ prefillType: tradeType, symbol: tradeSym, account_id: account, name: holding?.name || '', currency: holding?.currency }, tradeDeps);
    return;
  }
  const histSym = event.target.closest('[data-history]')?.dataset.history;
  if (histSym) openTradeHistoryModal(historyDeps, { symbol: histSym });
}

function onDragStart(event: any) {
  const el = event.target.closest('[data-drag]');
  if (!el) return;
  dragSourceSymbol = el.dataset.drag;
  event.dataTransfer?.setData('text/plain', dragSourceSymbol);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
}
function onDragOver(event: any) {
  if (dragSourceSymbol && event.target.closest('[data-group-drop]')) {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  }
}
function onDragEnd() { dragSourceSymbol = ''; }
async function onDrop(event: any) {
  if (!canP('meta', 'edit') || !dragSourceSymbol) return;
  const targetEl = event.target.closest('[data-group-drop]');
  if (!targetEl) return;
  event.preventDefault();
  const src = dragSourceSymbol;
  dragSourceSymbol = '';
  const dst = targetEl.dataset.groupDrop;
  if (!src || !dst || src === dst) return;
  const anchor = (state.value.holdings || []).find((h: any) => h.symbol === dst)
    || (state.value.fundHoldings || []).find((h: any) => h.tradeSymbol === dst);
  if (!anchor) return;
  try {
    await saveMeta(src, { groupWith: effectiveGroupKey(anchor) });
    toastOk('已合并为同一标的');
  } catch (err: any) {
    toastErr(err.message);
  }
}

function renderPnlChart() {
  const el = pnlChartEl.value;
  if (!el) return;
  if (!pnlVisible.value) {
    disposePnlChart();
    el.innerHTML = '<p class="hint sm-muted">盈亏数据已隐藏</p>';
    return;
  }
  renderPnlVisualization(el, () => ({
    chartSeries: state.value.chartSeries || [],
    chartSparse: state.value.chartSparse || [],
    chartExpandedFull: state.value.chartExpandedFull || [],
    totalAssets: state.value.summary?.totalAssets,
    pnlStart: pnlStart.value,
    pnlEnd: pnlEnd.value
  }), {
    onModeChange: (mode: string) => { pnlVizMode.value = mode; },
    onCalendarDay: (d: string) => openTradeHistoryForRange(historyDeps, d, d),
    onCalendarMonth: (y: number, mo: number) => {
      const start = `${y}-${String(mo).padStart(2, '0')}-01`;
      const end = `${y}-${String(mo).padStart(2, '0')}-${String(new Date(y, mo, 0).getDate()).padStart(2, '0')}`;
      openTradeHistoryForRange(historyDeps, start, end);
    },
    onCalendarYear: (year: number) => {
      openTradeHistoryForRange(historyDeps, `${year}-01-01`, `${year}-12-31`);
    }
  });
}
function renderPnlChartSoon() {
  nextTick(() => renderPnlChart());
}

function setPnlPeriod(next: string) {
  if (next === 'range') {
    if (!(document.getElementById('pnl-start') as HTMLInputElement | null)?.value) {
      const startEl = document.getElementById('pnl-start') as HTMLInputElement | null;
      const endEl = document.getElementById('pnl-end') as HTMLInputElement | null;
      if (startEl && !startEl.value) startEl.value = pnlStart.value || pnlToday();
      if (endEl && !endEl.value) endEl.value = pnlEnd.value || pnlToday();
    }
  }
  pnlPeriod.value = next as any;
  queryPnlPeriod();
}

function queryPnlPeriod() {
  let start = '';
  let end = '';
  if (pnlPeriod.value === 'range') {
    start = (document.getElementById('pnl-start') as HTMLInputElement | null)?.value || '';
    end = (document.getElementById('pnl-end') as HTMLInputElement | null)?.value || '';
    if (!start || !end || start > end) {
      toastErr('请选择有效的开始和结束日期');
      return;
    }
  } else if (pnlPeriod.value !== 'all') {
    const a = new Date((pnlAnchor.value || pnlToday()) + 'T12:00:00Z');
    const b = new Date(a);
    if (pnlPeriod.value === 'week') {
      a.setUTCDate(a.getUTCDate() - (a.getUTCDay() + 6) % 7);
      b.setTime(a.getTime());
      b.setUTCDate(b.getUTCDate() + 6);
    } else if (pnlPeriod.value === 'month') {
      a.setUTCDate(1);
      b.setUTCMonth(b.getUTCMonth() + 1, 0);
    } else {
      a.setUTCMonth(0, 1);
      b.setUTCMonth(11, 31);
    }
    start = pnlIso(a);
    end = pnlIso(b);
    pnlCaption.value = `${start} ～ ${end}`;
  }
  pnlStart.value = start;
  pnlEnd.value = end;
  loadPortfolio().catch((error) => toastErr(error.message));
}

function stepPnl(step: number) {
  const day = new Date((pnlAnchor.value || pnlToday()) + 'T12:00:00Z');
  if (pnlPeriod.value === 'week') day.setUTCDate(day.getUTCDate() + 7 * step);
  if (pnlPeriod.value === 'month') day.setUTCMonth(day.getUTCMonth() + step, 1);
  if (pnlPeriod.value === 'year') day.setUTCFullYear(day.getUTCFullYear() + step, 0, 1);
  pnlAnchor.value = pnlIso(day);
  queryPnlPeriod();
}
function pnlTodayClick() {
  pnlAnchor.value = pnlToday();
  queryPnlPeriod();
}

async function refreshQuotes(symbol?: string) {
  if (quotesBusy.value || !canP('refresh', 'edit')) return;
  quotesBusy.value = true;
  quoteVisible.value = true;
  quoteMax.value = 0;
  quoteValue.value = 0;
  const report = (message: string) => { quoteVisible.value = true; quoteMessage.value = message; };
  report(symbol ? `正在刷新 ${symbol} 报价…` : '正在刷新持仓报价，请稍候…');
  const scope = pnlQuery();
  const revision = portfolioLoadRevision;
  const isCurrent = () => revision === portfolioLoadRevision && scope === pnlQuery();
  try {
    const response = await fetch('./api/quotes/refresh' + (scope ? scope + '&' : '?') + 'progress=1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(symbol ? { symbol } : {})
    });
    const payload: any = await readProgressResponse(response, ({ phase, total, completed, active, ok, failed, valuation, symbol: finished }: any) => {
      quoteMax.value = total;
      quoteValue.value = completed;
      const current = active.length ? `正在刷新 ${active.join('、')}` : finished ? `刚处理 ${finished}` : '准备刷新';
      const counts = `已处理 ${completed}/${total}（成功 ${ok}，失败 ${failed}）`;
      report(phase === 'fx' ? `${counts} · 正在更新汇率` : `${counts} · ${current}`);
      if (valuation && isCurrent()) {
        data.value = { ...state.value, ...valuation, summary: { ...state.value.summary, ...valuation.summary } };
        renderPnlChartSoon();
      }
    }, { failed: '行情刷新请求失败', interrupted: '行情刷新进度连接已中断' });
    if (isCurrent()) applyPortfolio(payload);
    else await loadPortfolio();
    const r = payload.refresh;
    if (r?.failed) {
      const msg = r.errors.slice(0, 5).map((e: any) => `${e.symbol}: ${e.error}`).join(' · ');
      const message = `已刷新 ${r.ok} 个，失败 ${r.failed} 个：${msg}`;
      report(message);
      if ((window as any).portalToast?.show) (window as any).portalToast.show(message, { type: 'warn', group: 'quote-refresh' });
      else toastErr(message);
    } else if (r?.ok) {
      const message = symbol ? `已刷新 ${symbol} 报价` : `已刷新 ${r.ok} 个报价`;
      report(message);
      if ((window as any).portalToast?.show) (window as any).portalToast.show(message, { type: 'success', group: 'quote-refresh' });
      else toastOk(message);
    }
  } catch (e: any) {
    report(`刷新失败：${e.message}`);
    toastErr(e.message);
  } finally {
    quotesBusy.value = false;
    quoteVisible.value = false;
  }
}

async function changeAccount(event: any) {
  accountId.value = event.target.value;
  try { await loadPortfolio(); } catch (error: any) { toastErr(error.message); }
}

let importQuoteSyncUntil = 0;

const syncAccountView = async () => {
  if (document.hidden) return;
  if (!state.value.accountCashEnabled && Date.now() < importQuoteSyncUntil) return;
  if (quoteSyncBusy || document.getElementById('modal-root')?.children.length) return;
  quoteSyncBusy = true;
  try { await loadPortfolio(); } catch { /* retry on next tick */ }
  finally { quoteSyncBusy = false; }
};

function onVisibilityChange() { void syncAccountView(); }
let syncTimer: any = null;

onMounted(async () => {
  applyLayoutPrefs();
  window.addEventListener('portal-layout-change', applyLayoutPrefs);
  window.addEventListener('storage', onStorage);
  (window as any)._stockReload = () => loadPortfolio().catch((e: any) => toastErr(e.message));
  await loadPortalContext();
  ctxTick.value++;
  applyPortalPrefs();
  try {
    await loadPortfolio();
    loading.value = false;
    if (new URLSearchParams(location.search).get('showAccounts') === '1' && canP('accounts')) openAccounts();
  } catch (e: any) {
    loading.value = false;
    error.value = e.message;
    toastErr(`加载失败: ${e.message}`);
  }
  document.addEventListener('visibilitychange', onVisibilityChange);
  syncTimer = setInterval(() => { void syncAccountView(); }, 15000);
  window.navigationSkeleton?.finish?.();
});

function onStorage(e: StorageEvent) {
  if (e.key === LS_FULL_WIDTH) applyLayoutPrefs();
}

onUnmounted(() => {
  disposePnlChart();
  window.removeEventListener('portal-layout-change', applyLayoutPrefs);
  window.removeEventListener('storage', onStorage);
  document.removeEventListener('visibilitychange', onVisibilityChange);
  clearInterval(syncTimer);
  delete (window as any)._stockReload;
});

watch([data, pnlVisible], () => renderPnlChartSoon());
</script>

<template>
  <nav class="sm-feature-tabs" aria-label="股票功能">
    <a class="sm-feature-tab active" href="/stock-manage/">持仓</a>
    <a v-if="showDipTab" class="sm-feature-tab" href="/stock-manage/dip/">抄底监控</a>
    <a v-if="showQuantTab" class="sm-feature-tab" href="/stock-manage/quant/">量化分析</a>
  </nav>

  <p v-if="error" class="sm-error" role="alert">{{ error }}</p>

  <section v-if="showPnl" class="sm-panel" id="section-pnl">
    <div class="sm-panel-head sm-panel-head--pnl">
      <h2>查询盈亏</h2>
    </div>
    <div class="sm-pnl-period" v-show="pnlVizMode === 'line'">
      <div class="sm-seg" role="group" aria-label="盈亏时间范围">
        <button v-for="item in [['week','周'],['month','月'],['year','年'],['all','全部'],['range','范围']]"
                :key="item[0]" type="button" class="sm-seg-btn"
                :class="{ active: pnlPeriod === item[0] }" :aria-pressed="pnlPeriod === item[0]"
                @click="setPnlPeriod(item[0])">{{ item[1] }}</button>
      </div>
      <div class="sm-pnl-period-controls" :class="{ hidden: ['all','range'].includes(pnlPeriod) }" id="pnl-navigation">
        <div class="sm-pnl-date-stepper">
          <button type="button" id="pnl-prev" class="sm-pnl-control" aria-label="上一时间段" @click="stepPnl(-1)">‹</button>
          <span id="pnl-caption" aria-live="polite">{{ pnlCaption }}</span>
          <button type="button" id="pnl-next" class="sm-pnl-control" aria-label="下一时间段" @click="stepPnl(1)">›</button>
        </div>
        <div class="sm-pnl-date-jump">
          <input v-model="pnlAnchor" type="date" id="pnl-anchor" aria-label="定位日期" title="定位日期" @change="queryPnlPeriod">
          <button type="button" id="pnl-today" class="sm-pnl-control" @click="pnlTodayClick">今天</button>
        </div>
      </div>
      <div class="sm-pnl-period-controls sm-pnl-date-range" :class="{ hidden: pnlPeriod !== 'range' }" id="pnl-range">
        <input type="date" id="pnl-start" aria-label="开始日期" title="开始日期">
        <span aria-hidden="true">至</span>
        <input type="date" id="pnl-end" aria-label="结束日期" title="结束日期">
        <button type="button" id="btn-pnl-query" class="sm-pnl-control sm-pnl-apply" @click="queryPnlPeriod">查询</button>
      </div>
    </div>
    <div id="pnl-stats" class="sm-stats sm-stats--inner" v-show="pnlVizMode === 'line'">
      <div v-for="stat in pnlStats" :key="stat.label" class="sm-stat">
        <div class="label">{{ stat.label }}</div>
        <div class="value" :class="stat.cls" v-html="stat.value"></div>
      </div>
    </div>
    <div id="pnl-chart" ref="pnlChartEl"></div>
  </section>

  <div v-if="showDashboardBlock" class="sm-dashboard-block" id="section-dashboard">
    <div class="sm-toggles">
      <label v-if="showDashToggle" class="sm-toggle-row sm-dashboard-toggle">
        <input type="checkbox" id="toggle-dashboard" :checked="dashboardVisible" @change="toggleDashboard">
        <span>显示看板（总资产、市值、盈亏、当日盈亏、现金）</span>
      </label>
      <label v-if="showPnlToggle" class="sm-toggle-row sm-pnl-visible-toggle">
        <input type="checkbox" id="toggle-pnl-visible" :checked="pnlVisible" @change="togglePnlVisible">
        <span>显示盈亏数据</span>
      </label>
    </div>
    <section id="dashboard" class="sm-dashboard">
      <div v-if="loading" class="hint">加载中…</div>
      <div v-else class="sm-summary-grid">
        <div v-for="card in dashboardCards" :key="card.key" class="sm-summary-card" :class="card.classes">
          <div class="label">{{ card.label }}</div>
          <div class="value" :class="card.totalClass" v-html="card.totalHtml"></div>
          <div v-if="card.notice" class="hint">{{ card.notice }}</div>
          <div class="sm-asset-split">
            <div v-for="split in card.splits" :key="split.name" class="sm-asset-split-item">
              <span class="sm-asset-split-label">{{ split.name }}</span>
              <span class="sm-asset-split-value" :class="split.cls">
                <span v-if="split.editable" class="sm-cash-input-wrap">
                  <span>{{ split.currency === 'USD' ? '$' : '¥' }}</span>
                  <input :aria-label="split.name + '现金'" type="number" step="0.01"
                         :value="split.raw" @change="saveCash(split.currency, $event)">
                </span>
                <span v-else v-html="split.html"></span>
              </span>
            </div>
          </div>
          <div v-if="card.hint" class="hint">{{ card.hint }}</div>
        </div>
      </div>
    </section>
  </div>

  <section class="sm-panel">
    <div class="sm-panel-head">
      <h2>持仓明细</h2>
      <div class="sm-panel-head-actions">
        <select v-if="showAccounts" id="account-filter" aria-label="证券账户" :value="accountId" @change="changeAccount">
          <option value="">全部账户</option>
          <option value="unassigned">待归属交易</option>
          <option v-for="a in sortedAccounts" :key="a.id" :value="a.id">{{ a.name }} · {{ a.currency }}</option>
        </select>
        <button v-if="showAccounts" type="button" class="btn ghost sm-btn-sm" @click="openAccounts">账户管理</button>
        <button v-if="showTrades" type="button" class="btn ghost sm-btn-sm" @click="openTradeHistoryModal(historyDeps)">交易记录</button>
        <button v-if="showImport" type="button" class="btn ghost sm-btn-sm" @click="openImportModal(importDeps)">导入交易</button>
        <button v-if="showAdd" type="button" class="btn primary sm-btn-sm" @click="openTradeModal({}, tradeDeps)">记一笔</button>
        <button v-if="showRefresh" type="button" class="btn ghost sm-btn-sm" :disabled="quotesBusy" @click="refreshQuotes()">{{ quotesBusy ? '刷新中…' : '刷新价格' }}</button>
        <button v-if="showColumns" type="button" class="btn ghost sm-btn-sm" @click="toggleColPanel">列数据</button>
      </div>
    </div>
    <div v-if="colPanelOpen && showColumns" id="col-toggle-panel" class="sm-col-panel">
      <label v-for="col in visibleCols" :key="col.key" class="sm-col-check">
        <input type="checkbox" :data-col="col.key" :checked="colVis[col.key] !== false"
               @change="toggleCol(col.key, $event)"> {{ col.label }}
      </label>
    </div>
    <div v-if="quoteVisible" class="sm-quote-refresh sm-holdings-hint hint" id="quote-refresh-status">
      <progress aria-label="报价刷新进度" :max="quoteMax" :value="quoteValue"></progress>
      <span role="status" aria-live="polite">{{ quoteMessage }}</span>
    </div>
    <p class="sm-holdings-hint hint">同标的自动分组（期权归入正股）。拖动代码旁的 ⠿ 到另一行代码可合并，点击 ↺ 恢复。点击「代码」或「仓位 / 占比」表头可排序。</p>
    <div class="sm-table-wrap">
      <table class="sm-table" id="holdings-table">
        <thead id="holdings-head">
          <tr>
            <th v-for="col in visibleCols" :key="col.key"
                :class="{ 'sm-sort-th': isHoldingsSortable(col.key) && colVis[col.key] !== false }"
                :data-sort="isHoldingsSortable(col.key) && colVis[col.key] !== false ? col.key : null"
                :title="isHoldingsSortable(col.key) && colVis[col.key] !== false ? '按' + col.label + '排序' : null"
                :aria-sort="activeSort.key === col.key ? (activeSort.dir === 1 ? 'ascending' : 'descending') : null"
                @click="sortBy(col.key)">
              {{ col.label }}<template v-if="isHoldingsSortable(col.key) && colVis[col.key] !== false">{{ sortMark(activeSort, col.key) }}</template>
            </th>
          </tr>
        </thead>
        <tbody id="holdings-body"
               @click="onBodyClick"
               @dragstart="onDragStart"
               @dragover="onDragOver"
               @dragend="onDragEnd"
               @drop="onDrop">
          <template v-for="(group, gi) in groups" :key="group.key">
            <tr v-if="group.items.length > 1"
                class="sm-holding-group-summary" :class="{ 'sm-holding-group-start': gi > 0 }">
              <td v-for="col in visibleCols" :key="col.key" v-bind="summaryFor(group, col).attrs"
                  v-html="summaryFor(group, col).html"></td>
            </tr>
            <template v-if="group.items.length === 1 || isExpanded(group.key)">
              <tr v-for="(h, i) in group.items" :key="h.id || h.symbol + i"
                  :class="holdingRowClass(h, group, gi, i)" v-bind="holdingRowAttrs(h)">
                <td v-for="col in visibleCols" :key="col.key" v-bind="renderer.rowCellAttrs(h, col)"
                    :class="renderer.rowCellClass(h, col)" v-html="renderer.rowCell(h, col, group)"></td>
              </tr>
            </template>
          </template>
          <tr v-if="!groups.length && !cashVisible">
            <td :colspan="visibleCols.length || 1" class="empty">暂无持仓</td>
          </tr>
          <tr v-if="cashVisible" class="sm-cash-row">
            <td v-for="col in visibleCols" :key="col.key" :data-label="col.label" v-html="renderer.cashCell(col, cashPct)"></td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
