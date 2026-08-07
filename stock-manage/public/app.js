import { HOLDINGS_COLUMNS, LS_COL_VIS, LS_DASHBOARD, LS_FULL_WIDTH, LS_TABLE_SORT, loadJson, saveJson, defaultColVis, defaultTableSort } from './js/constants.js';
import { renderPnlVisualization } from './js/pnl-viz.js';
import { buildHoldingsGroups, toggleTableSort, sortMark, effectiveGroupKey } from './js/holdings-table.js';

const $ = (sel, root = document) => root.querySelector(sel);
const fmt = (n) => Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
const fmtUsd = (n) => Number.isFinite(n) ? '$' + fmt(n) : '—';
const fmtUsdSigned = (n) => !Number.isFinite(n) ? '—' : `${n >= 0 ? '+' : ''}$${fmt(n)}`;
const fmtCommission = (n) => Number.isFinite(n) && n > 0 ? '-$' + fmt(n) : '—';
const fmtPct = (n) => Number.isFinite(n) ? n.toFixed(2) + '%' : '—';
const cls = (n) => n > 0 ? 'pos' : n < 0 ? 'neg' : '';
const MASK = '<span class="sm-mask">—</span>';

const toastErr = (msg) => window.portalToast?.error(msg) ?? window.alert(msg);
const toastWarn = (msg) => window.portalToast?.warn(msg) ?? window.alert(msg);
const toastOk = (msg) => window.portalToast?.success(msg) ?? window.alert(msg);

let state = { cash: 0, trades: [], holdings: [], summary: {}, chartSeries: [], chartSparse: [], chartExpandedFull: [], holdingsMeta: {} };
let colVis = loadJson(LS_COL_VIS, defaultColVis());
let dashboardVisible = loadJson(LS_DASHBOARD, true);
let fullWidth = loadJson(LS_FULL_WIDTH, false);
let tableSort = loadJson(LS_TABLE_SORT, defaultTableSort());
let dragSourceSymbol = null;
let pnlStart = '';
let pnlEnd = '';

