import { tradeAssetType } from '../../public/js/trade-asset-type.js';
import { openModal, closeModal, setModalBusy, readProgressResponse, $ } from './stock-modal';
import {
  escapeHtml, fmtMoney, formatLocalDateTime, formatPrice, formatQuantity,
  fundPriceDigits, looksLikeAShare, tradeAmountLabel, typeLabel
} from './stock-format';

export interface StockImportDeps {
  api: (path: string, opts?: any) => Promise<any>;
  getPortfolio: () => any;
  getSelectedAccountId: () => string;
  applyPortfolio: (data: any) => void;
  loadPortfolio: () => Promise<void>;
  toastErr: (message: string) => void;
  toastOk: (message: string) => void;
  onImported?: (data: any) => void;
  getQuoteSyncUntil?: () => number;
  setQuoteSyncUntil?: (value: number) => void;
}

const importState: any = {
  buffer: null, pdf: false, count: 0, preview: [], error: null, mode: 'merge', accountId: '',
  summary: null, format: '', currencies: [], currencyAccounts: {}, page: 1, pages: 1,
  history: null, historicalAll: false, historicalIndexes: new Set<number>()
};

const historicalImportCount = () => importState.historicalAll
  ? (importState.history?.count || 0) - importState.historicalIndexes.size : importState.historicalIndexes.size;
const historicalImportChecked = (index: number) => importState.historicalAll !== importState.historicalIndexes.has(index);

function resetHistoricalImport() {
  importState.history = null;
  importState.historicalAll = false;
  importState.historicalIndexes.clear();
}

function buildImportBody() {
  if (!historicalImportCount()) return importState.buffer;
  const metadata = new TextEncoder().encode(JSON.stringify({
    snapshot: importState.history.snapshot, all: importState.historicalAll, indexes: [...importState.historicalIndexes]
  }));
  const length = new ArrayBuffer(4);
  new DataView(length).setUint32(0, metadata.length);
  return new Blob([length, metadata, importState.buffer]);
}

function importRequestHeaders(layer: HTMLElement) {
  const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' };
  const password = ($('#import-pdf-password', layer) as HTMLInputElement | null)?.value;
  if (importState.pdf && password) headers.Password = encodeURIComponent(password);
  return headers;
}

function setImportAccountParams(params: URLSearchParams) {
  if (importState.currencies.length > 1) {
    if (importState.currencyAccounts.USD) params.set('usdAccountId', importState.currencyAccounts.USD);
    if (importState.currencyAccounts.HKD) params.set('hkdAccountId', importState.currencyAccounts.HKD);
  } else if (importState.accountId) params.set('accountId', importState.accountId);
}

function renderImportProgress(layer: HTMLElement, progress: any, saving = false) {
  const footer = $('#import-progress', layer);
  if (!footer) return;
  footer.hidden = saving || !progress;
  const busyBar = $('.sm-import-busy-progress', layer);
  if (!progress) return;
  const { phase, completed, total } = progress;
  const parsing = phase === 'parse' && completed < total;
  const message = phase === 'parse'
    ? parsing ? `已解析 ${completed} / ${total} 份，正在处理第 ${completed + 1} 份` : `已解析 ${completed} / ${total} 份`
    : ({ upload: '正在提交文件…', match: '解析完成，正在核对账户和交易…', quotes: '正在查询持仓行情…', save: '正在保存交易…' })[phase];
  const bar: any = saving ? busyBar : $('progress', footer);
  const label = saving ? $('.sm-modal-busy-label', layer) : $('[data-import-progress-text]', footer);
  if (label && label.textContent !== message) label.textContent = message;
  if (!bar) return;
  if (phase === 'parse') {
    bar.max = total;
    bar.value = completed;
  } else bar.removeAttribute('value');
}

const importChangeFields: Record<string, string> = {
  symbol: '代码', type: '交易方向', shares: '数量', price: '价格', total_amount: '金额', commission: '手续费',
  trade_date: '成交时间', other_category: '其它类别', cash_effective_at: '现金入账时间', reinvestmentNav: '折算净值'
};

