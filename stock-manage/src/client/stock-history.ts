import { mountTradeTable } from './trade-table';
import { mountTradeFilters } from './trade-filters';
import { TRADE_ASSET_TYPES, tradeAssetType } from '../../public/js/trade-asset-type.js';
import { renderTradeReview } from '../../public/js/trade-review.js';
import { openModal, $ } from './stock-modal';
import {
  escapeHtml, fmtCommission, fmtPct, fmtUsd, fmtUsdSigned, cls, formatPrice, formatQuantity,
  formatLocalDateTime, localDateKey, looksLikeAShare, tradeAmountLabel, typeLabel
} from './stock-format';

export interface StockHistoryDeps {
  api: (path: string, opts?: any) => Promise<any>;
  can: (feature: string, action?: string) => boolean;
  getPortfolio: () => any;
  getSelectedAccountId: () => string;
  applyPortfolio: (data: any) => void;
  pnlQuery: () => string;
  openTradeModal: (trade?: any) => void;
  openImportModal: () => void;
  toastErr: (message: string) => void;
  toastOk: (message: string) => void;
  toastInfo: (message: string) => void;
  isPnlVisible: () => boolean;
  fundPriceDigits: (symbol?: string) => number;
}

function sortMarkFor(sort: { key: string; dir: number }, key: string) {
  if (sort.key !== key) return '';
  return sort.dir === 1 ? ' ▲' : ' ▼';
}

