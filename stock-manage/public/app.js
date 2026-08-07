import { HOLDINGS_COLUMNS, LS_COL_VIS, LS_DASHBOARD, LS_FULL_WIDTH, loadJson, saveJson, defaultColVis } from './js/constants.js';
import { buildLineChartSvg } from './js/chart.js';

const $ = (sel, root = document) => root.querySelector(sel);
const fmt = (n) => Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
const fmtPct = (n) => Number.isFinite(n) ? n.toFixed(2) + '%' : '—';
const cls = (n) => n > 0 ? 'pos' : n < 0 ? 'neg' : '';
const MASK = '<span class="sm-mask">—</span>';

let state = { cash: 0, trades: [], holdings: [], summary: {}, chartSeries: [], holdingsMeta: {} };
let colVis = loadJson(LS_COL_VIS, defaultColVis());
let dashboardVisible = loadJson(LS_DASHBOARD, true);
let fullWidth = loadJson(LS_FULL_WIDTH, false);
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
  el.innerHTML = `
    <div class="sm-summary-grid">
      <div class="sm-summary-card sm-summary-card--purple">
        <div class="label">总资产</div>
        <div class="value">$${fmt(s.totalAssets)}</div>
      </div>
      <div class="sm-summary-card sm-summary-card--blue">
        <div class="label">股票市值</div>
        <div class="value">$${fmt(s.stockMv)}</div>
      </div>
      <div class="sm-summary-card sm-summary-card--violet">
        <div class="label">期权市值</div>
        <div class="value">$${fmt(s.optionMv)}</div>
      </div>
      <div class="sm-summary-card sm-summary-card--teal">
        <div class="label">总盈亏</div>
        <div class="value ${cls(s.totalPnl)}">$${fmt(s.totalPnl)}</div>
        <div class="hint">不含无成本数据的行</div>
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
    } catch (err) { alert(err.message); }
  });
}

function renderColToggle() {
  $('#col-toggle-panel').innerHTML = HOLDINGS_COLUMNS.map((c) => `
    <label class="sm-col-check"><input type="checkbox" data-col="${c.key}" ${colVis[c.key] !== false ? 'checked' : ''}> ${c.label}</label>
  `).join('');
}

function renderHoldingsHead() {
  $('#holdings-head').innerHTML = `<tr>${HOLDINGS_COLUMNS.map((c) => `<th>${c.label}</th>`).join('')}</tr>`;
}

function renderHoldings() {
  renderHoldingsHead();
  const rows = state.holdings || [];
  let html = rows.map((h) => {
    const opt = h.optionInfo;
    const optStr = opt ? `${opt.type} $${opt.strike} · ${opt.expiration}` : '—';
    const lots = h.costLots?.length > 1 ? `<div class="sm-lots-hint">${h.costLots.length} 笔合计</div>` : '';
    return `<tr data-symbol="${h.symbol}">
      <td>${mask('type', h.type === 'option' ? '期权' : '股票')}</td>
      <td>${mask('symbol', `<strong>${h.symbol}</strong>`)}</td>
      <td>${mask('shares', h.shares)}</td>
      <td>${mask('cost', fmt(h.avgCost) + lots)}</td>
      <td>${mask('price', `<span>${fmt(h.price)}</span> <button type="button" class="btn link" data-refresh="${h.symbol}">↻</button>`)}</td>
      <td class="${cls(h.pnl)}">${mask('pnl', h.pnl == null ? '—' : fmt(h.pnl))}</td>
      <td class="${cls(h.pnlPct)}">${mask('pnlPct', h.pnlPct == null ? '—' : fmtPct(h.pnlPct))}</td>
      <td class="${cls(h.dailyPnl)}">${mask('dailyPnl', h.dailyPnl == null ? '—' : fmt(h.dailyPnl))}</td>
      <td class="${cls(h.dailyPnlPct)}">${mask('dailyPnlPct', h.dailyPnlPct == null ? '—' : fmtPct(h.dailyPnlPct))}</td>
      <td>${mask('position', fmt(h.marketValue))}</td>
      <td>${mask('weight', fmtPct(h.weight))}</td>
      <td>${mask('target', `<input class="sm-cell-input" data-meta="target" data-symbol="${h.symbol}" type="number" step="any" value="${h.targetPrice ?? ''}" placeholder="—">`)}</td>
      <td>${mask('optinfo', optStr)}</td>
      <td>${mask('signal', `<select class="sm-cell-select" data-meta="signal" data-symbol="${h.symbol}">${signalOptions(h.signal)}</select>`)}</td>
      <td>${mask('actions', `
        <button type="button" class="btn link" data-trade="buy" data-symbol="${h.symbol}">买</button>
        <button type="button" class="btn link" data-trade="sell" data-symbol="${h.symbol}">卖</button>
        <button type="button" class="btn link" data-history="${h.symbol}">记录</button>`)}</td>
    </tr>`;
  }).join('');

  const cashPct = state.summary?.totalAssets > 0 ? (state.cash / state.summary.totalAssets * 100) : 0;
  html += `<tr class="sm-cash-row">
    <td>${mask('type', '现金')}</td>
    <td>${mask('symbol', 'CASH')}</td>
    <td colspan="7">${mask('shares', '—')}</td>
    <td>${mask('position', fmt(state.cash))}</td>
    <td>${mask('weight', fmtPct(cashPct))}</td>
    <td colspan="4"></td>
  </tr>`;

  $('#holdings-body').innerHTML = html || `<tr><td colspan="${HOLDINGS_COLUMNS.length}" class="empty">暂无持仓</td></tr>`;
}

function renderPnl() {
  const s = state.summary || {};
  const items = [
    ['买入总额', s.totalBuy], ['卖出总额', s.totalSell], ['已实现盈亏', s.realizedPL],
    ['手续费', s.commission], ['其它收支', s.otherAmount], ['净盈亏', s.netPL]
  ];
  $('#pnl-stats').innerHTML = items.map(([label, val]) =>
    `<div class="sm-stat"><div class="label">${label}</div><div class="value ${cls(val)}">${fmt(val)}</div></div>`
  ).join('');
  $('#pnl-chart').innerHTML = buildLineChartSvg(state.chartSeries || [], s.totalAssets || 0);
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

function openModal(title, bodyHtml, footHtml, onSubmit) {
  const root = $('#modal-root');
  root.innerHTML = `
    <div class="sm-modal-backdrop">
      <div class="sm-modal sm-modal--wide" role="dialog">
        <div class="sm-modal-head"><h3>${title}</h3><button type="button" class="btn link" data-close>关闭</button></div>
        <div class="sm-modal-body" id="modal-body">${bodyHtml}</div>
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
      catch (err) { alert(err.message); }
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

