import { TRADE_ASSET_TYPES, tradeAssetType } from './js/trade-asset-type.js';
import { formatPrice, priceInputValue } from './js/price-format.js';
import { HOLDINGS_COLUMNS, colFeatureId, LS_COL_VIS, LS_DASHBOARD, LS_PNL_VISIBLE, LS_FULL_WIDTH, LS_TABLE_SORT, loadJson, saveJson, defaultColVis, defaultTableSort } from './js/constants.js';
import { renderPnlVisualization, disposePnlChart } from './js/pnl-viz.js?v=20261004-full-history';
import { buildHoldingsGroups, toggleTableSort, sortMark, effectiveGroupKey } from './js/holdings-table.js';
import { loadPortalContext, can, canDip, saveStockManagePrefs, isPortalMode, getStockManagePrefs } from './js/portal-auth.js';

const $ = (sel, root = document) => root.querySelector(sel);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const fmt = (n) => Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
const fmtUsd = (n) => Number.isFinite(n) ? '$' + fmt(n) : '—';
const fmtCny = (n) => Number.isFinite(n) ? '¥' + fmt(n) : '—';
const fmtMoney = (n, currency = 'USD') => (String(currency).toUpperCase() === 'CNY' ? fmtCny(n) : fmtUsd(n));
const fmtUsdSigned = (n) => !Number.isFinite(n) ? '—' : `${n >= 0 ? '+' : ''}$${fmt(n)}`;
const fmtMoneySigned = (n, currency = 'USD') => {
  if (!Number.isFinite(n)) return '—';
  return (n >= 0 ? '+' : '-') + fmtMoney(Math.abs(n), currency);
};
const fmtCommission = (n, currency = 'USD') => {
  if (!Number.isFinite(n) || !(n > 0)) return '—';
  return '-' + fmtMoney(n, currency);
};
const fmtPct = (n) => Number.isFinite(n) ? n.toFixed(2) + '%' : '—';
const cls = (n) => n > 0 ? 'pos' : n < 0 ? 'neg' : '';
const roundMoneyClient = (n) => Math.round((Number(n) || 0) * 100) / 100;
const MASK = '<span class="sm-mask">—</span>';
const pad2 = (n) => String(n).padStart(2, '0');

function looksLikeAShare(symbol) {
  const s = String(symbol || '').trim().replace(/^(sh|sz|ss)\.?/i, '').replace(/\.(SH|SZ|SS)$/i, '');
  return /^\d{6}$/.test(s);
}

function holdingTypeLabel(h) {
  if (h.type === 'option') return '期权';
  if (h.type === 'ashare' || h.currency === 'CNY' || looksLikeAShare(h.symbol)) return 'A股/ETF';
  return '股票';
}

function localDateParts(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return null;
  return {
    y: d.getFullYear(),
    m: pad2(d.getMonth() + 1),
    day: pad2(d.getDate()),
    h: pad2(d.getHours()),
    min: pad2(d.getMinutes()),
    s: pad2(d.getSeconds())
  };
}

function formatLocalDateTime(iso) {
  const p = localDateParts(iso);
  return p ? `${p.y}-${p.m}-${p.day} ${p.h}:${p.min}:${p.s}` : (iso || '—');
}

function localDateKey(iso) {
  const p = localDateParts(iso);
  return p ? `${p.y}-${p.m}-${p.day}` : String(iso || '').slice(0, 10);
}

function toDatetimeLocalValue(iso) {
  const p = localDateParts(iso);
  return p ? `${p.y}-${p.m}-${p.day}T${p.h}:${p.min}` : '';
}

function datetimeLocalToIso(value) {
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return new Date().toISOString();
  return new Date(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6] || 0)
  ).toISOString();
}

const toastErr = (msg) => typeof window.portalToast?.error === 'function' ? window.portalToast.error(msg) : window.alert(msg);
const toastWarn = (msg) => typeof window.portalToast?.warn === 'function' ? window.portalToast.warn(msg) : window.alert(msg);
const toastOk = (msg) => typeof window.portalToast?.success === 'function' ? window.portalToast.success(msg) : window.alert(msg);
const toastInfo = (msg) => typeof window.portalToast?.info === 'function' ? window.portalToast.info(msg) : window.alert(msg);
const toastRefresh = (type, msg) => {
  if (window.portalToast?.show) window.portalToast.show(msg, { type, group: 'quote-refresh' });
  else if (type === 'error') toastErr(msg);
  else if (type === 'warn') toastWarn(msg);
  else toastOk(msg);
};

let state = {
  cash: 0,
  cashUsd: 0,
  cashCny: 0,
  usdCnyRate: 7.2,
  trades: [],
  holdings: [],
  summary: {},
  chartSeries: [],
  chartSparse: [],
  chartExpandedFull: [],
  holdingsMeta: {}
};
let colVis = defaultColVis();
let dashboardVisible = true;
let pnlVisible = true;
let fullWidth = loadJson(LS_FULL_WIDTH, false);
let tableSort = loadJson(LS_TABLE_SORT, defaultTableSort());
let dragSourceSymbol = null;
let quotesRefreshBusy = false;
let pnlStart = '';
let pnlEnd = '';
let prefSaveTimer = null;

const ui = {
  tradeTab: 'list',
  tradePage: 1,
  tradePageSize: 10,
  tradeSummarySort: { key: '', dir: -1 },
  tradeFilter: { symbol: '', type: 'all', assetType: 'all', otherCategory: '', start: '', end: '' },
  tradeFilterOpen: false
};