export function openTradeHistoryModal(deps: StockHistoryDeps, options: { symbol?: string; start?: string; end?: string } = {}) {
  if (!deps.can('trades')) return;
  const ui: any = {
    tradeTab: 'list', tradePage: 1, tradePageSize: 10,
    tradeAccountId: deps.can('accounts') ? deps.getSelectedAccountId() : '',
    tradeSummarySort: { key: '', dir: -1 },
    tradeFilter: { symbol: '', type: 'all', assetType: 'all', otherCategory: '', start: '', end: '' },
    tradeFilterOpen: false,
    reviewCurrency: 'USD'
  };
  if (options.symbol) ui.tradeFilter.symbol = options.symbol;
  if (options.start) ui.tradeFilter.start = options.start;
  if (options.end) ui.tradeFilter.end = options.end;
  const layer = openModal('交易记录', '<div id="trade-modal-content">加载中…</div>',
    '<button type="button" class="btn ghost" data-close>关闭</button>', null, { size: 'trade' });
  const box = $('#trade-modal-content', layer)!;
  let refreshRevision = 0;
  let listTrades: any[] = [];
  let alternate: { portfolio: any; request: Promise<any> } | undefined;

  const maskPnlValue = (html: string) => deps.isPnlVisible() ? html : '<span class="sm-mask">—</span>';

  const filteredTrades = (trades: any[]) => trades.filter((t: any) => {
    const f = ui.tradeFilter;
    if (ui.tradeAccountId && (t.account_id || 'unassigned') !== ui.tradeAccountId) return false;
    if (f.symbol && !String(t.symbol).toUpperCase().includes(f.symbol.toUpperCase())) return false;
    if (f.type !== 'all' && t.type !== f.type) return false;
    if (f.assetType !== 'all' && tradeAssetType(t) !== f.assetType) return false;
    if (f.otherCategory && t.type === 'other' && !(t.other_category || '').includes(f.otherCategory)) return false;
    const d = localDateKey(t.trade_date);
    if (f.start && d < f.start) return false;
    if (f.end && d > f.end) return false;
    return true;
  }).sort((a: any, b: any) => new Date(b.trade_date).getTime() - new Date(a.trade_date).getTime());

  const activeFilterCount = (summary = ui.tradeTab !== 'list') => Object.entries(ui.tradeFilter)
    .filter(([key]) => key !== 'type' || !summary)
    .filter(([, value]) => value && value !== 'all').length
    + Number(ui.tradeTab !== 'review' && Boolean(ui.tradeAccountId));

  const tabsHtml = () => `
    <div class="sm-tabs">
      <button type="button" class="sm-tab ${ui.tradeTab === 'list' ? 'active' : ''}" data-tab="list">明细</button>
      <button type="button" class="sm-tab ${ui.tradeTab === 'summary' ? 'active' : ''}" data-tab="summary">盈亏汇总</button>
      ${deps.can('trade-review') ? `<button type="button" class="sm-tab ${ui.tradeTab === 'review' ? 'active' : ''}" data-tab="review">交易复盘</button>` : ''}
    </div>
    <div class="sm-modal-toolbar">
      ${deps.can('trade', 'edit') ? '<button type="button" class="btn ghost sm-btn-sm" id="modal-add-other">＋ 其它收支</button>' : ''}
      ${deps.can('import', 'edit') ? '<button type="button" class="btn ghost sm-btn-sm" id="modal-import">导入</button>' : ''}
      ${deps.can('export') ? '<button type="button" class="btn ghost sm-btn-sm" id="modal-export">导出 xlsx</button>' : ''}
      <button type="button" class="btn ghost sm-btn-sm sm-trade-filter-toggle" data-filter-toggle aria-expanded="${ui.tradeFilterOpen ? 'true' : 'false'}">筛选条件${activeFilterCount() ? `（${activeFilterCount()}）` : ''}</button>
    </div>`;

  const pagination = (total: number) => {
    const pages = Math.max(1, Math.ceil(total / ui.tradePageSize));
    ui.tradePage = Math.min(ui.tradePage, pages);
    const button = (target: number, text: string, options = '') =>
      `<button type="button" class="btn ghost sm-btn-sm" data-pagination-page="${target}" ${options}>${text}</button>`;
    const first = Math.max(1, Math.min(ui.tradePage - 3, pages - 6));
    const numbers = Array.from({ length: Math.min(pages, 7) }, (_, i) => {
      const number = first + i;
      return button(number, String(number), `data-pagination-number aria-label="第 ${number} 页"${number === ui.tradePage ? ' aria-current="page"' : ''}`);
    }).join('');
    return `<nav class="sm-pagination" aria-label="交易记录分页">
      ${button(ui.tradePage - 1, '上一页', ui.tradePage <= 1 ? 'disabled' : '')}
      <span class="sm-pagination-position" aria-live="polite">第 ${ui.tradePage} / ${pages} 页</span>
      ${numbers}
      ${button(ui.tradePage + 1, '下一页', ui.tradePage >= pages ? 'disabled' : '')}
      ${pages > 1 ? `<form class="sm-pagination-jump">
        <label>页码 <input name="page" type="number" inputmode="numeric" min="1" max="${pages}" step="1" required placeholder="${ui.tradePage}"></label>
        <button type="submit" class="btn ghost sm-btn-sm">跳转</button>
      </form>` : ''}
      <select id="page-size" aria-label="每页条数">
        ${[10, 20, 50, 100].map((n) => `<option value="${n}" ${ui.tradePageSize === n ? 'selected' : ''}>${n} 条/页</option>`).join('')}
      </select>
      <span class="sm-muted">共 ${total} 条</span>
    </nav>`;
  };

  const renderList = (trades: any[], loadError?: string) => {
    const showAccounts = deps.can('accounts') && deps.getPortfolio()?.investmentAccounts?.length;
    const accountNames = new Map(showAccounts ? (deps.getPortfolio()?.investmentAccounts || []).map((a: any) => [a.id, a.name]) : []);
    const all = filteredTrades(trades);
    const total = all.length;
    const pages = Math.max(1, Math.ceil(total / ui.tradePageSize));
    ui.tradePage = Math.min(ui.tradePage, pages);
    const start = (ui.tradePage - 1) * ui.tradePageSize;
    const rows = all.slice(start, start + ui.tradePageSize).map((trade: any) => {
      const asset = tradeAssetType(trade);
      const currency = trade.currency || (looksLikeAShare(trade.symbol) ? 'CNY' : 'USD');
      const other = trade.type === 'other';
      return {
        id: trade.id,
        date: formatLocalDateTime(trade.trade_date),
        direction: typeLabel(trade),
        historical: Boolean(trade.historicalBackfill),
        assetType: (TRADE_ASSET_TYPES as any)[asset],
        symbol: trade.symbol,
        name: trade.name || '',
        account: showAccounts ? (accountNames.get(trade.account_id) as string) || '待归属' : '',
        currency,
        shares: other ? '—' : formatQuantity(trade.shares),
        price: other ? '—' : formatPrice(trade.reinvestedDividend ? trade.reinvestmentNav : trade.price,
          currency, asset === 'fund' ? deps.fundPriceDigits(trade.symbol) : 3),
        amount: tradeAmountLabel(trade),
        commission: fmtCommission(trade.commission, currency)
      };
    });
    return {
      html: `<div class="sm-trade-filters ${ui.tradeFilterOpen ? 'is-open' : ''}" data-trade-filters></div>
        <div class="sm-trade-modal-scroll">
          <div class="sm-table-wrap sm-table-wrap--modal" data-trade-table></div>
        </div>
        ${pagination(total)}`,
      model: { rows, canEdit: deps.can('trade', 'edit'), error: loadError }
    };
  };

  const renderSummary = async () => {
    const q = new URLSearchParams();
    if (ui.tradeAccountId && deps.can('accounts')) q.set('accountId', ui.tradeAccountId);
    if (ui.tradeFilter.start) q.set('start', ui.tradeFilter.start);
    if (ui.tradeFilter.end) q.set('end', ui.tradeFilter.end);
    if (ui.tradeFilter.assetType !== 'all') q.set('assetType', ui.tradeFilter.assetType);
    if (ui.tradeFilter.symbol) q.set('symbol', ui.tradeFilter.symbol);
    if (ui.tradeFilter.otherCategory) q.set('otherCategory', ui.tradeFilter.otherCategory);
    const rows = await deps.api('/trades/summary?' + q.toString());
    const sort = ui.tradeSummarySort;
    if (sort.key) {
      rows.sort((a: any, b: any) => {
        const av = a[sort.key];
        const bv = b[sort.key];
        const aMissing = av == null || !Number.isFinite(av);
        const bMissing = bv == null || !Number.isFinite(bv);
        if (aMissing !== bMissing) return aMissing ? 1 : -1;
        return (aMissing ? 0 : (av - bv) * sort.dir) || a.symbol.localeCompare(b.symbol);
      });
    }
    const totals = rows.reduce((a: any, r: any) => ({
      buy: a.buy + r.totalBuyAmount, sell: a.sell + r.totalSellAmount,
      fee: a.fee + r.totalCommission, pnl: a.pnl + r.netPnl, other: a.other + (r.otherAmount || 0)
    }), { buy: 0, sell: 0, fee: 0, pnl: 0, other: 0 });
    return `<div class="sm-trade-filters ${ui.tradeFilterOpen ? 'is-open' : ''}" data-trade-filters></div>
      <div class="sm-trade-modal-scroll">
        <div class="sm-table-wrap sm-table-wrap--modal">
          <table class="sm-table">
            <thead><tr>
              <th>类型</th><th>代码</th><th class="sm-trade-name">名称</th><th>总买入</th><th>总卖出</th><th>其它收支</th><th>总费用</th>
              ${[['netPnl', '盈亏金额'], ['netPnlRate', '盈亏比例']].map(([key, label]) => `<th aria-sort="${sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}"><button type="button" class="btn link" data-summary-sort="${key}" title="点击切换升序或降序">${label}${sortMarkFor(sort, key)}</button></th>`).join('')}
            </tr></thead>
            <tbody>${rows.length ? rows.map((r: any) => `
              <tr>
                <td data-label="类型">${(TRADE_ASSET_TYPES as any)[r.assetType || tradeAssetType(r)]}</td><td data-label="代码">${escapeHtml(r.symbol)}</td><td data-label="名称" class="sm-trade-name">${escapeHtml(r.name || '—')}</td><td data-label="总买入">${fmtUsd(r.totalBuyAmount)}</td><td data-label="总卖出">${fmtUsd(r.totalSellAmount)}</td>
                <td data-label="其它收支">${r.assetType === 'other' ? maskPnlValue(fmtUsdSigned(r.otherAmount)) : '—'}</td><td data-label="总费用">${fmtCommission(r.totalCommission)}</td><td data-label="盈亏金额" class="${cls(r.netPnl)}">${maskPnlValue(fmtUsdSigned(r.netPnl))}</td>
                <td data-label="盈亏比例">${r.netPnlRate == null ? '—' : maskPnlValue(fmtPct(r.netPnlRate))}</td>
              </tr>`).join('') : '<tr><td colspan="9" class="empty">暂无数据</td></tr>'}
              <tr class="sm-total-row">
                <td data-label="汇总">合计</td><td data-label="代码">—</td><td data-label="名称">—</td><td data-label="总买入">${fmtUsd(totals.buy)}</td><td data-label="总卖出">${fmtUsd(totals.sell)}</td>
                <td data-label="其它收支">${maskPnlValue(fmtUsdSigned(totals.other))}</td><td data-label="总费用">${fmtCommission(totals.fee)}</td><td data-label="盈亏金额" class="${cls(totals.pnl)}">${maskPnlValue(fmtUsdSigned(totals.pnl))}</td><td data-label="盈亏比例">—</td>
              </tr></tbody>
          </table>
        </div>
        <p class="hint">其它收支按代码和类别汇总，收入为正、支出为负，扣除手续费后计入净盈亏；金额统一折算为美元。股票和期权盈亏按 FIFO 计算。</p>
      </div>`;
  };

  const renderReview = async () => {
    const query = new URLSearchParams();
    const selected = deps.getSelectedAccountId();
    if (selected) query.set('accountId', selected);
    for (const [key, value] of Object.entries(ui.tradeFilter)) {
      if (key !== 'type' && value && value !== 'all') query.set(key, value as string);
    }
    const filters = `<div class="sm-trade-filters ${ui.tradeFilterOpen ? 'is-open' : ''}" data-trade-filters></div>`;
    try {
      const report = await deps.api('/trades/review?' + query);
      return `${filters}<div class="sm-trade-modal-scroll sm-review">${renderTradeReview(report, ui.reviewCurrency, deps.isPnlVisible())}</div>`;
    } catch (error: any) {
      return `${filters}<div class="sm-trade-modal-scroll"><p role="alert" class="hint">${escapeHtml(error.message)}</p></div>`;
    }
  };

  const refresh = async () => {
    const revision = ++refreshRevision;
    const current = $('#trade-modal-content', layer);
    if (!current) return;
    let trades = deps.getPortfolio()?.trades || [];
    let loadError: string | undefined;
    if (ui.tradeTab === 'list' && ui.tradeAccountId !== deps.getSelectedAccountId() && deps.can('accounts')) {
      if (alternate?.portfolio !== deps.getPortfolio()) {
        alternate = { portfolio: deps.getPortfolio(), request: deps.api('/portfolio') };
      }
      const request = alternate;
      try {
        trades = (await request.request).trades || [];
      } catch (error: any) {
        if (alternate === request) alternate = undefined;
        trades = [];
        loadError = error.message;
      }
    }
    if (revision !== refreshRevision || !layer.isConnected) return;
    let html = '';
    let model: any = null;
    if (ui.tradeTab === 'list') {
      const result = renderList(trades, loadError);
      html = result.html;
      model = result.model;
    } else if (ui.tradeTab === 'review' && deps.can('trade-review')) html = await renderReview();
    else html = await renderSummary();
    if (revision !== refreshRevision || !layer.isConnected) return;
    (layer as any).disposeTradeTable?.();
    (layer as any).disposeTradeFilters?.();
    (layer as any).disposeTradeTable = undefined;
    (layer as any).disposeTradeFilters = undefined;
    current.innerHTML = `<div class="sm-trade-modal-content">${tabsHtml()}${html}</div>`;
    listTrades = trades;
    const table = $('[data-trade-table]', current);
    if (table && model) (layer as any).disposeTradeTable = mountTradeTable(table, model);
    const filters = $('[data-trade-filters]', current);
    if (filters) {
      (layer as any).disposeTradeFilters = mountTradeFilters(filters, {
        accountId: ui.tradeAccountId,
        accounts: ui.tradeTab !== 'review' && deps.can('accounts') ? deps.getPortfolio()?.investmentAccounts || [] : [],
        assetTypes: TRADE_ASSET_TYPES,
        summary: ui.tradeTab !== 'list',
        values: ui.tradeFilter
      });
    }
    const accountFilter = $('#trade-account-filter', current) as HTMLSelectElement | null;
    if (accountFilter) accountFilter.value = ui.tradeAccountId;
  };

  const updateFilterToggle = () => {
    const button = box.querySelector('[data-filter-toggle]');
    if (button) button.textContent = `筛选条件${activeFilterCount() ? `（${activeFilterCount()}）` : ''}`;
  };

  box.addEventListener('click', (event: any) => {
    const target = event.target.closest('button, [data-review-range]');
    if (!target) return;
    const tab = target.dataset?.tab;
    if (tab) { ui.tradeTab = tab; refresh(); return; }
    if (target.matches('[data-filter-toggle]')) {
      ui.tradeFilterOpen = !ui.tradeFilterOpen;
      box.querySelector('.sm-trade-filters')?.classList.toggle('is-open', ui.tradeFilterOpen);
      target.setAttribute('aria-expanded', ui.tradeFilterOpen ? 'true' : 'false');
      return;
    }
    if (target.matches('[data-summary-sort]')) {
      const key = target.dataset.summarySort;
      ui.tradeSummarySort = { key, dir: ui.tradeSummarySort.key === key ? -ui.tradeSummarySort.dir : -1 };
      refresh();
      return;
    }
    const page = target.dataset.paginationPage;
    if (page) {
      const number = Number(page);
      if (number === ui.tradePage) return;
      ui.tradePage = number;
      refresh();
      return;
    }
    if (target.id === 'modal-add-other') { deps.openTradeModal({ type: 'other' }); return; }
    if (target.id === 'modal-import') { deps.openImportModal(); return; }
    if (target.id === 'modal-export') {
      const q = new URLSearchParams();
      const accountId = ui.tradeTab === 'review' ? deps.getSelectedAccountId() : ui.tradeAccountId;
      if (accountId) q.set('accountId', accountId);
      for (const [k, v] of Object.entries(ui.tradeFilter)) {
        if (ui.tradeTab !== 'list' && k === 'type') continue;
        if (v && v !== 'all') q.set(k, v as string);
      }
      window.open('./api/trades/export?' + q.toString(), '_blank');
      deps.toastInfo('正在导出交易记录');
      return;
    }
    const editId = target.dataset.edit;
    if (editId) {
      const trade = listTrades.find((t: any) => t.id === editId);
      if (trade) deps.openTradeModal(trade);
      return;
    }
    const delId = target.dataset.del;
    if (delId) {
      void (async () => {
        const ok = (window as any).portalDialog?.confirm
          ? await (window as any).portalDialog.confirm('确定删除这条交易记录？', { title: '删除确认', danger: true, okText: '删除' })
          : window.confirm('确定删除？');
        if (!ok) return;
        try {
          deps.applyPortfolio(await deps.api('/trades/' + delId + deps.pnlQuery(), { method: 'DELETE' }));
          deps.toastOk('已删除');
          (window as any)._refreshTradeModal?.();
        } catch (err: any) { deps.toastErr(err.message); }
      })();
    }
    const range = target.dataset?.reviewRange;
    if (range) {
      const now = new Date();
      ui.tradeFilter.end = range === 'all' ? '' : localDateKey(now.toISOString());
      if (range === 'all') ui.tradeFilter.start = '';
      else if (range === 'year') ui.tradeFilter.start = `${now.getFullYear()}-01-01`;
      else {
        now.setDate(now.getDate() - Number(range) + 1);
        ui.tradeFilter.start = localDateKey(now.toISOString());
      }
      updateFilterToggle();
      refresh();
    }
  });
  box.addEventListener('change', (event: any) => {
    const el = event.target;
    if (el.matches('[data-filter]')) {
      ui.tradeFilter[el.dataset.filter] = el.value;
      updateFilterToggle();
      ui.tradePage = 1;
      refresh();
    } else if (el.id === 'trade-account-filter') {
      ui.tradeAccountId = el.value;
      updateFilterToggle();
      ui.tradePage = 1;
      refresh();
    } else if (el.id === 'page-size') {
      ui.tradePageSize = Number(el.value);
      ui.tradePage = 1;
      refresh();
    } else if (el.matches('[data-review-currency]')) {
      ui.reviewCurrency = el.value;
      refresh();
    }
  });
  box.addEventListener('input', (event: any) => {
    const el = event.target;
    if (!el.matches('[data-filter]')) return;
    ui.tradeFilter[el.dataset.filter] = el.value;
    updateFilterToggle();
    if (el.dataset.filter === 'symbol' || el.dataset.filter === 'otherCategory') {
      clearTimeout(el._debounce);
      el._debounce = setTimeout(() => {
        ui.tradePage = 1;
        refresh();
      }, 320);
    }
  });
  box.addEventListener('click', (event: any) => {
    const reset = event.target.closest('#filter-reset');
    if (!reset) return;
    ui.tradeFilter = { symbol: '', type: 'all', assetType: 'all', otherCategory: '', start: '', end: '' };
    if (ui.tradeTab !== 'review') ui.tradeAccountId = '';
    updateFilterToggle();
    ui.tradePage = 1;
    refresh();
  });
  box.addEventListener('submit', (event: any) => {
    if (!event.target.matches('.sm-pagination-jump')) return;
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    if (!form.reportValidity()) return;
    const page = (form.elements.namedItem('page') as HTMLInputElement).valueAsNumber;
    if (page == null || page === ui.tradePage) return;
    ui.tradePage = page;
    refresh();
  });

  (window as any)._tradeHistoryLayer = layer;
  (window as any)._refreshTradeModal = refresh;
  void refresh();
  return layer;
}

export function openTradeHistoryForRange(deps: StockHistoryDeps, start: string, end: string) {
  openTradeHistoryModal(deps, { start, end });
}