function openImportModal() {
  openModal('导入交易', `
    <p class="hint">支持 Moomoo 历史 xlsx 或本应用导出的「交易记录」xlsx。</p>
    <form id="import-form" class="sm-form-grid">
      <label>导入模式<select name="mode">
        <option value="merge">合并到现有记录</option>
        <option value="replace">替换全部记录</option>
      </select></label>
      <label>选择文件<input type="file" name="file" accept=".xlsx,.xls" required></label>
    </form>`, null, async () => {
    const fd = new FormData($('#import-form'));
    const file = fd.get('file');
    if (!file?.size) throw new Error('请选择文件');
    const buf = await file.arrayBuffer();
    const res = await fetch('./api/trades/import?mode=' + encodeURIComponent(fd.get('mode') || 'merge'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
      body: buf
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '导入失败');
    applyPortfolio(data);
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
            <td>${t.type === 'other' ? '—' : fmt(t.price)}</td>
            <td>${fmt(t.total_amount)}</td>
            <td>${fmt(t.commission)}</td>
            <td>
              <button type="button" class="btn link" data-edit="${t.id}">编辑</button>
              <button type="button" class="btn link" data-del="${t.id}">删除</button>
            </td>
          </tr>`).join('') : `<tr><td colspan="9" class="empty">暂无记录</td></tr>`}
        </tbody>
      </table>
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
    <div class="sm-table-wrap sm-table-wrap--modal">
      <table class="sm-table">
        <thead><tr>
          <th>代码</th><th>总买入</th><th>总卖出</th><th>总费用</th><th>盈亏金额</th><th>盈亏比例</th>
        </tr></thead>
        <tbody>${rows.length ? rows.map((r) => `
          <tr>
            <td>${r.symbol}</td><td>${fmt(r.totalBuyAmount)}</td><td>${fmt(r.totalSellAmount)}</td>
            <td>${fmt(r.totalCommission)}</td><td class="${cls(r.netPnl)}">${fmt(r.netPnl)}</td>
            <td>${r.netPnlRate == null ? '—' : fmtPct(r.netPnlRate)}</td>
          </tr>`).join('') : `<tr><td colspan="6" class="empty">暂无数据</td></tr>`}
        <tr class="sm-total-row">
          <td>合计</td><td>${fmt(totals.buy)}</td><td>${fmt(totals.sell)}</td>
          <td>${fmt(totals.fee)}</td><td class="${cls(totals.pnl)}">${fmt(totals.pnl)}</td><td>—</td>
        </tr></tbody>
      </table>
    </div>
    <p class="hint">不含「其它」类交易；盈亏按 FIFO 计算。</p>`;
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
  return tabs + content;
}

async function openTradeHistoryModal(symbol = '') {
  if (symbol) ui.tradeFilter.symbol = symbol;
  ui.tradePage = 1;
  openModal('交易记录', '<div id="trade-modal-content">加载中…</div>', '<button type="button" class="btn ghost" data-close>关闭</button>');
  const refresh = async () => {
    $('#trade-modal-content').innerHTML = await renderTradeModalBody();
    bindTradeModalEvents();
  };
  await refresh();
  window._refreshTradeModal = refresh;
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
  $('#app').classList.toggle('sm-app--full', fullWidth);
  const fw = $('#toggle-fullwidth');
  if (fw) fw.checked = fullWidth;
}

// Event bindings
applyLayoutPrefs();

$('#toggle-fullwidth')?.addEventListener('change', (e) => {
  fullWidth = e.target.checked;
  saveJson(LS_FULL_WIDTH, fullWidth);
  applyLayoutPrefs();
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
      alert(`已刷新 ${r.ok} 个，失败 ${r.failed} 个：\n${msg}`);
    }
  } catch (e) {
    alert(e.message);
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
$('#btn-pnl-query').addEventListener('click', () => loadPortfolio().catch((e) => alert(e.message)));
$('#btn-pnl-reset').addEventListener('click', () => {
  pnlStart = pnlEnd = '';
  $('#pnl-start').value = $('#pnl-end').value = '';
  loadPortfolio().catch((e) => alert(e.message));
});

$('#holdings-body').addEventListener('click', async (e) => {
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
  document.body.innerHTML = `<p class="sm-error">加载失败: ${e.message}</p>`;
});