const ui = {
  tradeTab: 'list',
  tradePage: 1,
  tradePageSize: 10,
  tradeFilter: { symbol: '', type: 'all', otherCategory: '', start: '', end: '' }
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

function mask(key, html) {
  return colVis[key] !== false ? html : MASK;
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
  const show = dashboardVisible;
  $('#toggle-dashboard').checked = show;
  if (!show) { el.innerHTML = ''; el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const s = state.summary || {};
  const cashPct = s.totalAssets > 0 ? (state.cash / s.totalAssets * 100) : 0;
  const dailyVal = s.dailyTotalPnl;
  const dailyHint = dailyVal == null
    ? '刷新行情后显示持仓涨跌'
    : (s.tradeDailyPnl != null && s.tradeDailyPnl !== 0
      ? `持仓 ${fmtUsd(s.marketDailyPnl)} + 交易 ${fmtUsd(s.tradeDailyPnl)}`
      : '持仓当日涨跌合计');
  el.innerHTML = `
    <div class="sm-summary-grid">
      <div class="sm-summary-card sm-summary-card--accent">
        <div class="label">总资产</div>
        <div class="value">${fmtUsd(s.totalAssets)}</div>
      </div>
      <div class="sm-summary-card">
        <div class="label">股票市值</div>
        <div class="value">${fmtUsd(s.stockMv)}</div>
      </div>
      <div class="sm-summary-card">
        <div class="label">期权市值</div>
        <div class="value">${fmtUsd(s.optionMv)}</div>
      </div>
      <div class="sm-summary-card sm-summary-card--green">
        <div class="label">总盈亏</div>
        <div class="value ${cls(s.totalPnl)}">${fmtUsdSigned(s.totalPnl)}</div>
        <div class="hint">未实现盈亏合计</div>
      </div>
      <div class="sm-summary-card sm-summary-card--amber">
        <div class="label">当日总盈亏</div>
        <div class="value ${dailyVal == null ? '' : cls(dailyVal)}">${dailyVal == null ? '—' : fmtUsdSigned(dailyVal)}</div>
        <div class="hint">${dailyHint}</div>
      </div>
      <div class="sm-summary-card sm-summary-card--cash">
        <div class="label">现金</div>
        <div class="sm-cash-input-wrap">
          <span>$</span>
          <input type="number" step="0.01" id="cash-input" value="${state.cash}">
        </div>
        <div class="hint">占组合 ${fmtPct(cashPct)}</div>
      </div>
    </div>`;
  $('#cash-input')?.addEventListener('change', async (e) => {
    try {
      applyPortfolio(await api('/cash', { method: 'PUT', body: { cash: Number(e.target.value) } }));
    } catch (err) { toastErr(err.message); }
  });
}

function renderColToggle() {
  $('#col-toggle-panel').innerHTML = HOLDINGS_COLUMNS.map((c) => `
    <label class="sm-col-check"><input type="checkbox" data-col="${c.key}" ${colVis[c.key] !== false ? 'checked' : ''}> ${c.label}</label>
  `).join('');
}

function renderHoldingsHead() {
  $('#holdings-head').innerHTML = `<tr>${HOLDINGS_COLUMNS.map((c) => {
    if (c.key === 'symbol') {
      return `<th class="sm-sort-th" data-sort="symbol" title="按标的代码排序">代码${sortMark(tableSort, 'symbol')}</th>`;
    }
    if (c.key === 'weight') {
      return `<th class="sm-sort-th" data-sort="weight" title="按同标的合计占总资产比例排序">仓位 / 占比${sortMark(tableSort, 'weight')}</th>`;
    }
    return `<th>${c.label}</th>`;
  }).join('')}</tr>`;
}

function renderHoldings() {
  renderHoldingsHead();
  const groups = buildHoldingsGroups(state.holdings || [], tableSort.key, tableSort.dir);
  let html = '';
  groups.forEach((group, gi) => {
    group.items.forEach((h, i) => {
      const opt = h.optionInfo;
      const optStr = opt ? `${opt.type} $${opt.strike} · ${opt.expiration}` : '—';
      const lots = h.costLots?.length > 1 ? `<div class="sm-lots-hint">${h.costLots.length} 笔合计</div>` : '';
      const rowCls = [
        gi > 0 && i === 0 ? 'sm-holding-group-start' : '',
        h.type === 'option' ? 'sm-holding-option' : ''
      ].filter(Boolean).join(' ');
      const symInner = colVis.symbol !== false ? `
        <span class="sm-symbol-drag" draggable="true" data-drag="${h.symbol}" title="拖动代码到另一行，合并为同一标的">
          <strong>${h.symbol}</strong>
          ${h.groupWith ? `<button type="button" class="btn link sm-clear-group" data-clear-group="${h.symbol}" title="恢复自动分组">↺</button>` : ''}
        </span>` : MASK;
      const weightCell = i === 0
        ? `<td rowspan="${group.items.length}" class="sm-weight-cell">${mask('weight', fmtPct(h.weight))}</td>`
        : '';
      html += `<tr data-symbol="${h.symbol}" class="${rowCls}">
      <td>${mask('type', h.type === 'option' ? '期权' : '股票')}</td>
      <td>${mask('symbol', symInner)}</td>
      <td>${mask('shares', h.shares)}</td>
      <td>${mask('cost', fmtUsd(h.avgCost) + lots)}</td>
      <td>${mask('price', `<span>${fmtUsd(h.price)}</span> <button type="button" class="btn link" data-refresh="${h.symbol}">↻</button>`)}</td>
      <td class="${cls(h.pnl)}">${mask('pnl', h.pnl == null ? '—' : fmtUsdSigned(h.pnl))}</td>
      <td class="${cls(h.pnlPct)}">${mask('pnlPct', h.pnlPct == null ? '—' : fmtPct(h.pnlPct))}</td>
      <td class="${cls(h.dailyPnl)}">${mask('dailyPnl', h.dailyPnl == null ? '—' : fmtUsdSigned(h.dailyPnl))}</td>
      <td class="${cls(h.dailyPnlPct)}">${mask('dailyPnlPct', h.dailyPnlPct == null ? '—' : fmtPct(h.dailyPnlPct))}</td>
      <td>${mask('position', fmtUsd(h.marketValue))}</td>
      ${weightCell}
      <td>${mask('target', `<input class="sm-cell-input" data-meta="target" data-symbol="${h.symbol}" type="number" step="any" value="${h.targetPrice ?? ''}" placeholder="—">`)}</td>
      <td>${mask('optinfo', optStr)}</td>
      <td>${mask('signal', `<select class="sm-cell-select" data-meta="signal" data-symbol="${h.symbol}">${signalOptions(h.signal)}</select>`)}</td>
      <td>${mask('actions', `
        <button type="button" class="btn link" data-trade="buy" data-symbol="${h.symbol}">买</button>
        <button type="button" class="btn link" data-trade="sell" data-symbol="${h.symbol}">卖</button>
        <button type="button" class="btn link" data-history="${h.symbol}">记录</button>`)}</td>
    </tr>`;
    });
  });

  const cashPct = state.summary?.totalAssets > 0 ? (state.cash / state.summary.totalAssets * 100) : 0;
  html += `<tr class="sm-cash-row">
    <td>${mask('type', '现金')}</td>
    <td>${mask('symbol', 'CASH')}</td>
    <td colspan="7">${mask('shares', '—')}</td>
    <td>${mask('position', fmtUsd(state.cash))}</td>
    <td>${mask('weight', fmtPct(cashPct))}</td>
    <td colspan="4"></td>
  </tr>`;

  $('#holdings-body').innerHTML = html || `<tr><td colspan="${HOLDINGS_COLUMNS.length}" class="empty">暂无持仓</td></tr>`;
}

function renderPnlStat(label, val, kind) {
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
  renderPnlVisualization($('#pnl-chart'), () => ({
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

function closeModal() { $('#modal-root').innerHTML = ''; }

function openModal(title, bodyHtml, footHtml, onSubmit, opts = {}) {
  const sizeClass = opts.size === 'trade' ? ' sm-modal--trade'
    : opts.size === 'xl' ? ' sm-modal--xl' : ' sm-modal--wide';
  const bodyClass = opts.size === 'trade' ? ' sm-modal-body--trade' : '';
  const root = $('#modal-root');
  root.innerHTML = `
    <div class="sm-modal-backdrop">
      <div class="sm-modal${sizeClass}" role="dialog">
        <div class="sm-modal-head"><h3>${title}</h3><button type="button" class="btn link" data-close>关闭</button></div>
        <div class="sm-modal-body${bodyClass}" id="modal-body">${bodyHtml}</div>
        <div class="sm-modal-foot">${footHtml || `
          <button type="button" class="btn ghost" data-close>取消</button>
          <button type="button" class="btn primary" id="modal-save">保存</button>`}</div>
      </div>
    </div>`;
  const backdrop = root.querySelector('.sm-modal-backdrop');
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });
  root.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', closeModal));
  if (onSubmit) {
    $('#modal-save')?.addEventListener('click', async () => {
      try { await onSubmit(); closeModal(); await loadPortfolio(); }
      catch (err) { toastErr(err.message); }
    });
  }
}

function tradeFormFields(trade = {}) {
  const type = trade.type || trade.prefillType || 'buy';
  const dt = (trade.trade_date || new Date().toISOString()).slice(0, 16);
  return `
    <form id="trade-form" class="sm-form-grid">
      <label>类型<select name="type" id="trade-type">
        <option value="buy" ${type === 'buy' ? 'selected' : ''}>买入</option>
        <option value="sell" ${type === 'sell' ? 'selected' : ''}>卖出</option>
        <option value="other" ${type === 'other' ? 'selected' : ''}>其它收支</option>
      </select></label>
      <label class="field-other ${type !== 'other' ? 'hidden' : ''}">其它类别<input name="other_category" value="${trade.other_category || ''}"></label>
      <label>代码<input name="symbol" required value="${trade.symbol || ''}"></label>
      <label>名称<input name="name" value="${trade.name || ''}"></label>
      <label class="field-trade ${type === 'other' ? 'hidden' : ''}">数量<input name="shares" type="number" step="any" value="${trade.shares ?? ''}"></label>
      <label class="field-trade ${type === 'other' ? 'hidden' : ''}">价格<input name="price" type="number" step="any" value="${trade.price ?? ''}"></label>
      <label class="field-other-amt ${type !== 'other' ? 'hidden' : ''}">金额<input name="total_amount" type="number" step="any" value="${trade.total_amount ?? ''}"></label>
      <label>手续费<input name="commission" type="number" step="any" value="${trade.commission ?? 0}"></label>
      <label>时间<input name="trade_date" type="datetime-local" value="${dt}"></label>
    </form>`;
}

function bindTradeForm(root) {
  const typeEl = root.querySelector('#trade-type');
  if (!typeEl) return;
  typeEl.addEventListener('change', () => {
    const other = typeEl.value === 'other';
    root.querySelectorAll('.field-other,.field-other-amt').forEach((el) => el.classList.toggle('hidden', !other));
    root.querySelectorAll('.field-trade').forEach((el) => el.classList.toggle('hidden', other));
  });
}

function formToTrade(fd, existing = {}) {
  const type = fd.get('type');
  return {
    type, symbol: String(fd.get('symbol') || '').trim(), name: String(fd.get('name') || '').trim(),
    commission: Number(fd.get('commission')) || 0,
    trade_date: new Date(fd.get('trade_date')).toISOString(), id: existing.id,
    ...(type === 'other'
      ? { other_category: String(fd.get('other_category') || '').trim(), total_amount: Number(fd.get('total_amount')) }
      : { shares: Number(fd.get('shares')), price: Number(fd.get('price')) })
  };
}

function openTradeModal(trade = {}) {
  openModal(trade.id ? '编辑交易' : '记一笔', tradeFormFields(trade), null, async () => {
    const fd = new FormData($('#trade-form'));
    const body = formToTrade(fd, trade);
    if (trade.id) await api('/trades/' + trade.id, { method: 'PUT', body });
    else await api('/trades', { method: 'POST', body });
  });
  bindTradeForm($('#modal-body'));
}

const importState = { buffer: null, count: 0, preview: [], error: null, mode: 'merge' };

function renderImportPreviewSection() {
  if (importState.error) return `<div class="sm-error-box">${importState.error}</div>`;
  if (!importState.count) return '';
  const rows = importState.preview.map((t) => `
    <tr>
      <td>${(t.trade_date || '').slice(0, 19).replace('T', ' ')}</td>
      <td>${typeLabel(t)}</td>
      <td>${t.symbol}</td>
      <td>${t.name || ''}</td>
      <td>${t.type === 'other' ? '—' : t.shares}</td>
      <td>${t.type === 'other' ? '—' : fmtUsd(t.price)}</td>
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

function bindImportModal() {
  $('#import-mode')?.addEventListener('change', (e) => { importState.mode = e.target.value; });
  $('#import-file')?.addEventListener('change', async (e) => {
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
    }
    const area = $('#import-preview-area');
    if (area) area.innerHTML = renderImportPreviewSection();
    const btn = $('#import-confirm');
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
  openModal('导入交易', `
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
  bindImportModal();
  $('#import-confirm')?.addEventListener('click', async () => {
    if (!importState.buffer || !importState.count) return;
    try {
      const res = await fetch('./api/trades/import?mode=' + encodeURIComponent(importState.mode), {
        method: 'POST',
        headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
        body: importState.buffer
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '导入失败');
      closeModal();
      applyPortfolio(data);
    } catch (err) {
      toastErr(err.message);
    }
  });
}

function filteredTrades() {
  const f = ui.tradeFilter;
  return [...(state.trades || [])].filter((t) => {
    if (f.symbol && !t.symbol.toUpperCase().includes(f.symbol.toUpperCase())) return false;
    if (f.type !== 'all' && t.type !== f.type) return false;
    if (f.otherCategory && t.type === 'other' && !(t.other_category || '').includes(f.otherCategory)) return false;
    const d = (t.trade_date || '').slice(0, 10);
    if (f.start && d < f.start) return false;
    if (f.end && d > f.end) return false;
    return true;
  }).sort((a, b) => new Date(b.trade_date) - new Date(a.trade_date));
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
    <div class="sm-trade-filters">
      <input placeholder="代码" data-filter="symbol" value="${ui.tradeFilter.symbol}">
      <select data-filter="type">
        <option value="all">全部类型</option>
        <option value="buy" ${ui.tradeFilter.type === 'buy' ? 'selected' : ''}>买入</option>
        <option value="sell" ${ui.tradeFilter.type === 'sell' ? 'selected' : ''}>卖出</option>
        <option value="other" ${ui.tradeFilter.type === 'other' ? 'selected' : ''}>其它</option>
      </select>
      <input placeholder="其它类别" data-filter="otherCategory" value="${ui.tradeFilter.otherCategory}">
      <input type="date" data-filter="start" value="${ui.tradeFilter.start}">
      <span class="sm-muted">至</span>
      <input type="date" data-filter="end" value="${ui.tradeFilter.end}">
      <button type="button" class="btn ghost sm-btn-sm" id="filter-reset">重置</button>
    </div>
    <div class="sm-trade-modal-scroll">
      <div class="sm-table-wrap sm-table-wrap--modal">
        <table class="sm-table">
          <thead><tr>
            <th>时间</th><th>类型</th><th>代码</th><th>名称</th><th>股数</th><th>价格</th><th>金额</th><th>手续费</th><th>操作</th>
          </tr></thead>
          <tbody>${pageRows.length ? pageRows.map((t) => `
            <tr>
              <td>${(t.trade_date || '').slice(0, 19).replace('T', ' ')}</td>
              <td>${typeLabel(t)}</td>
              <td>${t.symbol}</td>
              <td>${t.name || ''}</td>
              <td>${t.type === 'other' ? '—' : t.shares}</td>
              <td>${t.type === 'other' ? '—' : fmtUsd(t.price)}</td>
              <td>${fmtUsd(t.total_amount)}</td>
              <td>${fmtCommission(t.commission)}</td>
              <td>
                <button type="button" class="btn link" data-edit="${t.id}">编辑</button>
                <button type="button" class="btn link" data-del="${t.id}">删除</button>
              </td>
            </tr>`).join('') : `<tr><td colspan="9" class="empty">暂无记录</td></tr>`}
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
  const rows = await api('/trades/summary?' + q.toString());
  const totals = rows.reduce((a, r) => ({
    buy: a.buy + r.totalBuyAmount, sell: a.sell + r.totalSellAmount,
    fee: a.fee + r.totalCommission, pnl: a.pnl + r.netPnl
  }), { buy: 0, sell: 0, fee: 0, pnl: 0 });

  return `
    <div class="sm-trade-modal-scroll">
      <div class="sm-table-wrap sm-table-wrap--modal">
        <table class="sm-table">
          <thead><tr>
            <th>代码</th><th>总买入</th><th>总卖出</th><th>总费用</th><th>盈亏金额</th><th>盈亏比例</th>
          </tr></thead>
          <tbody>${rows.length ? rows.map((r) => `
            <tr>
              <td>${r.symbol}</td><td>${fmtUsd(r.totalBuyAmount)}</td><td>${fmtUsd(r.totalSellAmount)}</td>
              <td>${fmtCommission(r.totalCommission)}</td><td class="${cls(r.netPnl)}">${fmtUsdSigned(r.netPnl)}</td>
              <td>${r.netPnlRate == null ? '—' : fmtPct(r.netPnlRate)}</td>
            </tr>`).join('') : `<tr><td colspan="6" class="empty">暂无数据</td></tr>`}
          <tr class="sm-total-row">
            <td>合计</td><td>${fmtUsd(totals.buy)}</td><td>${fmtUsd(totals.sell)}</td>
            <td>${fmtCommission(totals.fee)}</td><td class="${cls(totals.pnl)}">${fmtUsdSigned(totals.pnl)}</td><td>—</td>
          </tr></tbody>
        </table>
      </div>
      <p class="hint">不含「其它」类交易；盈亏按 FIFO 计算。</p>
    </div>`;
}

async function renderTradeModalBody() {
  const tabs = `
    <div class="sm-tabs">
      <button type="button" class="sm-tab ${ui.tradeTab === 'list' ? 'active' : ''}" data-tab="list">明细</button>
      <button type="button" class="sm-tab ${ui.tradeTab === 'summary' ? 'active' : ''}" data-tab="summary">盈亏汇总</button>
    </div>
    <div class="sm-modal-toolbar">
      <button type="button" class="btn ghost sm-btn-sm" id="modal-add-other">＋ 其它收支</button>
      <button type="button" class="btn ghost sm-btn-sm" id="modal-import">导入</button>
      <button type="button" class="btn ghost sm-btn-sm" id="modal-export">导出 xlsx</button>
    </div>`;
  const content = ui.tradeTab === 'summary' ? await renderTradeSummaryTab() : renderTradeListTab();
  return `<div class="sm-trade-modal-content">${tabs}${content}</div>`;
}

async function openTradeHistoryModal(symbol = '') {
  if (symbol) ui.tradeFilter.symbol = symbol;
  ui.tradePage = 1;
  openModal('交易记录', '<div id="trade-modal-content">加载中…</div>', '<button type="button" class="btn ghost" data-close>关闭</button>', null, { size: 'trade' });
  const refresh = async () => {
    $('#trade-modal-content').innerHTML = await renderTradeModalBody();
    bindTradeModalEvents();
  };
  await refresh();
  window._refreshTradeModal = refresh;
}

function openTradeHistoryForRange(start, end) {
  ui.tradeFilter = { symbol: '', type: 'all', otherCategory: '', start, end };
  ui.tradePage = 1;
  openTradeHistoryModal();
}

function bindTradeModalEvents() {
  const root = $('#trade-modal-content');
  if (!root) return;
  root.querySelectorAll('[data-tab]').forEach((btn) => btn.addEventListener('click', async () => {
    ui.tradeTab = btn.dataset.tab;
    $('#trade-modal-content').innerHTML = await renderTradeModalBody();
    bindTradeModalEvents();
  }));
  root.querySelectorAll('[data-filter]').forEach((el) => {
    el.addEventListener('change', () => {
      ui.tradeFilter[el.dataset.filter] = el.value;
      ui.tradePage = 1;
      window._refreshTradeModal?.();
    });
    el.addEventListener('input', () => {
      ui.tradeFilter[el.dataset.filter] = el.value;
      if (el.dataset.filter === 'symbol' || el.dataset.filter === 'otherCategory') {
        clearTimeout(el._debounce);
        el._debounce = setTimeout(() => {
          ui.tradePage = 1;
          window._refreshTradeModal?.();
        }, 320);
      }
    });
  });
  $('#filter-reset')?.addEventListener('click', () => {
    ui.tradeFilter = { symbol: '', type: 'all', otherCategory: '', start: '', end: '' };
    ui.tradePage = 1;
    window._refreshTradeModal?.();
  });
  root.querySelectorAll('[data-page]').forEach((btn) => btn.addEventListener('click', () => {
    const v = btn.dataset.page;
    const all = filteredTrades();
    const pages = Math.max(1, Math.ceil(all.length / ui.tradePageSize));
    if (v === 'prev') ui.tradePage = Math.max(1, ui.tradePage - 1);
    else if (v === 'next') ui.tradePage = Math.min(pages, ui.tradePage + 1);
    else ui.tradePage = Number(v);
    window._refreshTradeModal?.();
  }));
  $('#page-size')?.addEventListener('change', (e) => {
    ui.tradePageSize = Number(e.target.value);
    ui.tradePage = 1;
    window._refreshTradeModal?.();
  });
  root.querySelectorAll('[data-edit]').forEach((btn) => btn.addEventListener('click', () => {
    const trade = state.trades.find((t) => t.id === btn.dataset.edit);
    if (trade) { closeModal(); openTradeModal(trade); }
  }));
  root.querySelectorAll('[data-del]').forEach((btn) => btn.addEventListener('click', async () => {
    if (!confirm('确定删除？')) return;
    applyPortfolio(await api('/trades/' + btn.dataset.del, { method: 'DELETE' }));
    window._refreshTradeModal?.();
  }));
  $('#modal-add-other')?.addEventListener('click', () => { closeModal(); openTradeModal({ type: 'other' }); });
  $('#modal-import')?.addEventListener('click', () => { closeModal(); openImportModal(); });
  $('#modal-export')?.addEventListener('click', () => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(ui.tradeFilter)) {
      if (v && v !== 'all') q.set(k, v);
    }
    window.open('./api/trades/export?' + q.toString(), '_blank');
  });
}

async function saveMeta(symbol, patch) {
  applyPortfolio(await api('/holdings-meta/' + encodeURIComponent(symbol), { method: 'PUT', body: patch }));
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
  saveJson(LS_DASHBOARD, dashboardVisible);
  renderDashboard();
});

$('#btn-col-toggle').addEventListener('click', () => {
  renderColToggle();
  $('#col-toggle-panel').classList.toggle('hidden');
});

$('#col-toggle-panel').addEventListener('change', (e) => {
  const col = e.target.dataset?.col;
  if (!col) return;
  colVis[col] = e.target.checked;
  saveJson(LS_COL_VIS, colVis);
  renderHoldings();
});

async function refreshQuotes(symbol) {
  const btn = $('#btn-refresh');
  if (btn) btn.disabled = true;
  try {
    const body = symbol ? { symbol } : undefined;
    const data = await api('/quotes/refresh', { method: 'POST', body });
    applyPortfolio(data);
    const r = data.refresh;
    if (r?.failed) {
      const msg = r.errors.slice(0, 5).map((e) => `${e.symbol}: ${e.error}`).join('\n');
      toastWarn(`已刷新 ${r.ok} 个，失败 ${r.failed} 个：${msg.replace(/\n/g, ' · ')}`);
    }
  } catch (e) {
    toastErr(e.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

$('#btn-refresh').addEventListener('click', () => refreshQuotes());

$('#btn-add').addEventListener('click', () => openTradeModal());
$('#btn-import').addEventListener('click', openImportModal);
$('#btn-trades').addEventListener('click', () => openTradeHistoryModal());

$('#pnl-start').addEventListener('change', (e) => { pnlStart = e.target.value; });
$('#pnl-end').addEventListener('change', (e) => { pnlEnd = e.target.value; });
$('#btn-pnl-query').addEventListener('click', () => loadPortfolio().catch((e) => toastErr(e.message)));
$('#btn-pnl-reset').addEventListener('click', () => {
  pnlStart = pnlEnd = '';
  $('#pnl-start').value = $('#pnl-end').value = '';
  loadPortfolio().catch((e) => toastErr(e.message));
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
  } catch (err) {
    toastErr(err.message);
  }
});

$('#holdings-body').addEventListener('click', async (e) => {
  const clearSym = e.target.closest('[data-clear-group]')?.dataset.clearGroup;
  if (clearSym) {
    try { await saveMeta(clearSym, { groupWith: '' }); } catch (err) { toastErr(err.message); }
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
  if (!el) return;
  const symbol = el.dataset.symbol;
  const field = el.dataset.meta;
  const body = (field === 'target' || field === 'targetPrice')
    ? { targetPrice: el.value === '' ? '' : Number(el.value) }
    : { signal: el.value };
  await saveMeta(symbol, body);
});

renderColToggle();
loadPortfolio().catch((e) => {
  toastErr(`加载失败: ${e.message}`);
  document.body.innerHTML = `<p class="sm-error">加载失败: ${e.message}</p>`;
});