function renderImportAction(trade: any) {
  const action = ({ added: '新增', updated: '更新（需确认）', skipped: '重复跳过', needsAssignment: '先核对未归属历史' } as any)[trade.importAction] || '新增';
  const changes = (trade.importChanges || []).filter((change: any) => Object.hasOwn(importChangeFields, change.field));
  if (!changes.length) return action;
  const currency = trade.currency || (looksLikeAShare(trade.symbol) ? 'CNY' : 'USD');
  const format = (key: string, value: any) => {
    if (value == null || value === '') return '—';
    if (key === 'commission' || key === 'total_amount') return fmtMoney(value, currency);
    if (key === 'shares') return formatQuantity(value);
    if (key === 'price' || key === 'reinvestmentNav') return formatPrice(value, currency, tradeAssetType(trade) === 'fund' ? fundPriceDigits(trade.symbol) : 3);
    if (key === 'trade_date' || key === 'cash_effective_at') return formatLocalDateTime(value);
    if (key === 'type') return typeLabel({ type: value });
    return value;
  };
  return `<div class="sm-import-action">${action}<details class="sm-import-changes">
    <summary>${changes.map((change: any) => importChangeFields[change.field]).join('、')}</summary>
    ${changes.map(({ field, before, after }: any) => `<div class="sm-lots-hint"><strong>${importChangeFields[field]}</strong><br>原值：${escapeHtml(format(field, before))}<br>导入值：${escapeHtml(format(field, after))}</div>`).join('')}
  </details></div>`;
}

function renderPagination({ page, pages, label, pageNumbers = false, extra = '' }: any) {
  const button = (target: number, text: string | number, options = '') =>
    `<button type="button" class="btn ghost sm-btn-sm" data-pagination-page="${target}" ${options}>${text}</button>`;
  const first = Math.max(1, Math.min(page - 3, pages - 6));
  const numbers = pageNumbers ? Array.from({ length: Math.min(pages, 7) }, (_, i) => {
    const number = first + i;
    return button(number, number, `data-pagination-number aria-label="第 ${number} 页"${number === page ? ' aria-current="page"' : ''}`);
  }).join('') : '';
  return `<nav class="sm-pagination" aria-label="${label}">
    ${button(page - 1, '上一页', page <= 1 ? 'disabled' : '')}
    <span class="sm-pagination-position" aria-live="polite">第 ${page} / ${pages} 页</span>
    ${numbers}
    ${button(page + 1, '下一页', page >= pages ? 'disabled' : '')}
    ${pages > 1 ? `<form class="sm-pagination-jump">
      <label>页码 <input name="page" type="number" inputmode="numeric" min="1" max="${pages}" step="1" required placeholder="${page}"></label>
      <button type="submit" class="btn ghost sm-btn-sm">跳转</button>
    </form>` : ''}
    ${extra}
  </nav>`;
}

function paginationTarget(form: HTMLFormElement) {
  if (!form.reportValidity()) return null;
  return (form.elements.namedItem('page') as HTMLInputElement).valueAsNumber;
}