async function api(path, opts = {}) {
  const res = await fetch('./api' + path, {
    headers: opts.body && !(opts.body instanceof ArrayBuffer) && !(opts.body instanceof Blob)
      ? { 'Content-Type': 'application/json', ...opts.headers } : opts.headers,
    ...opts,
    body: opts.body instanceof ArrayBuffer || opts.body instanceof Blob ? opts.body
      : opts.body != null ? JSON.stringify(opts.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function pnlQuery() {
  const q = new URLSearchParams();
  if (pnlStart) q.set('start', pnlStart);
  if (pnlEnd) q.set('end', pnlEnd);
  const s = q.toString();
  return s ? '?' + s : '';
}

function canCol(key) {
  return can(colFeatureId(key));
}

function visibleHoldingsColumns() {
  return HOLDINGS_COLUMNS.filter((c) => canCol(c.key));
}

function maskCol(key, html) {
  if (!canCol(key)) return MASK;
  return colVis[key] !== false ? html : MASK;
}

function maskPnlValue(html) {
  return pnlVisible ? html : MASK;
}

function maskDashboardValue(html) {
  return dashboardVisible ? html : MASK;
}

function schedulePrefsSave(partial) {
  clearTimeout(prefSaveTimer);
  prefSaveTimer = setTimeout(() => {
    persistPrefs(partial).catch((e) => toastErr(e.message));
  }, 300);
}

async function persistPrefs(partial) {
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
    const prefs = getStockManagePrefs();
    dashboardVisible = prefs.dashboardVisible !== false;
    pnlVisible = prefs.pnlVisible !== false;
    if (prefs.colVis && typeof prefs.colVis === 'object') {
      colVis = Object.assign(defaultColVis(), prefs.colVis);
    }
    return;
  }
  colVis = loadJson(LS_COL_VIS, defaultColVis());
  dashboardVisible = loadJson(LS_DASHBOARD, true);
  pnlVisible = loadJson(LS_PNL_VISIBLE, true);
}

function applyDipTabs() {
  const nav = document.querySelector('.sm-feature-tabs');
  if (!nav) return;
  nav.querySelectorAll('a.sm-feature-tab').forEach((a) => {
    const href = a.getAttribute('href') || '';
    if (href.includes('tab=qq')) a.hidden = !canDip('tab-qq');
    else if (href.includes('/yolo/')) a.hidden = !can('tab-yolo');
    else if (href.includes('/quant/')) a.hidden = !can('tab-quant');
    else if (href.includes('/dip/')) a.hidden = !canDip('tab-monitor');
  });
}

function applyPermissions() {
  $('#section-pnl')?.classList.toggle('hidden', !can('pnl'));
  const dashBlock = $('#section-dashboard');
  if (dashBlock) dashBlock.classList.toggle('hidden', !can('dashboard') && !can('pnl-toggle'));
  document.querySelector('.sm-dashboard-toggle')?.classList.toggle('hidden', !can('dashboard'));
  document.querySelector('.sm-pnl-visible-toggle')?.classList.toggle('hidden', !can('pnl-toggle'));
  $('#btn-trades').hidden = !can('trades');
  $('#btn-import').hidden = !can('import', 'edit');
  $('#btn-add').hidden = !can('trade', 'edit');
  $('#btn-refresh').hidden = !can('refresh', 'edit');
  $('#btn-col-toggle').hidden = !can('columns');
  $('#col-toggle-panel')?.classList.toggle('hidden', !can('columns'));
}

function typeLabel(t) {
  if (t.type === 'buy') return '买入';
  if (t.type === 'sell') return '卖出';
  if (t.type === 'other') return '其它/' + (t.other_category || '');
  return t.type;
}

function signalOptions(val) {
  return ['', '买入', '持有', '卖出'].map((v) =>
    `<option value="${v}" ${val === v ? 'selected' : ''}>${v || '—'}</option>`).join('');
}

function renderDashboard() {
  const el = $('#dashboard');
  $('#toggle-dashboard').checked = dashboardVisible;
  $('#toggle-pnl-visible').checked = pnlVisible;
  el.classList.remove('hidden');
  const s = state.summary || {};
  const cashVisible = can('cash') && state.cashVisible !== false;
  const cashEq = Number.isFinite(s.cashUsdEq) ? s.cashUsdEq : state.cash;
  const cashPct = s.totalAssets > 0 ? (cashEq / s.totalAssets * 100) : 0;
  const usPnl = s.totalPnlUsd;
  const cnPnl = s.totalPnlCny;
  const dailyUs = s.dailyTotalPnlUsd != null ? s.dailyTotalPnlUsd : s.marketDailyPnlUsd;
  const dailyCn = s.dailyTotalPnlCny != null ? s.dailyTotalPnlCny : s.marketDailyPnlCny;
  const hasDaily = dailyUs != null || dailyCn != null || s.dailyTotalPnl != null;
  const dailyHint = !dashboardVisible || !pnlVisible
    ? '—'
    : !hasDaily
      ? '刷新行情后显示持仓涨跌'
      : (s.tradeDailyPnl != null && s.tradeDailyPnl !== 0
        ? `含今日交易净变动 ${fmtUsd(s.tradeDailyPnl)}`
        : '持仓当日涨跌');
  const usPnlDisplay = usPnl == null ? '—' : fmtUsdSigned(usPnl);
  const dailyUsDisplay = dailyUs == null ? '—' : fmtUsdSigned(dailyUs);
  const hasAshare = Number(s.ashareMvNative) > 0 || (Number.isFinite(cnPnl) && cnPnl !== 0);
  const ashareMvLine = hasAshare || Number(s.ashareMvNative) > 0
    ? `<div class="sm-sub-value">A股/ETF ${maskDashboardValue(fmtCny(s.ashareMvNative ?? 0))}</div>`
    : '';
  const totalPnlAshare = hasAshare
    ? `<div class="sm-sub-value ${dashboardVisible && pnlVisible ? cls(cnPnl) : ''}">A股/ETF ${maskDashboardValue(maskPnlValue(fmtMoneySigned(Number.isFinite(cnPnl) ? cnPnl : 0, 'CNY')))}</div>`
    : '';
  const totalPnlHint = hasAshare ? '' : '美股未实现盈亏';
  const dailyPnlAshare = (hasAshare || (Number.isFinite(dailyCn) && dailyCn !== 0))
    ? `<div class="sm-sub-value ${dashboardVisible && pnlVisible && dailyCn != null ? cls(dailyCn) : ''}">A股/ETF ${maskDashboardValue(maskPnlValue(dailyCn == null ? '—' : fmtMoneySigned(dailyCn, 'CNY')))}</div>`
    : '';
  const dailyMetaHint = (dailyHint && dailyHint !== '—') ? dailyHint : '';
  const cashField = !dashboardVisible
    ? `<div class="value">${MASK}</div>`
    : can('cash', 'edit')
      ? `<div class="sm-cash-dual">
          <div class="sm-cash-input-wrap"><span>$</span><input type="number" step="0.01" id="cash-usd-input" value="${state.cashUsd ?? 0}"></div>
          <div class="sm-cash-input-wrap"><span>¥</span><input type="number" step="0.01" id="cash-cny-input" value="${state.cashCny ?? 0}"></div>
        </div>`
      : `<div class="value">${fmtUsd(state.cashUsd)} · ${fmtCny(state.cashCny)}</div>`;
  const rateHint = `汇率 ${Number(state.usdCnyRate || 0).toFixed(4)} · 折合 ${maskDashboardValue(fmtUsd(cashEq))} · 占组合 ${maskDashboardValue(fmtPct(cashPct))}`;
  const rate = Number(state.usdCnyRate) > 0 ? Number(state.usdCnyRate) : 7.2;
  const assetsUsd = Number.isFinite(s.assetsUsd)
    ? s.assetsUsd
    : roundMoneyClient((Number(s.stockMv) || 0) + (Number(s.optionMv) || 0) + (Number(state.cashUsd) || 0));
  const assetsCny = Number.isFinite(s.assetsCny)
    ? s.assetsCny
    : roundMoneyClient((Number(s.ashareMvNative) || 0) + (Number(state.cashCny) || 0));
  const totalAssetsCny = Number.isFinite(s.totalAssetsCny)
    ? s.totalAssetsCny
    : roundMoneyClient((Number(s.totalAssets) || 0) * rate);
  const totalAssetsLine = `${fmtUsd(s.totalAssets)}（${fmtCny(totalAssetsCny)}）`;
  el.innerHTML = `
    <div class="sm-summary-grid">
      ${cashVisible ? `
      <div class="sm-summary-card sm-summary-card--accent sm-summary-card--assets">
        <div class="label">总资产</div>
        <div class="value">${maskDashboardValue(totalAssetsLine)}</div>
        <div class="sm-asset-split">
          <div class="sm-asset-split-item">
            <span class="sm-asset-split-label">美元资产</span>
            <span class="sm-asset-split-value">${maskDashboardValue(fmtUsd(assetsUsd))}</span>
          </div>
          <div class="sm-asset-split-item">
            <span class="sm-asset-split-label">人民币资产</span>
            <span class="sm-asset-split-value">${maskDashboardValue(fmtCny(assetsCny))}</span>
          </div>
        </div>
        <div class="hint">美元口径含 A 股折汇；分币种为持仓+现金本币合计</div>
      </div>` : ''}
      <div class="sm-summary-card">
        <div class="label">股票市值</div>
        <div class="value">${maskDashboardValue(fmtUsd(s.stockMv))}</div>
        ${ashareMvLine}
      </div>
      <div class="sm-summary-card">
        <div class="label">期权市值</div>
        <div class="value">${maskDashboardValue(fmtUsd(s.optionMv))}</div>
      </div>
      <div class="sm-summary-card sm-summary-card--green">
        <div class="label">总盈亏</div>
        <div class="value ${dashboardVisible && pnlVisible ? cls(usPnl) : ''}">${maskDashboardValue(maskPnlValue(usPnlDisplay))}</div>
        ${totalPnlAshare}
        ${totalPnlHint ? `<div class="hint">${maskDashboardValue(maskPnlValue(totalPnlHint))}</div>` : ''}
      </div>
      <div class="sm-summary-card sm-summary-card--amber">
        <div class="label">当日总盈亏</div>
        <div class="value ${dashboardVisible && pnlVisible && dailyUs != null ? cls(dailyUs) : ''}">${maskDashboardValue(maskPnlValue(dailyUsDisplay))}</div>
        ${dailyPnlAshare}
        ${dailyMetaHint ? `<div class="hint">${maskDashboardValue(maskPnlValue(dailyMetaHint))}</div>` : ''}
      </div>
      ${cashVisible ? `<div class="sm-summary-card sm-summary-card--cash">
        <div class="label">现金</div>
        ${cashField}
        <div class="hint">${rateHint}</div>
      </div>` : ''}
    </div>`;
  bindCashInput();
}

function bindCashInput() {
  if (!can('cash', 'edit')) return;
  const usdEl = $('#cash-usd-input');
  const cnyEl = $('#cash-cny-input');
  const bind = (el, key) => {
    if (!el || el.dataset.cashBound === '1') return;
    el.dataset.cashBound = '1';
    el.addEventListener('change', async (e) => {
      try {
        const body = {
          cashUsd: key === 'cashUsd' ? Number(e.target.value) : Number(state.cashUsd) || 0,
          cashCny: key === 'cashCny' ? Number(e.target.value) : Number(state.cashCny) || 0,
          usdCnyRate: state.usdCnyRate
        };
        applyPortfolio(await api('/cash' + pnlQuery(), { method: 'PUT', body }));
        toastOk('现金已更新');
      } catch (err) { toastErr(err.message); }
    });
  };
  bind(usdEl, 'cashUsd');
  bind(cnyEl, 'cashCny');
}

function renderColToggle() {
  if (!can('columns')) return;
  const cols = HOLDINGS_COLUMNS.filter((c) => canCol(c.key));
  $('#col-toggle-panel').innerHTML = cols.map((c) => `
    <label class="sm-col-check"><input type="checkbox" data-col="${c.key}" ${colVis[c.key] !== false ? 'checked' : ''}> ${c.label}</label>
  `).join('');
}

function renderHoldingsHead() {
  const cols = visibleHoldingsColumns();
  $('#holdings-head').innerHTML = `<tr>${cols.map((c) => {
    if (c.key === 'type') {
      return `<th class="sm-sort-th" data-sort="type" title="按类型排序（同类型内按仓位）">类型${sortMark(tableSort, 'type')}</th>`;
    }
    if (c.key === 'symbol') {
      return `<th class="sm-sort-th" data-sort="symbol" title="按标的代码排序">代码${sortMark(tableSort, 'symbol')}</th>`;
    }
    if (c.key === 'weight') {
      return `<th class="sm-sort-th" data-sort="weight" title="按同标的合计占总资产比例排序（同仓位按类型）">仓位 / 占比${sortMark(tableSort, 'weight')}</th>`;
    }
    return `<th>${c.label}</th>`;
  }).join('')}</tr>`;
}

function holdingsCellContent(h, key, ctx) {
  const { optStr, lots, symInner } = ctx;
  const cur = h.currency || (looksLikeAShare(h.symbol) ? 'CNY' : 'USD');
  switch (key) {
    case 'type':
      return maskCol('type', holdingTypeLabel(h));
    case 'symbol':
      return maskCol('symbol', symInner);
    case 'name':
      return maskCol('name', h.name && h.name !== h.symbol ? h.name : (h.name || '—'));
    case 'shares':
      return maskCol('shares', h.shares);
    case 'cost':
      return maskCol('cost', formatPrice(h.avgCost, cur) + lots);
    case 'price': {
      const delayHint = h.delayed
        ? ` <span class="hint" title="期权实时快照未授权，当前为 Polygon 延时日线${h.quoteAsOf ? `（截至 ${h.quoteAsOf}）` : ''}">延时</span>`
        : '';
      return maskCol('price', `<span>${formatPrice(h.price, cur)}</span>${delayHint}${can('refresh', 'edit') ? ` <button type="button" class="btn link" data-refresh="${h.symbol}">↻</button>` : ''}`);
    }
    case 'pnl':
      return maskCol('pnl', h.pnl == null ? '—' : `<span class="${cls(h.pnl)}">${fmtMoneySigned(h.pnl, cur)}</span>`);
    case 'pnlPct':
      return maskCol('pnlPct', h.pnlPct == null ? '—' : fmtPct(h.pnlPct));
    case 'dailyPnl':
      return maskCol('dailyPnl', h.dailyPnl == null ? '—' : `<span class="${cls(h.dailyPnl)}">${fmtMoneySigned(h.dailyPnl, cur)}</span>`);
    case 'dailyPnlPct':
      return maskCol('dailyPnlPct', h.dailyPnlPct == null ? '—' : fmtPct(h.dailyPnlPct));
    case 'position': {
      const native = h.marketValueNative != null ? h.marketValueNative : h.marketValue;
      const tip = cur === 'CNY' ? ` title="折合 ${fmtUsd(h.marketValue)}"` : '';
      return maskCol('position', `<span${tip}>${fmtMoney(native, cur)}</span>`);
    }
    case 'weight':
      return maskCol('weight', fmtPct(h.weight));
    case 'target':
      return maskCol('target', `<input class="sm-cell-input" data-meta="target" data-symbol="${h.symbol}" type="number" step="0.001" value="${priceInputValue(h.targetPrice)}" placeholder="—" ${can('meta', 'edit') ? '' : 'readonly'}>`);
    case 'optinfo':
      return maskCol('optinfo', optStr);
    case 'signal':
      return maskCol('signal', `<select class="sm-cell-select" data-meta="signal" data-symbol="${h.symbol}" ${can('meta', 'edit') ? '' : 'disabled'}>${signalOptions(h.signal)}</select>`);
    case 'actions':
      return maskCol('actions', can('row-trade', 'edit') ? `
        <button type="button" class="btn link" data-trade="buy" data-symbol="${h.symbol}">买</button>
        <button type="button" class="btn link" data-trade="sell" data-symbol="${h.symbol}">卖</button>
        <button type="button" class="btn link" data-history="${h.symbol}">记录</button>` : '—');
    default:
      return MASK;
  }
}

function pnlCellClass(key, h) {
  if (key === 'pnl') return cls(h.pnl);
  if (key === 'pnlPct') return cls(h.pnlPct);
  if (key === 'dailyPnl') return cls(h.dailyPnl);
  if (key === 'dailyPnlPct') return cls(h.dailyPnlPct);
  return '';
}

function renderHoldingsRowCells(h, group, i) {
  return visibleHoldingsColumns().map((c) => {
    if (c.key === 'weight') {
      if (i !== 0) return '';
      return `<td rowspan="${group.items.length}" class="sm-weight-cell">${holdingsCellContent(h, 'weight', {})}</td>`;
    }
    const tdCls = pnlCellClass(c.key, h);
    const opt = h.optionInfo;
    const optStr = opt ? `${opt.type} ${formatPrice(opt.strike, 'USD')} · ${opt.expiration}` : '—';
    const lots = h.costLots?.length > 1 ? `<div class="sm-lots-hint">${h.costLots.length} 笔合计</div>` : '';
    const symInner = colVis.symbol !== false && canCol('symbol') ? `
        <span class="sm-symbol-drag" draggable="true" data-drag="${h.symbol}" title="拖动代码到另一行，合并为同一标的">
          <strong>${h.symbol}</strong>
          ${h.groupWith ? `<button type="button" class="btn link sm-clear-group" data-clear-group="${h.symbol}" title="恢复自动分组">↺</button>` : ''}
        </span>` : MASK;
    return `<td${tdCls ? ` class="${tdCls}"` : ''}>${holdingsCellContent(h, c.key, { optStr, lots, symInner })}</td>`;
  }).join('');
}

function renderCashRowCells(cashPct) {
  const cashEq = Number.isFinite(state.summary?.cashUsdEq) ? state.summary.cashUsdEq : state.cash;
  return visibleHoldingsColumns().map((c) => {
    if (c.key === 'type') return `<td>${maskCol('type', '现金')}</td>`;
    if (c.key === 'symbol') return `<td>${maskCol('symbol', 'CASH')}</td>`;
    if (c.key === 'name') return `<td>${maskCol('name', '现金')}</td>`;
    if (c.key === 'position') {
      return `<td>${maskCol('position', `${fmtUsd(state.cashUsd)} · ${fmtCny(state.cashCny)}`)}</td>`;
    }
    if (c.key === 'cost') return `<td>${maskCol('cost', `折合 ${fmtUsd(cashEq)}`)}</td>`;
    if (c.key === 'weight') return `<td>${maskCol('weight', fmtPct(cashPct))}</td>`;
    return `<td>${maskCol(c.key, '—')}</td>`;
  }).join('');
}

function renderHoldings() {
  renderHoldingsHead();
  const cols = visibleHoldingsColumns();
  const groups = buildHoldingsGroups(state.holdings || [], tableSort.key, tableSort.dir);
  let html = '';
  groups.forEach((group, gi) => {
    group.items.forEach((h, i) => {
      const rowCls = [
        gi > 0 && i === 0 ? 'sm-holding-group-start' : '',
        h.type === 'option' ? 'sm-holding-option' : '',
        (h.type === 'ashare' || h.currency === 'CNY') ? 'sm-holding-ashare' : ''
      ].filter(Boolean).join(' ');
      html += `<tr data-symbol="${h.symbol}" class="${rowCls}">${renderHoldingsRowCells(h, group, i)}</tr>`;
    });
  });

  const cashEq = Number.isFinite(state.summary?.cashUsdEq) ? state.summary.cashUsdEq : state.cash;
  const cashPct = state.summary?.totalAssets > 0 ? (cashEq / state.summary.totalAssets * 100) : 0;
  if (can('cash') && state.cashVisible !== false) {
    html += `<tr class="sm-cash-row">${renderCashRowCells(cashPct)}</tr>`;
  }

  const colCount = cols.length || 1;
  $('#holdings-body').innerHTML = html || `<tr><td colspan="${colCount}" class="empty">暂无持仓</td></tr>`;
}

function renderPnlStat(label, val, kind) {
  if (!pnlVisible) {
    return `<div class="sm-stat"><div class="label">${label}</div><div class="value">${MASK}</div></div>`;
  }
  if (kind === 'commission') {
    return `<div class="sm-stat"><div class="label">${label}</div><div class="value neg">${fmtCommission(val)}</div></div>`;
  }
  if (kind === 'signed') {
    return `<div class="sm-stat"><div class="label">${label}</div><div class="value ${cls(val)}">${fmtUsdSigned(val)}</div></div>`;
  }
  return `<div class="sm-stat"><div class="label">${label}</div><div class="value">${fmtUsd(val)}</div></div>`;
}

function renderPnl() {
  const s = state.summary || {};
  $('#pnl-stats').innerHTML = [
    renderPnlStat('买入总额', s.totalBuy, 'money'),
    renderPnlStat('卖出总额', s.totalSell, 'money'),
    renderPnlStat('已实现盈亏', s.realizedPL, 'signed'),
    renderPnlStat('手续费', s.commission, 'commission'),
    renderPnlStat('其它收支', s.otherAmount, 'signed'),
    renderPnlStat('净盈亏', s.netPL, 'signed')
  ].join('');
  const chartEl = $('#pnl-chart');
  if (!pnlVisible) {
    disposePnlChart();
    chartEl.innerHTML = '<p class="hint sm-muted">盈亏数据已隐藏</p>';
    return;
  }
  renderPnlVisualization(chartEl, () => ({
    chartSeries: state.chartSeries || [],
    chartSparse: state.chartSparse || [],
    chartExpandedFull: state.chartExpandedFull || [],
    totalAssets: s.totalAssets || 0,
    pnlStart,
    pnlEnd
  }), {
    onCalendarDay: (d) => openTradeHistoryForRange(d, d),
    onCalendarMonth: (y, mo) => {
      const start = `${y}-${String(mo).padStart(2, '0')}-01`;
      const end = `${y}-${String(mo).padStart(2, '0')}-${String(new Date(y, mo, 0).getDate()).padStart(2, '0')}`;
      openTradeHistoryForRange(start, end);
    }
  });
}

function applyPortfolio(data) {
  state = data;
  renderDashboard();
  renderHoldings();
  renderPnl();
}

async function loadPortfolio() {
  const q = new URLSearchParams();
  if (pnlStart) q.set('start', pnlStart);
  if (pnlEnd) q.set('end', pnlEnd);
  applyPortfolio(await api('/portfolio?' + q.toString()));
}

function closeModal(layerEl) {
  const root = $('#modal-root');
  const target = layerEl || root.querySelector('.sm-modal-backdrop:last-of-type');
  if (!target) return;
  if (target === window._tradeHistoryLayer) {
    window._refreshTradeModal = null;
    window._tradeHistoryLayer = null;
  }
  target.remove();
}

function setModalBusy(layer, busy, label) {
  if (!layer) return;
  layer.dataset.busy = busy ? '1' : '0';
  layer.classList.toggle('is-busy', busy);
  const busyEl = layer.querySelector('.sm-modal-busy');
  const labelEl = layer.querySelector('.sm-modal-busy-label');
  if (labelEl && label) labelEl.textContent = label;
  if (busyEl) busyEl.hidden = !busy;
  layer.querySelectorAll('button').forEach((el) => {
    if (el.closest('.sm-modal-busy')) return;
    if (busy) {
      el.dataset.wasDisabled = el.disabled ? '1' : '0';
      el.disabled = true;
    } else if (el.dataset.wasDisabled != null) {
      el.disabled = el.dataset.wasDisabled === '1';
      delete el.dataset.wasDisabled;
    }
  });
}

function openModal(title, bodyHtml, footHtml, onSubmit, opts = {}) {
  const sizeClass = opts.size === 'trade' ? ' sm-modal--trade'
    : opts.size === 'xl' ? ' sm-modal--xl' : ' sm-modal--wide';
  const bodyClass = opts.size === 'trade' ? ' sm-modal-body--trade' : '';
  const root = $('#modal-root');
  const layer = document.createElement('div');
  layer.className = 'sm-modal-backdrop';
  layer.style.zIndex = String(1100 + root.querySelectorAll('.sm-modal-backdrop').length * 10);
  layer.innerHTML = `
      <div class="sm-modal${sizeClass}" role="dialog" aria-modal="true">
        <div class="sm-modal-head"><h3>${title}</h3><button type="button" class="btn link" data-close>关闭</button></div>
        <div class="sm-modal-body${bodyClass}">${bodyHtml}</div>
        <div class="sm-modal-foot">${footHtml || `
          <button type="button" class="btn ghost" data-close>取消</button>
          <button type="button" class="btn primary" data-modal-save>保存</button>`}</div>
        <div class="sm-modal-busy" hidden>
          <div class="sm-spinner" aria-hidden="true"></div>
          <span class="sm-modal-busy-label">保存中…</span>
        </div>
      </div>`;
  root.appendChild(layer);
  // 必须按下和松开都在遮罩上才关闭；弹窗内按下、外面松开不能关。
  let pointerDownOnBackdrop = false;
  layer.addEventListener('pointerdown', (e) => {
    pointerDownOnBackdrop = e.button === 0 && e.target === layer;
  });
  layer.addEventListener('pointerup', (e) => {
    const shouldClose = pointerDownOnBackdrop && e.button === 0 && e.target === layer && layer.dataset.busy !== '1';
    pointerDownOnBackdrop = false;
    if (shouldClose) closeModal(layer);
  });
  layer.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', () => {
    if (layer.dataset.busy === '1') return;
    closeModal(layer);
  }));
  if (onSubmit) {
    layer.querySelector('[data-modal-save]')?.addEventListener('click', async () => {
      if (layer.dataset.busy === '1') return;
      const form = layer.querySelector('form');
      if (form) layer._formData = new FormData(form);
      setModalBusy(layer, true, opts.busyLabel || '保存中…');
      try {
        const msg = await onSubmit(layer);
        closeModal(layer);
        toastOk(msg || opts.successMessage || '已保存');
        if (opts.reload !== false) await loadPortfolio();
        window._refreshTradeModal?.();
      } catch (err) {
        setModalBusy(layer, false);
        toastErr(err.message);
      }
    });
  }
  return layer;
}

function tradeFormFields(trade = {}) {
  const type = trade.type || trade.prefillType || 'buy';
  const dt = toDatetimeLocalValue(trade.trade_date || Date.now());
  const currency = trade.currency
    || (looksLikeAShare(trade.symbol) ? 'CNY' : 'USD');
  return `
    <form id="trade-form" class="sm-form-grid">
      <label>类型<select name="type" id="trade-type">
        <option value="buy" ${type === 'buy' ? 'selected' : ''}>买入</option>
        <option value="sell" ${type === 'sell' ? 'selected' : ''}>卖出</option>
        <option value="other" ${type === 'other' ? 'selected' : ''}>其它收支</option>
      </select></label>
      <label class="field-other ${type !== 'other' ? 'hidden' : ''}">其它类别<input name="other_category" value="${trade.other_category || ''}"></label>
      <label>代码<input name="symbol" id="trade-symbol" required value="${trade.symbol || ''}"></label>
      <label>名称<input name="name" value="${trade.name || ''}" placeholder="留空自动获取真实名称"></label>
      <label>币种<select name="currency" id="trade-currency">
        <option value="USD" ${currency === 'USD' ? 'selected' : ''}>USD 美元</option>
        <option value="CNY" ${currency === 'CNY' ? 'selected' : ''}>CNY 人民币</option>
      </select></label>
      <label class="field-trade ${type === 'other' ? 'hidden' : ''}">数量<input name="shares" type="number" step="any" value="${trade.shares ?? ''}"></label>
      <label class="field-trade ${type === 'other' ? 'hidden' : ''}">价格<input name="price" type="number" step="0.001" value="${priceInputValue(trade.price)}"></label>
      <label class="field-other-amt ${type !== 'other' ? 'hidden' : ''}">金额<input name="total_amount" type="number" step="any" value="${trade.total_amount ?? ''}"></label>
      <label>手续费<input name="commission" type="number" step="any" value="${trade.commission ?? 0}"></label>
      <label>时间<input name="trade_date" type="datetime-local" value="${dt}"></label>
    </form>`;
}