export function openImportModal(deps: StockImportDeps) {
  importState.buffer = null;
  importState.pdf = false;
  importState.count = 0;
  importState.preview = [];
  importState.error = null;
  importState.mode = 'merge';
  const selected = deps.getSelectedAccountId();
  importState.accountId = selected === 'unassigned' ? '' : selected;
  importState.summary = null;
  importState.format = '';
  importState.currencies = [];
  importState.currencyAccounts = {};
  importState.page = importState.pages = 1;
  resetHistoricalImport();
  const accounts = deps.getPortfolio()?.investmentAccounts || [];
  const layer = openModal('导入交易', `
    <p class="hint">支持众安投资通知书和致富日结单 PDF，以及现有券商和应用备份 Excel。请选择对应币种的账户，更新已有记录须勾选确认。</p>
    <form id="import-form" class="sm-form-grid">
      <label id="import-single-account-field">所属证券账户<select id="import-account"><option value="">请选择账户（券商原始文件必选）</option>${accounts.map((a: any) => `<option value="${escapeHtml(a.id)}" ${a.id === importState.accountId ? 'selected' : ''}>${escapeHtml(a.name)} · ${escapeHtml(a.currency)}</option>`).join('')}</select></label>
      <div class="sm-import-currency-accounts" id="import-currency-accounts" hidden>
        ${[['USD', '美元'], ['HKD', '港币']].map(([currency, name]) => `<label>${name}证券账户<select data-import-currency-account="${currency}">
          <option value="">请选择${name}账户</option>
          ${accounts.filter((a: any) => a.currency === currency).map((a: any) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)}</option>`).join('')}
        </select></label>`).join('')}
      </div>
      <label>导入模式<select name="mode" id="import-mode">
        <option value="merge">合并到现有记录</option>
        <option value="replace">替换全部记录</option>
      </select></label>
      <label>交割单导入起始日（含利息）<input type="date" id="import-repo-start" value="${new Date(Date.parse(accounts.find((a: any) => a.id === importState.accountId || a.currency === 'CNY')?.baselineAt || new Date().toISOString()) + 8 * 3600000).toISOString().slice(0, 10)}"></label>
      <label><input type="checkbox" id="import-repo-baseline"> 起始日利息尚未包含在核对的现金基准中（仅东方财富回购利息）</label>
      <label id="import-dropzone" class="sm-import-dropzone">
        <span>拖拽文件到这里，或点击选择</span>
        <span class="hint">同一券商最多 30 份 PDF，美元和港币可同批上传。Excel 每批 1 份。整批上限 20 MB。</span>
        <input type="file" id="import-file" class="sm-file-input" aria-label="选择导入文件" accept=".pdf,.xlsx,.xls" multiple>
        <span id="import-file-status" class="hint" aria-live="polite"></span>
      </label>
      <label id="import-password-field" hidden>致富 PDF 密码<input id="import-pdf-password" type="password" autocomplete="off" maxlength="128" placeholder="留空使用账户默认密码"></label>
      <label><input type="checkbox" id="import-allow-updates"> 已核对预览，允许用券商数据更新匹配记录的数量、价格、费用和成交时间</label>
    </form>
    <div id="import-preview-area"></div>`, `
    <div class="sm-import-progress" id="import-progress" hidden>
      <span data-import-progress-text role="status" aria-live="polite"></span>
      <progress aria-label="导入解析进度"></progress>
    </div>
    <button type="button" class="btn ghost" data-close>取消</button>
    <button type="button" class="btn primary" id="import-confirm" disabled>导入</button>`, null, { size: 'xl' });
  layer.querySelector('[role="dialog"]')?.classList.add('sm-modal--import');
  $('.sm-modal-busy-label', layer)?.setAttribute('role', 'status');
  $('.sm-modal-busy', layer)?.insertAdjacentHTML('beforeend', '<progress class="sm-import-busy-progress" aria-label="导入处理进度"></progress>');

  const area = $('#import-preview-area', layer) as HTMLElement;
  const state = () => deps.getPortfolio();

  const renderImportPreviewSection = () => {
    if (importState.error) return `<div class="sm-error-box">${escapeHtml(importState.error)}</div>`;
    if (!importState.count && !importState.summary) return '';
    if (importState.summary?.missingCurrencies?.length) {
      return `<p class="hint">已识别 ${escapeHtml(importState.currencies.join('、'))} 单据。请选择 ${escapeHtml(importState.summary.missingCurrencies.join('、'))} 对应币种的证券账户继续预览。</p>`;
    }
    const names = new Map(importState.pdf ? (state().investmentAccounts || []).map((a: any) => [a.id, a.name]) : []);
    const rows = importState.preview.map((t: any) => `
      <tr>
        <td data-label="时间">${formatLocalDateTime(t.trade_date)}</td>
        <td data-label="类型">${escapeHtml(typeLabel(t))}${t.broker_category === 'Stockback 回赠' ? '<div class="hint">Stockback 回赠</div>' : ''}${t.historicalBackfill ? '<div class="hint">历史补录</div>' : ''}</td>
        <td data-label="代码">${escapeHtml(t.symbol)}</td>
        <td data-label="名称">${escapeHtml(t.name || '')}${names.has(t.account_id) ? `<div class="hint">${escapeHtml(names.get(t.account_id))} · ${escapeHtml(t.currency)}</div>` : ''}</td>
        <td data-label="数量">${t.type === 'other' ? '—' : formatQuantity(t.shares)}</td>
        <td data-label="价格">${t.type === 'other' ? '—' : formatPrice(t.reinvestedDividend ? t.reinvestmentNav : t.price, t.currency || (looksLikeAShare(t.symbol) ? 'CNY' : 'USD'), tradeAssetType(t) === 'fund' ? fundPriceDigits(t.symbol) : 3)}</td>
        <td data-label="本金">${tradeAmountLabel(t)}${Number.isFinite(t.broker_gross_dividend) ? `<div class="hint">毛息 ${fmtMoney(t.broker_gross_dividend, t.currency)} · 税 ${fmtMoney(t.broker_withholding_tax, t.currency)} · 代收费 ${fmtMoney(t.broker_dividend_fee, t.currency)}</div>` : ''}</td><td data-label="总费用">${fmtMoney(t.commission, (t.currency || (looksLikeAShare(t.symbol) ? 'CNY' : 'USD')))}</td>
        <td data-label="处理">${renderImportAction(t)}</td>
        ${importState.history?.count ? `<td data-label="历史补录">${Number.isInteger(t.historicalIndex)
          ? `<input type="checkbox" data-import-history-index="${t.historicalIndex}" aria-label="补录 ${escapeHtml(t.symbol)} 这笔历史交易" ${historicalImportChecked(t.historicalIndex) ? 'checked' : ''}>` : '—'}</td>` : ''}
      </tr>`).join('');
    return `
      <div class="sm-import-preview">
        <div class="sm-import-preview-head">预览（${importState.summary?.sourceCount != null ? '来源 ' + importState.summary.sourceCount + (importState.pdf ? ' 份，' : ' 条，') : ''}可导入 ${importState.count} 条，显示 ${importState.preview.length} 条）</div>
        ${importState.summary ? `<p class="hint">${({ eastmoney: '东方财富', fund: '场外基金', bbae: 'BBAE', 'za-pdf': '众安投资通知书', 'chief-pdf': '致富日结单' } as any)[importState.format]}：新增 ${importState.summary.added}，更新 ${importState.summary.updated}，重复跳过 ${importState.summary.skipped}。${importState.format === 'eastmoney' ? '按交收日期入账，费用包含佣金、其他费用、印花税和过户费。' : importState.format === 'bbae' ? '时间按北京时间；费用按“总计”反推。' : importState.pdf ? '单据仅提供成交日期时，新增记录显示为当日 15:00。现金按单据交收日计算。' : ''}</p>` : ''}
        ${importState.summary?.excluded?.length ? `<details><summary>未单独导入 ${importState.summary.excluded.reduce((s: number, x: any) => s + x.count, 0)} 条来源记录${importState.format === 'eastmoney' ? '（含新债合并入账）' : ''}，展开查看原因</summary>${importState.summary.excluded.map((x: any) => `<p class="hint">${escapeHtml(x.reason)}：${x.count} 条</p>`).join('')}</details>` : ''}
        ${(importState.summary?.warnings || []).map((x: string) => `<p class="hint">${escapeHtml(x)}</p>`).join('')}
        ${importState.summary?.unassigned ? `<p class="sm-error-box">${importState.summary.unassigned} 笔可能与未归属历史重复。请先核对原记录的账户归属，再重新预览；本次不会导入。</p>` : ''}
        ${importState.history?.count ? `<div class="sm-import-preview-head">
          <label><input type="checkbox" id="import-history-all"> 将全部 ${importState.history.count} 笔可选新增记录标记为历史补录</label>
          <p class="hint" id="import-history-count" aria-live="polite"></p>
          <p class="hint">只勾选已经计入账户余额的交易。持仓和盈亏照常记录，已绑定的记账账户不会重复计入这部分市值。</p>
        </div>` : !importState.accountId ? '<p class="hint">如需标记历史补录，请先选择实际所属证券账户，并使用合并模式。</p>' : ''}
        <div class="sm-table-wrap">
          <table class="sm-table">
            <thead><tr>
              <th>时间</th><th>类型</th><th>代码</th><th>名称</th><th>数量</th><th>价格</th><th>本金</th><th>总费用</th><th>处理</th>${importState.history?.count ? '<th>历史补录</th>' : ''}
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        ${renderPagination({ page: importState.page, pages: importState.pages, label: '导入预览分页' })}
      </div>`;
  };

  const currencySelects = [...layer.querySelectorAll('[data-import-currency-account]')] as HTMLSelectElement[];
  const syncPdfAccounts = () => {
    const multiple = importState.currencies.length > 1;
    const single = $('#import-single-account-field', layer);
    const multi = $('#import-currency-accounts', layer);
    if (single) single.hidden = multiple;
    if (multi) multi.hidden = !multiple;
    if (!multiple) return;
    const selectedAccount = (state().investmentAccounts || []).find((a: any) => a.id === importState.accountId);
    if (selectedAccount && !Object.hasOwn(importState.currencyAccounts, selectedAccount.currency)) {
      importState.currencyAccounts[selectedAccount.currency] = selectedAccount.id;
    }
    for (const select of currencySelects) select.value = importState.currencyAccounts[select.dataset.importCurrencyAccount as string] || '';
  };
  const syncHistory = () => {
    const all = $('#import-history-all', layer) as HTMLInputElement | null;
    if (!all) return;
    const count = historicalImportCount();
    all.checked = count === importState.history.count;
    all.indeterminate = count > 0 && !all.checked;
    const label = $('#import-history-count', layer);
    if (label) label.textContent = `已选 ${count} 笔历史补录`;
  };
  let revision = 0;
  let previewController: AbortController | undefined;
  const repoQuery = () => '&repoInterestStart=' + encodeURIComponent(($('#import-repo-start', layer) as HTMLInputElement).value)
    + (($('#import-repo-baseline', layer) as HTMLInputElement).checked ? '&repoInterestBaselineExcluded=1' : '');
  const previewFile = async (page = 1, keepSelection = false) => {
    if (!importState.buffer || layer.dataset.busy === '1') return;
    const current = ++revision;
    previewController?.abort();
    previewController = new AbortController();
    if (!keepSelection) {
      resetHistoricalImport();
      ($('#import-allow-updates', layer) as HTMLInputElement).checked = false;
    }
    const confirm = $('#import-confirm', layer) as HTMLButtonElement;
    confirm.disabled = true;
    confirm.textContent = '解析中…';
    area.inert = true;
    renderImportProgress(layer, { phase: 'upload' });
    try {
      const params = new URLSearchParams({ page: String(page), mode: importState.mode, progress: '1' });
      setImportAccountParams(params);
      const res = await fetch('./api/trades/import/preview?' + params + repoQuery(), {
        method: 'POST',
        headers: importRequestHeaders(layer),
        body: importState.buffer,
        signal: previewController.signal
      });
      const data = await readProgressResponse(res, (progress) => {
        if (current === revision && layer.isConnected) renderImportProgress(layer, progress);
      }, { failed: '导入预览失败', interrupted: '导入预览进度已中断' });
      if (current !== revision || !layer.isConnected) return;
      importState.count = data.count;
      importState.preview = data.preview || data.trades || [];
      importState.summary = data.summary || null;
      importState.format = data.format || '';
      importState.currencies = data.summary?.currencies || [];
      syncPdfAccounts();
      if (importState.history?.snapshot !== data.history?.snapshot) {
        resetHistoricalImport();
        ($('#import-allow-updates', layer) as HTMLInputElement).checked = false;
      }
      importState.history = data.history;
      importState.page = data.page || 1;
      importState.pages = data.pages || 1;
      const modeEl = $('#import-mode', layer) as HTMLSelectElement;
      modeEl.disabled = importState.pdf || ['bbae', 'eastmoney', 'fund'].includes(importState.format);
      if (modeEl.disabled) { modeEl.value = 'merge'; importState.mode = 'merge'; }
      importState.error = null;
    } catch (err: any) {
      if (current !== revision || !layer.isConnected) return;
      importState.count = 0;
      importState.preview = [];
      importState.summary = null;
      importState.error = err.message;
      deps.toastErr(err.message);
    }
    renderImportProgress(layer, null);
    area.innerHTML = renderImportPreviewSection();
    area.inert = false;
    syncHistory();
    const btn = $('#import-confirm', layer) as HTMLButtonElement | null;
    if (btn) {
      btn.disabled = importState.count === 0 || !!importState.summary?.unassigned;
      btn.textContent = importState.count > 0 ? `导入 (${importState.count} 条)` : '导入';
    }
  };
  area.addEventListener('change', ({ target }: any) => {
    if (target.id === 'import-history-all') {
      importState.historicalAll = target.checked;
      importState.historicalIndexes.clear();
      for (const row of area.querySelectorAll('[data-import-history-index]')) (row as HTMLInputElement).checked = target.checked;
    } else if (target.dataset.importHistoryIndex != null) {
      const index = Number(target.dataset.importHistoryIndex);
      if (target.checked !== importState.historicalAll) importState.historicalIndexes.add(index);
      else importState.historicalIndexes.delete(index);
    } else return;
    syncHistory();
  });
  area.addEventListener('click', (event: any) => {
    const button = event.target.closest('[data-pagination-page]');
    if (button) previewFile(Number(button.dataset.paginationPage), true);
  });
  area.addEventListener('submit', async (event: any) => {
    if (!event.target.matches('.sm-pagination-jump')) return;
    event.preventDefault();
    const page = paginationTarget(event.target);
    if (page == null || page === importState.page) return;
    await previewFile(page, true);
    ($('.sm-pagination-jump input', area) as HTMLElement | null)?.focus({ preventScroll: true });
  });
  $('#import-form', layer)?.addEventListener('submit', (event) => event.preventDefault());
  ($('#import-mode', layer) as HTMLSelectElement | null)?.addEventListener('change', (e: any) => {
    importState.mode = e.target.value;
    previewFile();
  });
  $('#import-repo-start', layer)?.addEventListener('change', () => previewFile());
  $('#import-repo-baseline', layer)?.addEventListener('change', () => previewFile());
  ($('#import-account', layer) as HTMLSelectElement | null)?.addEventListener('change', async (e: any) => {
    importState.accountId = e.target.value;
    await previewFile();
  });
  currencySelects.forEach((select) => select.addEventListener('change', () => {
    importState.currencyAccounts[select.dataset.importCurrencyAccount as string] = select.value;
    previewFile();
  }));
  $('#import-pdf-password', layer)?.addEventListener('change', () => previewFile());
  const drop = $('#import-dropzone', layer) as HTMLElement;
  const input = $('#import-file', layer) as HTMLInputElement;
  const setFiles = (files: File[]) => {
    if (!files.length || layer.dataset.busy === '1') return;
    revision++;
    previewController?.abort();
    renderImportProgress(layer, null);
    importState.buffer = null;
    importState.count = 0;
    importState.preview = [];
    importState.summary = null;
    importState.error = null;
    importState.currencies = [];
    importState.currencyAccounts = {};
    syncPdfAccounts();
    resetHistoricalImport();
    const confirm = $('#import-confirm', layer) as HTMLButtonElement;
    confirm.disabled = true;
    confirm.textContent = '导入';
    const pdf = files.every((file) => /\.pdf$/i.test(file.name));
    const excel = files.length === 1 && /\.xlsx?$/i.test(files[0].name);
    const fileNames = files.map((file) => file.name);
    const fileStatus = $('#import-file-status', layer);
    if (fileStatus) fileStatus.textContent = files.length > 1 ? `已选 ${files.length} 份文件 · ${fileNames.join('、')}` : fileNames[0];
    importState.pdf = pdf;
    const passwordField = $('#import-password-field', layer);
    if (passwordField) passwordField.hidden = !pdf;
    const mode = $('#import-mode', layer) as HTMLSelectElement;
    mode.disabled = pdf;
    if (pdf) mode.value = importState.mode = 'merge';
    if ((!pdf && !excel) || files.length > 30) {
      importState.error = '请上传最多 30 份同类型 PDF，或单独上传一份 Excel 文件';
    } else if (files.some((file) => !file.size) || files.reduce((size, file) => size + file.size + 4, 10) > 20 * 1024 * 1024) {
      importState.error = '文件不能为空，且整批不能超过 20 MB';
    }
    if (importState.error) {
      area.inert = false;
      area.innerHTML = renderImportPreviewSection();
      return;
    }
    if (pdf && files.length > 1) {
      const parts: any[] = ['STOCKPDF1\n'];
      for (const file of files) {
        const length = new ArrayBuffer(4);
        new DataView(length).setUint32(0, file.size);
        parts.push(length, file);
      }
      importState.buffer = new Blob(parts);
    } else importState.buffer = new Blob(files);
    previewFile();
  };
  input.addEventListener('change', () => {
    setFiles([...(input.files || [])]);
    input.value = '';
  });
  drop.addEventListener('dragover', (event) => {
    event.preventDefault();
    drop.classList.add('is-dragover');
  });
  drop.addEventListener('dragleave', (event: any) => {
    if (!drop.contains(event.relatedTarget)) drop.classList.remove('is-dragover');
  });
  drop.addEventListener('drop', (event: any) => {
    event.preventDefault();
    drop.classList.remove('is-dragover');
    setFiles([...event.dataTransfer.files]);
  });

  $('#import-confirm', layer)?.addEventListener('click', async () => {
    if (!importState.buffer || !importState.count) return;
    if (importState.summary?.updated && !($('#import-allow-updates', layer) as HTMLInputElement)?.checked) {
      deps.toastErr('存在待更新记录，请核对预览并勾选允许更新');
      return;
    }
    if (layer.dataset.busy === '1') return;
    setModalBusy(layer, true, '正在提交文件…');
    renderImportProgress(layer, { phase: 'upload' }, true);
    try {
      const history = historicalImportCount() > 0;
      const params = new URLSearchParams({
        mode: importState.mode,
        repoInterestStart: ($('#import-repo-start', layer) as HTMLInputElement).value,
        progress: '1'
      });
      setImportAccountParams(params);
      if (($('#import-repo-baseline', layer) as HTMLInputElement).checked) params.set('repoInterestBaselineExcluded', '1');
      if (($('#import-allow-updates', layer) as HTMLInputElement)?.checked) params.set('allowUpdates', '1');
      if (history) params.set('historicalSelection', '1');
      const res = await fetch('./api/trades/import?' + params, {
        method: 'POST',
        headers: importRequestHeaders(layer),
        body: buildImportBody()
      });
      const data = await readProgressResponse(res, (progress) => renderImportProgress(layer, progress, true));
      closeModal(layer);
      if (deps.getSelectedAccountId() && importState.currencies.length > 1) deps.loadPortfolio().catch((error) => deps.toastErr(error.message));
      else deps.applyPortfolio(data);
      const outcome = data.importSummary
        ? `新增 ${data.importSummary.added}，更新 ${data.importSummary.updated}，跳过重复 ${data.importSummary.skipped}`
        : `已导入 ${importState.count} 条交易`;
      if ((data.importQuoteRefreshCount || data.importHkdRatePending) && deps.setQuoteSyncUntil) {
        deps.setQuoteSyncUntil(Date.now() + 120_000);
      }
      deps.toastOk(outcome + (data.historicalBackfillCount ? `，历史补录 ${data.historicalBackfillCount} 笔` : '')
        + (data.importQuoteRefreshCount ? `；正在刷新 ${data.importQuoteRefreshCount} 个标的的行情` : '')
        + (data.importHkdRatePending ? '；正在补查港币汇率' : ''));
      deps.onImported?.(data);
      (window as any)._refreshTradeModal?.();
    } catch (err: any) {
      setModalBusy(layer, false);
      renderImportProgress(layer, null);
      deps.toastErr(err.message);
    }
  });
}