function bindTradeForm(root) {
  const typeEl = root.querySelector('#trade-type');
  const symbolEl = root.querySelector('#trade-symbol');
  const currencyEl = root.querySelector('#trade-currency');
  if (typeEl) {
    typeEl.addEventListener('change', () => {
      const other = typeEl.value === 'other';
      root.querySelectorAll('.field-other,.field-other-amt').forEach((el) => el.classList.toggle('hidden', !other));
      root.querySelectorAll('.field-trade').forEach((el) => el.classList.toggle('hidden', other));
    });
  }
  if (symbolEl && currencyEl) {
    const syncCurrency = () => {
      if (looksLikeAShare(symbolEl.value)) currencyEl.value = 'CNY';
    };
    symbolEl.addEventListener('input', syncCurrency);
    symbolEl.addEventListener('change', syncCurrency);
  }
}

function formToTrade(fd, existing = {}) {
  const type = fd.get('type');
  return {
    type,
    symbol: String(fd.get('symbol') || '').trim(),
    name: String(fd.get('name') || '').trim(),
    currency: String(fd.get('currency') || 'USD').toUpperCase(),
    commission: Number(fd.get('commission')) || 0,
    trade_date: datetimeLocalToIso(fd.get('trade_date')),
    id: existing.id,
    ...(type === 'other'
      ? { other_category: String(fd.get('other_category') || '').trim(), total_amount: Number(fd.get('total_amount')) }
      : { shares: Number(fd.get('shares')), price: Number(fd.get('price')) })
  };
}

function openTradeModal(trade = {}) {
  const layer = openModal(trade.id ? '编辑交易' : '记一笔', tradeFormFields(trade), null, async (modal) => {
    const form = modal.querySelector('#trade-form');
    const fd = modal._formData || new FormData(form);
    const body = formToTrade(fd, trade);
    const data = trade.id
      ? await api('/trades/' + trade.id + pnlQuery(), { method: 'PUT', body })
      : await api('/trades' + pnlQuery(), { method: 'POST', body });
    applyPortfolio(data);
    return trade.id ? '交易已更新' : '交易已保存';
  }, { reload: false });
  bindTradeForm(layer.querySelector('.sm-modal-body'));
  layer.querySelector('#trade-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    layer.querySelector('[data-modal-save]')?.click();
  });
}

const importState = { buffer: null, count: 0, preview: [], error: null, mode: 'merge' };

function renderImportPreviewSection() {
  if (importState.error) return `<div class="sm-error-box">${importState.error}</div>`;
  if (!importState.count) return '';
  const rows = importState.preview.map((t) => `
    <tr>
      <td>${formatLocalDateTime(t.trade_date)}</td>
      <td>${typeLabel(t)}</td>
      <td>${t.symbol}</td>
      <td>${t.name || ''}</td>
      <td>${t.type === 'other' ? '—' : t.shares}</td>
      <td>${t.type === 'other' ? '—' : formatPrice(t.price, 'USD')}</td>
    </tr>`).join('');
  return `
    <div class="sm-import-preview">
      <div class="sm-import-preview-head">预览（前 5 条，共 ${importState.count} 条）</div>
      <div class="sm-table-wrap">
        <table class="sm-table">
          <thead><tr>
            <th>时间</th><th>类型</th><th>代码</th><th>名称</th><th>数量</th><th>价格</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${importState.count > 5 ? `<p class="hint">... 还有 ${importState.count - 5} 条记录</p>` : ''}
    </div>`;
}

function bindImportModal(layer) {
  $('#import-mode', layer)?.addEventListener('change', (e) => { importState.mode = e.target.value; });
  $('#import-file', layer)?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    importState.buffer = await file.arrayBuffer();
    try {
      const res = await fetch('./api/trades/import/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
        body: importState.buffer
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '解析失败');
      importState.count = data.count;
      importState.preview = data.preview || data.trades || [];
      importState.error = null;
    } catch (err) {
      importState.count = 0;
      importState.preview = [];
      importState.error = err.message;
      toastErr(err.message);
    }
    const area = $('#import-preview-area', layer);
    if (area) area.innerHTML = renderImportPreviewSection();
    const btn = $('#import-confirm', layer);
    if (btn) {
      btn.disabled = importState.count === 0;
      btn.textContent = importState.count > 0 ? `导入 (${importState.count} 条)` : '导入';
    }
  });
}

function openImportModal() {
  importState.buffer = null;
  importState.count = 0;
  importState.preview = [];
  importState.error = null;
  importState.mode = 'merge';
  const layer = openModal('导入交易', `
    <p class="hint">支持 Moomoo 历史 xlsx 或本应用导出的「交易记录」xlsx。选择文件后将显示预览，确认后再导入。</p>
    <form id="import-form" class="sm-form-grid">
      <label>导入模式<select name="mode" id="import-mode">
        <option value="merge">合并到现有记录</option>
        <option value="replace">替换全部记录</option>
      </select></label>
      <label>选择文件<input type="file" id="import-file" class="sm-file-input" accept=".xlsx,.xls"></label>
    </form>
    <div id="import-preview-area"></div>`, `
    <button type="button" class="btn ghost" data-close>取消</button>
    <button type="button" class="btn primary" id="import-confirm" disabled>导入</button>`, null, { size: 'wide' });
  bindImportModal(layer);
  $('#import-confirm', layer)?.addEventListener('click', async () => {
    if (!importState.buffer || !importState.count) return;
    if (layer.dataset.busy === '1') return;
    setModalBusy(layer, true, '导入中…');
    try {
      const res = await fetch('./api/trades/import?mode=' + encodeURIComponent(importState.mode), {
        method: 'POST',
        headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
        body: importState.buffer
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '导入失败');
      closeModal(layer);
      applyPortfolio(data);
      toastOk(`已导入 ${importState.count} 条交易`);
      window._refreshTradeModal?.();
    } catch (err) {
      setModalBusy(layer, false);
      toastErr(err.message);
    }
  });
}

function filteredTrades() {
  const f = ui.tradeFilter;
  return [...(state.trades || [])].filter((t) => {
    if (f.symbol && !t.symbol.toUpperCase().includes(f.symbol.toUpperCase())) return false;
    if (f.type !== 'all' && t.type !== f.type) return false;
    if (f.assetType !== 'all' && tradeAssetType(t) !== f.assetType) return false;
    if (f.otherCategory && t.type === 'other' && !(t.other_category || '').includes(f.otherCategory)) return false;
    const d = localDateKey(t.trade_date);
    if (f.start && d < f.start) return false;
    if (f.end && d > f.end) return false;
    return true;
  }).sort((a, b) => new Date(b.trade_date) - new Date(a.trade_date));
}

function renderTradeFilters(summary = false) {
  const activeCount = activeTradeFilterCount(summary);
  return `<div class="sm-trade-filters ${ui.tradeFilterOpen ? 'is-open' : ''}">
      <button type="button" class="btn ghost sm-btn-sm sm-trade-filter-toggle" data-filter-toggle aria-expanded="${ui.tradeFilterOpen ? 'true' : 'false'}">筛选条件${activeCount ? `（${activeCount}）` : ''}</button>
      <div class="sm-trade-filter-fields">
      <input placeholder="代码" data-filter="symbol" value="${escapeHtml(ui.tradeFilter.symbol)}">
      ${summary ? '' : `<select data-filter="type" aria-label="交易方向">
        <option value="all">全部方向</option>
        <option value="buy" ${ui.tradeFilter.type === 'buy' ? 'selected' : ''}>买入</option>
        <option value="sell" ${ui.tradeFilter.type === 'sell' ? 'selected' : ''}>卖出</option>
        <option value="other" ${ui.tradeFilter.type === 'other' ? 'selected' : ''}>其它</option>
      </select>`}
      <select data-filter="assetType" aria-label="证券类型">
        <option value="all">全部证券类型</option>
        ${Object.entries(TRADE_ASSET_TYPES).map(([key, label]) => `<option value="${key}" ${ui.tradeFilter.assetType === key ? 'selected' : ''}>${label}</option>`).join('')}
      </select>
      <input placeholder="其它类别" data-filter="otherCategory" value="${escapeHtml(ui.tradeFilter.otherCategory)}">
      <input type="date" data-filter="start" value="${ui.tradeFilter.start}">
      <span class="sm-muted">至</span>
      <input type="date" data-filter="end" value="${ui.tradeFilter.end}">
      <button type="button" class="btn ghost sm-btn-sm" id="filter-reset">重置</button>
      </div>
    </div>`;
}

function activeTradeFilterCount(summary = ui.tradeTab === 'summary') {
  return Object.entries(ui.tradeFilter)
    .filter(([key]) => key !== 'type' || !summary)
    .filter(([, value]) => value && value !== 'all').length;
}

function updateTradeFilterToggle(root) {
  const button = root.querySelector('[data-filter-toggle]');
  if (!button) return;
  const count = activeTradeFilterCount();
  button.textContent = `筛选条件${count ? `（${count}）` : ''}`;
}

function renderTradeListTab() {
  const all = filteredTrades();
  const total = all.length;
  const pages = Math.max(1, Math.ceil(total / ui.tradePageSize));
  ui.tradePage = Math.min(ui.tradePage, pages);
  const start = (ui.tradePage - 1) * ui.tradePageSize;
  const pageRows = all.slice(start, start + ui.tradePageSize);

  let pageBtns = '';
  for (let p = 1; p <= pages && p <= 7; p++) {
    pageBtns += `<button type="button" class="btn ghost sm-btn-sm ${p === ui.tradePage ? 'active' : ''}" data-page="${p}">${p}</button>`;
  }

  return `
    ${renderTradeFilters()}
    <div class="sm-trade-modal-scroll">
      <div class="sm-table-wrap sm-table-wrap--modal">
        <table class="sm-table">
          <thead><tr>
            <th>时间</th><th>交易方向</th><th>类型</th><th>代码</th><th class="sm-trade-name">名称</th><th>币种</th><th>股数</th><th>价格</th><th>金额</th><th>手续费</th><th>操作</th>
          </tr></thead>
          <tbody>${pageRows.length ? pageRows.map((t) => `
            <tr>
              <td data-label="时间">${formatLocalDateTime(t.trade_date)}</td>
              <td data-label="交易方向">${typeLabel(t)}</td>
              <td data-label="类型">${TRADE_ASSET_TYPES[tradeAssetType(t)]}</td>
              <td data-label="代码">${escapeHtml(t.symbol)}</td>
              <td data-label="名称" class="sm-trade-name">${escapeHtml(t.name || '')}</td>
              <td data-label="币种">${escapeHtml(t.currency || (looksLikeAShare(t.symbol) ? 'CNY' : 'USD'))}</td>
              <td data-label="股数">${t.type === 'other' ? '—' : t.shares}</td>
              <td data-label="价格">${t.type === 'other' ? '—' : formatPrice(t.price, t.currency || (looksLikeAShare(t.symbol) ? 'CNY' : 'USD'))}</td>
              <td data-label="金额">${fmtMoney(t.total_amount, t.currency || (looksLikeAShare(t.symbol) ? 'CNY' : 'USD'))}</td>
              <td data-label="手续费">${fmtCommission(t.commission, t.currency || (looksLikeAShare(t.symbol) ? 'CNY' : 'USD'))}</td>
              <td data-label="操作">${can('trade', 'edit') ? `
                <button type="button" class="btn link" data-edit="${t.id}">编辑</button>
                <button type="button" class="btn link" data-del="${t.id}">删除</button>` : '—'}
              </td>
            </tr>`).join('') : `<tr><td colspan="11" class="empty">暂无记录</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
    <div class="sm-pagination">
      <button type="button" class="btn ghost sm-btn-sm" data-page="prev" ${ui.tradePage <= 1 ? 'disabled' : ''}>上一页</button>
      ${pageBtns}
      <button type="button" class="btn ghost sm-btn-sm" data-page="next" ${ui.tradePage >= pages ? 'disabled' : ''}>下一页</button>
      <select id="page-size">
        ${[10, 20, 50, 100].map((n) => `<option value="${n}" ${ui.tradePageSize === n ? 'selected' : ''}>${n} 条/页</option>`).join('')}
      </select>
      <span class="sm-muted">共 ${total} 条</span>
    </div>`;
}

async function renderTradeSummaryTab() {
  const q = new URLSearchParams();
  if (ui.tradeFilter.start) q.set('start', ui.tradeFilter.start);
  if (ui.tradeFilter.end) q.set('end', ui.tradeFilter.end);
  if (ui.tradeFilter.assetType !== 'all') q.set('assetType', ui.tradeFilter.assetType);
  if (ui.tradeFilter.symbol) q.set('symbol', ui.tradeFilter.symbol);
  if (ui.tradeFilter.otherCategory) q.set('otherCategory', ui.tradeFilter.otherCategory);
  const rows = await api('/trades/summary?' + q.toString());
  const summarySort = ui.tradeSummarySort;
  if (summarySort.key) {
    rows.sort((a, b) => {
      const av = a[summarySort.key];
      const bv = b[summarySort.key];
      const aMissing = av == null || !Number.isFinite(av);
      const bMissing = bv == null || !Number.isFinite(bv);
      if (aMissing !== bMissing) return aMissing ? 1 : -1;
      return (aMissing ? 0 : (av - bv) * summarySort.dir) || a.symbol.localeCompare(b.symbol);
    });
  }
  const totals = rows.reduce((a, r) => ({
    buy: a.buy + r.totalBuyAmount, sell: a.sell + r.totalSellAmount,
    fee: a.fee + r.totalCommission, pnl: a.pnl + r.netPnl, other: a.other + (r.otherAmount || 0)
  }), { buy: 0, sell: 0, fee: 0, pnl: 0, other: 0 });

  return `
    ${renderTradeFilters(true)}
    <div class="sm-trade-modal-scroll">
      <div class="sm-table-wrap sm-table-wrap--modal">
        <table class="sm-table">
          <thead><tr>
            <th>类型</th><th>代码</th><th class="sm-trade-name">名称</th><th>总买入</th><th>总卖出</th><th>其它收支</th><th>总费用</th>
            ${[['netPnl', '盈亏金额'], ['netPnlRate', '盈亏比例']].map(([key, label]) => `<th aria-sort="${summarySort.key === key ? (summarySort.dir === 1 ? 'ascending' : 'descending') : 'none'}"><button type="button" class="btn link" data-summary-sort="${key}" title="点击切换升序或降序">${label}${sortMark(summarySort, key)}</button></th>`).join('')}
          </tr></thead>
          <tbody>${rows.length ? rows.map((r) => `
            <tr>
              <td data-label="类型">${TRADE_ASSET_TYPES[r.assetType || tradeAssetType(r)]}</td><td data-label="代码">${escapeHtml(r.symbol)}</td><td data-label="名称" class="sm-trade-name">${escapeHtml(r.name || '—')}</td><td data-label="总买入">${fmtUsd(r.totalBuyAmount)}</td><td data-label="总卖出">${fmtUsd(r.totalSellAmount)}</td>
              <td data-label="其它收支">${r.assetType === 'other' ? maskPnlValue(fmtUsdSigned(r.otherAmount)) : '—'}</td><td data-label="总费用">${fmtCommission(r.totalCommission)}</td><td data-label="盈亏金额" class="${cls(r.netPnl)}">${maskPnlValue(fmtUsdSigned(r.netPnl))}</td>
              <td data-label="盈亏比例" title="${r.assetType === 'other' ? '其它收支没有买入成本，不计算盈亏比例' : r.pnlRateUnavailableReason === 'missing-buy-cost' ? '卖出数量缺少对应买入记录，无法确定完整成本' : r.pnlRateUnavailableReason === 'no-sold-cost' ? '尚无可计算比例的卖出成本' : '净盈亏 ÷ 按 FIFO 匹配的卖出部分买入成本'}">${r.netPnlRate == null ? '—' : maskPnlValue(fmtPct(r.netPnlRate))}</td>
            </tr>`).join('') : `<tr><td colspan="9" class="empty">暂无数据</td></tr>`}
          <tr class="sm-total-row">
            <td data-label="汇总">合计</td><td data-label="代码">—</td><td data-label="名称">—</td><td data-label="总买入">${fmtUsd(totals.buy)}</td><td data-label="总卖出">${fmtUsd(totals.sell)}</td>
            <td data-label="其它收支">${maskPnlValue(fmtUsdSigned(totals.other))}</td><td data-label="总费用">${fmtCommission(totals.fee)}</td><td data-label="盈亏金额" class="${cls(totals.pnl)}">${maskPnlValue(fmtUsdSigned(totals.pnl))}</td><td data-label="盈亏比例">—</td>
          </tr></tbody>
        </table>
      </div>
      <p class="hint">其它收支按代码和类别汇总，收入为正、支出为负，扣除手续费后计入净盈亏；金额统一折算为美元。股票和期权盈亏按 FIFO 计算。盈亏比例 = 净盈亏 ÷ 卖出部分的买入成本（可匹配区间前买入）；净盈亏扣除查询区间内手续费。无卖出成本或缺少买入记录时显示「—」。</p>
    </div>`;
}

async function renderTradeModalBody() {
  const tabs = `
    <div class="sm-tabs">
      <button type="button" class="sm-tab ${ui.tradeTab === 'list' ? 'active' : ''}" data-tab="list">明细</button>
      <button type="button" class="sm-tab ${ui.tradeTab === 'summary' ? 'active' : ''}" data-tab="summary">盈亏汇总</button>
    </div>
    <div class="sm-modal-toolbar">
      ${can('trade', 'edit') ? '<button type="button" class="btn ghost sm-btn-sm" id="modal-add-other">＋ 其它收支</button>' : ''}
      ${can('import', 'edit') ? '<button type="button" class="btn ghost sm-btn-sm" id="modal-import">导入</button>' : ''}
      ${can('export') ? '<button type="button" class="btn ghost sm-btn-sm" id="modal-export">导出 xlsx</button>' : ''}
    </div>`;
  const content = ui.tradeTab === 'summary' ? await renderTradeSummaryTab() : renderTradeListTab();
  return `<div class="sm-trade-modal-content">${tabs}${content}</div>`;
}

async function openTradeHistoryModal(symbol = '') {
  if (symbol) ui.tradeFilter.symbol = symbol;
  ui.tradeFilterOpen = false;
  ui.tradePage = 1;
  const layer = openModal('交易记录', '<div id="trade-modal-content">加载中…</div>', '<button type="button" class="btn ghost" data-close>关闭</button>', null, { size: 'trade' });
  let refreshRevision = 0;
  const refresh = async () => {
    const revision = ++refreshRevision;
    const box = $('#trade-modal-content', layer);
    if (!box) return;
    const html = await renderTradeModalBody();
    if (revision !== refreshRevision || !box.isConnected) return;
    if ($('[data-tab].active', box)?.dataset.tab === ui.tradeTab) {
      const template = document.createElement('template');
      template.innerHTML = html;
      // Keep filter nodes in place so typing, selection and IME composition survive.
      for (const selector of ['.sm-trade-modal-scroll', '.sm-pagination']) {
        const current = $(selector, box);
        const next = $(selector, template.content);
        if (current && next) current.replaceWith(next);
      }
      box.querySelectorAll('[data-filter]').forEach((el) => {
        const value = ui.tradeFilter[el.dataset.filter];
        if (el.value !== value) el.value = value;
      });
    } else {
      box.innerHTML = html;
    }
    bindTradeModalEvents(layer);
  };
  window._tradeHistoryLayer = layer;
  window._refreshTradeModal = refresh;
  await refresh();
}

function openTradeHistoryForRange(start, end) {
  ui.tradeFilter = { symbol: '', type: 'all', assetType: 'all', otherCategory: '', start, end };
  ui.tradePage = 1;
  openTradeHistoryModal();
}

function bindTradeModalEvents(layer) {
  const root = $('#trade-modal-content', layer);
  if (!root) return;
  const unbound = (selector) => [...root.querySelectorAll(selector)].filter((el) => {
    if (el.dataset.tradeBound) return false;
    el.dataset.tradeBound = '1';
    return true;
  });
  unbound('[data-filter-toggle]').forEach((button) => button.addEventListener('click', () => {
    ui.tradeFilterOpen = !ui.tradeFilterOpen;
    const filters = button.closest('.sm-trade-filters');
    filters?.classList.toggle('is-open', ui.tradeFilterOpen);
    button.setAttribute('aria-expanded', ui.tradeFilterOpen ? 'true' : 'false');
  }));
  unbound('[data-summary-sort]').forEach((button) => button.addEventListener('click', async () => {
    const key = button.dataset.summarySort;
    ui.tradeSummarySort = { key, dir: ui.tradeSummarySort.key === key ? -ui.tradeSummarySort.dir : -1 };
    await window._refreshTradeModal?.();
  }));
  unbound('[data-tab]').forEach((btn) => btn.addEventListener('click', async () => {
    ui.tradeTab = btn.dataset.tab;
    await window._refreshTradeModal?.();
  }));
  unbound('[data-filter]').forEach((el) => {
    el.addEventListener('change', () => {
      ui.tradeFilter[el.dataset.filter] = el.value;
      updateTradeFilterToggle(root);
      ui.tradePage = 1;
      window._refreshTradeModal?.();
    });
    el.addEventListener('input', () => {
      ui.tradeFilter[el.dataset.filter] = el.value;
      updateTradeFilterToggle(root);
      if (el.dataset.filter === 'symbol' || el.dataset.filter === 'otherCategory') {
        clearTimeout(el._debounce);
        el._debounce = setTimeout(() => {
          ui.tradePage = 1;
          window._refreshTradeModal?.();
        }, 320);
      }
    });
  });
  unbound('#filter-reset')[0]?.addEventListener('click', () => {
    ui.tradeFilter = { symbol: '', type: 'all', assetType: 'all', otherCategory: '', start: '', end: '' };
    updateTradeFilterToggle(root);
    ui.tradePage = 1;
    window._refreshTradeModal?.();
  });
  unbound('[data-page]').forEach((btn) => btn.addEventListener('click', () => {
    const v = btn.dataset.page;
    const all = filteredTrades();
    const pages = Math.max(1, Math.ceil(all.length / ui.tradePageSize));
    if (v === 'prev') ui.tradePage = Math.max(1, ui.tradePage - 1);
    else if (v === 'next') ui.tradePage = Math.min(pages, ui.tradePage + 1);
    else ui.tradePage = Number(v);
    window._refreshTradeModal?.();
  }));
  unbound('#page-size')[0]?.addEventListener('change', (e) => {
    ui.tradePageSize = Number(e.target.value);
    ui.tradePage = 1;
    window._refreshTradeModal?.();
  });
  unbound('[data-edit]').forEach((btn) => btn.addEventListener('click', () => {
    const trade = state.trades.find((t) => t.id === btn.dataset.edit);
    if (trade) openTradeModal(trade);
  }));
  unbound('[data-del]').forEach((btn) => btn.addEventListener('click', async () => {
    const ok = window.portalDialog?.confirm
      ? await window.portalDialog.confirm('确定删除这条交易记录？', { title: '删除确认', danger: true, okText: '删除' })
      : confirm('确定删除？');
    if (!ok) return;
    try {
      applyPortfolio(await api('/trades/' + btn.dataset.del + pnlQuery(), { method: 'DELETE' }));
      toastOk('已删除');
      window._refreshTradeModal?.();
    } catch (err) {
      toastErr(err.message);
    }
  }));
  unbound('#modal-add-other')[0]?.addEventListener('click', () => { openTradeModal({ type: 'other' }); });
  unbound('#modal-import')[0]?.addEventListener('click', () => { openImportModal(); });
  unbound('#modal-export')[0]?.addEventListener('click', () => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(ui.tradeFilter)) {
      if (ui.tradeTab === 'summary' && k === 'type') continue;
      if (v && v !== 'all') q.set(k, v);
    }
    window.open('./api/trades/export?' + q.toString(), '_blank');
    toastInfo('正在导出交易记录');
  });
}

async function saveMeta(symbol, patch) {
  if (!can('meta', 'edit')) throw new Error('无权修改');
  applyPortfolio(await api('/holdings-meta/' + encodeURIComponent(symbol) + pnlQuery(), { method: 'PUT', body: patch }));
}

function applyLayoutPrefs() {
  fullWidth = loadJson(LS_FULL_WIDTH, false);
  $('#app').classList.toggle('sm-app--full', fullWidth);
}

// Event bindings
applyLayoutPrefs();

window.addEventListener('portal-layout-change', () => applyLayoutPrefs());
window.addEventListener('storage', (e) => {
  if (e.key === LS_FULL_WIDTH) applyLayoutPrefs();
});

$('#toggle-dashboard').addEventListener('change', (e) => {
  dashboardVisible = e.target.checked;
  schedulePrefsSave({ dashboardVisible });
  renderDashboard();
});

$('#toggle-pnl-visible').addEventListener('change', (e) => {
  pnlVisible = e.target.checked;
  schedulePrefsSave({ pnlVisible });
  renderDashboard();
  renderPnl();
});

$('#btn-col-toggle').addEventListener('click', () => {
  if (!can('columns')) return;
  renderColToggle();
  $('#col-toggle-panel').classList.toggle('hidden');
});

$('#col-toggle-panel').addEventListener('change', (e) => {
  const col = e.target.dataset?.col;
  if (!col) return;
  colVis[col] = e.target.checked;
  schedulePrefsSave({ colVis });
  renderHoldings();
});

async function refreshQuotes(symbol) {
  if (quotesRefreshBusy || !can('refresh', 'edit')) return;
  quotesRefreshBusy = true;
  const btn = $('#btn-refresh');
  const rowBtns = [...document.querySelectorAll('[data-refresh]')];
  if (btn) btn.disabled = true;
  rowBtns.forEach((el) => { el.disabled = true; });
  try {
    const body = symbol ? { symbol } : undefined;
    const data = await api('/quotes/refresh' + pnlQuery(), { method: 'POST', body });
    applyPortfolio(data);
    const r = data.refresh;
    if (r?.failed) {
      const msg = r.errors.slice(0, 5).map((e) => `${e.symbol}: ${e.error}`).join(' · ');
      toastRefresh('warn', `已刷新 ${r.ok} 个，失败 ${r.failed} 个：${msg}`);
    } else if (r?.ok) {
      toastRefresh('success', symbol ? `已刷新 ${symbol} 报价` : `已刷新 ${r.ok} 个报价`);
    }
  } catch (e) {
    toastRefresh('error', e.message);
  } finally {
    quotesRefreshBusy = false;
    if (btn) btn.disabled = false;
    rowBtns.forEach((el) => { el.disabled = false; });
  }
}

$('#btn-refresh').addEventListener('click', () => refreshQuotes());

$('#btn-add').addEventListener('click', () => openTradeModal());
$('#btn-import').addEventListener('click', openImportModal);
$('#btn-trades').addEventListener('click', () => openTradeHistoryModal());

$('#pnl-start').addEventListener('change', (e) => { pnlStart = e.target.value; });
$('#pnl-end').addEventListener('change', (e) => { pnlEnd = e.target.value; });
$('#btn-pnl-query').addEventListener('click', () => {
  loadPortfolio()
    .then(() => toastOk('查询完成'))
    .catch((e) => toastErr(e.message));
});
$('#btn-pnl-reset').addEventListener('click', () => {
  pnlStart = pnlEnd = '';
  $('#pnl-start').value = $('#pnl-end').value = '';
  loadPortfolio()
    .then(() => toastOk('已重置查询区间'))
    .catch((e) => toastErr(e.message));
});

$('#holdings-head').addEventListener('click', (e) => {
  const key = e.target.closest('[data-sort]')?.dataset.sort;
  if (!key) return;
  tableSort = toggleTableSort(tableSort, key);
  saveJson(LS_TABLE_SORT, tableSort);
  renderHoldings();
});

$('#holdings-body').addEventListener('dragstart', (e) => {
  const el = e.target.closest('[data-drag]');
  if (!el) return;
  dragSourceSymbol = el.dataset.drag;
  e.dataTransfer?.setData('text/plain', dragSourceSymbol);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
});

$('#holdings-body').addEventListener('dragover', (e) => {
  if (e.target.closest('[data-drag]')) {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  }
});

$('#holdings-body').addEventListener('dragend', () => { dragSourceSymbol = null; });

$('#holdings-body').addEventListener('drop', async (e) => {
  if (!can('meta', 'edit')) return;
  const targetEl = e.target.closest('[data-drag]');
  if (!targetEl) return;
  e.preventDefault();
  const src = (e.dataTransfer?.getData('text/plain') || dragSourceSymbol || '').trim();
  const dst = targetEl.dataset.drag;
  if (!src || !dst || src === dst) return;
  const anchor = state.holdings.find((h) => h.symbol === dst);
  if (!anchor) return;
  try {
    await saveMeta(src, { groupWith: effectiveGroupKey(anchor) });
    toastOk('已合并为同一标的');
  } catch (err) {
    toastErr(err.message);
  }
});

$('#holdings-body').addEventListener('click', async (e) => {
  const clearSym = e.target.closest('[data-clear-group]')?.dataset.clearGroup;
  if (clearSym) {
    if (!can('meta', 'edit')) return;
    try {
      await saveMeta(clearSym, { groupWith: '' });
      toastOk('已恢复自动分组');
    } catch (err) { toastErr(err.message); }
    return;
  }
  const sym = e.target.closest('[data-refresh]')?.dataset.refresh;
  if (sym) {
    await refreshQuotes(sym);
    return;
  }
  const tradeType = e.target.closest('[data-trade]')?.dataset.trade;
  const tradeSym = e.target.closest('[data-trade]')?.dataset.symbol;
  if (tradeType && tradeSym) {
    openTradeModal({ prefillType: tradeType, symbol: tradeSym, name: state.holdings.find((h) => h.symbol === tradeSym)?.name || '' });
    return;
  }
  const histSym = e.target.closest('[data-history]')?.dataset.history;
  if (histSym) openTradeHistoryModal(histSym);
});

$('#holdings-body').addEventListener('change', async (e) => {
  const el = e.target.closest('[data-meta]');
  if (!el || !can('meta', 'edit')) return;
  const symbol = el.dataset.symbol;
  const field = el.dataset.meta;
  const body = (field === 'target' || field === 'targetPrice')
    ? { targetPrice: el.value === '' ? '' : Number(el.value) }
    : { signal: el.value };
  try {
    await saveMeta(symbol, body);
    toastOk('已保存');
  } catch (err) {
    toastErr(err.message);
  }
});

async function init() {
  await loadPortalContext();
  applyPortalPrefs();
  applyPermissions();
  applyDipTabs();
  renderColToggle();
  $('#toggle-dashboard').checked = dashboardVisible;
  $('#toggle-pnl-visible').checked = pnlVisible;
  try {
    await loadPortfolio();
  } catch (e) {
    toastErr(`加载失败: ${e.message}`);
    document.body.innerHTML = `<p class="sm-error">加载失败: ${e.message}</p>`;
  }
}

init().catch((error) => { toastErr(`加载失败: ${error.message}`); }).finally(() => window.navigationSkeleton?.finish());
