import { mountTradeEditor } from './trade-editor';
import { TRADE_ASSET_TYPES, tradeAssetType } from '../../public/js/trade-asset-type.js';
import { isDividendTax, normalizeOtherAmount } from '../../../shared/dividend-tax.js';
import { priceInputValue } from '../../public/js/price-format.js';
import { bindTradeInstrument } from '../../public/js/trade-instrument.js';
import { openModal, $ } from './stock-modal';
import { escapeHtml, fmtPct, fundPriceDigits, looksLikeAShare, looksLikeHongKong, typeLabel } from './stock-format';

export interface StockTradeDeps {
  api: (path: string, opts?: any) => Promise<any>;
  can: (feature: string, action?: string) => boolean;
  getPortfolio: () => any;
  getSelectedAccountId: () => string;
  applyPortfolio: (data: any) => void;
  pnlQuery: () => string;
  toastErr: (message: string) => void;
  toastOk: (message: string) => void;
}

function toDatetimeLocalValue(iso?: string) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  const pad2 = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function datetimeLocalToIso(value: string | null) {
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return new Date().toISOString();
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] || 0)).toISOString();
}

function tradeEditorModel(trade: any, recordingAt: string, deps: StockTradeDeps) {
  const fund = tradeAssetType(trade) === 'fund';
  const digits = fund ? fundPriceDigits(trade.symbol) : 3;
  return {
    type: trade.reinvestedDividend ? 'reinvest' : trade.type || trade.prefillType || 'buy',
    currency: trade.currency || (looksLikeHongKong(trade.symbol) ? 'HKD' : (fund || looksLikeAShare(trade.symbol)) ? 'CNY' : 'USD'),
    accountId: trade.account_id || deps.getSelectedAccountId() || '',
    accounts: deps.getPortfolio()?.investmentAccounts || [],
    canChooseFunding: !trade.id && deps.can('dip-spend', 'edit'),
    historical: Boolean(trade.historicalBackfill),
    priceStep: digits === 5 ? '0.00001' : digits === 4 ? '0.0001' : '0.001',
    values: {
      trade_date: toDatetimeLocalValue(trade.trade_date || recordingAt),
      symbol: trade.symbol,
      name: trade.name,
      shares: trade.shares,
      price: priceInputValue(trade.price, digits),
      other_category: trade.other_category,
      total_amount: trade.total_amount,
      reinvestmentNav: trade.reinvestmentNav,
      commission: trade.commission ?? 0
    }
  } as any;
}

function bindTradeForm(root: HTMLElement) {
  const typeEl = root.querySelector('#trade-type') as HTMLSelectElement | null;
  if (!typeEl) return;
  const syncFields = () => {
    const other = typeEl.value === 'other';
    const reinvest = typeEl.value === 'reinvest';
    const historical = root.querySelector('[name="historicalBackfill"]') as HTMLInputElement | null;
    const funding = root.querySelector('[name="funding"]') as HTMLInputElement | null;
    if (historical) {
      historical.disabled = reinvest;
      historical.closest('label')?.classList.toggle('hidden', reinvest);
      if (historical.checked && !reinvest && funding) funding.value = 'ordinary';
    }
    if (funding) funding.disabled = Boolean(historical?.checked && !reinvest);
    root.querySelectorAll('.field-other,.field-other-amt').forEach((el) => el.classList.toggle('hidden', !other));
    root.querySelectorAll('.field-trade').forEach((el) => el.classList.toggle('hidden', other));
    root.querySelector('.field-price')?.classList.toggle('hidden', other || reinvest);
    root.querySelector('.field-reinvestment')?.classList.toggle('hidden', !reinvest);
    for (const field of ['commission', 'funding']) {
      root.querySelector(`[name="${field}"]`)?.closest('label')?.classList.toggle('hidden', reinvest);
    }
  };
  typeEl.addEventListener('change', syncFields);
  root.querySelector('[name="historicalBackfill"]')?.addEventListener('change', syncFields);
  syncFields();
}

function formToTrade(fd: FormData, existing: any = {}) {
  const type = fd.get('type') as string;
  const reinvest = type === 'reinvest';
  return {
    type: reinvest ? 'buy' : type,
    ...(reinvest ? { reinvestedDividend: true, reinvestmentNav: fd.get('reinvestmentNav') } : {}),
    ...(fd.get('account_id') ? { account_id: fd.get('account_id') } : {}),
    funding: reinvest ? 'ordinary' : fd.get('funding') || 'ordinary',
    historicalBackfill: !reinvest && fd.has('historicalBackfill'),
    symbol: String(fd.get('symbol') || '').trim(),
    name: String(fd.get('name') || '').trim(),
    currency: String(fd.get('currency') || 'USD').toUpperCase(),
    commission: Number(fd.get('commission')) || 0,
    trade_date: datetimeLocalToIso(fd.get('trade_date') as string),
    id: existing.id,
    ...(type === 'other'
      ? { other_category: String(fd.get('other_category') || '').trim(), total_amount: normalizeOtherAmount(fd.get('other_category'), fd.get('total_amount')) }
      : { shares: Number(fd.get('shares')), price: Number(fd.get('price')) })
  };
}

function bindReinvestmentNav(form: HTMLFormElement, deps: StockTradeDeps) {
  const symbol = form.elements.namedItem('symbol') as HTMLInputElement;
  const type = form.elements.namedItem('type') as HTMLSelectElement;
  const tradeDate = form.elements.namedItem('trade_date') as HTMLInputElement;
  const input = form.elements.namedItem('reinvestmentNav') as HTMLInputElement;
  const status = form.querySelector('[data-reinvestment-status]') as HTMLElement | null;
  if (!symbol || !type || !tradeDate || !input || !status) return () => {};
  const hint = status.textContent || '';
  let manual = !!input.value;
  let current: any;
  let timer: any;
  const lookupKey = () => {
    const code = ((form.dataset.resolvedSymbol || symbol.value) || '').trim().toUpperCase();
    const date = tradeDate.value.slice(0, 10);
    return type.value === 'reinvest' && /^\d{6}\.OF$/.test(code) && date ? { symbol: code, date } : null;
  };
  function lookup() {
    clearTimeout(timer);
    if (manual || !form.isConnected) return;
    const params = lookupKey();
    const key = JSON.stringify(params);
    if (key === current?.key) return current.promise;
    input.value = '';
    status.textContent = params ? '正在查询折算净值…' : hint;
    const request: any = { key };
    current = request;
    if (!params) return;
    const isCurrent = () => !manual && form.isConnected && current === request && JSON.stringify(lookupKey()) === key;
    request.promise = deps.api('/fund-reinvestment/nav?' + new URLSearchParams(params)).then((result: any) => {
      if (!isCurrent()) return;
      if (result?.nav > 0) {
        input.value = result.nav;
        status.textContent = `参考 ${result.date} 除息日单位净值估算，可按基金公告修改。`;
      } else {
        status.textContent = '未找到可匹配的分红净值，可留空或按公告填写。';
      }
    }).catch(() => {
      if (isCurrent()) status.textContent = '暂时无法查询净值，可留空或手动填写。';
    });
    return request.promise;
  }
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(lookup, 300);
  };
  input.addEventListener('input', () => { manual = true; });
  tradeDate.addEventListener('input', schedule);
  type.addEventListener('change', schedule);
  form.addEventListener('instrument-resolved', schedule);
  schedule();
  return lookup;
}

export async function openTradeModal(trade: any = {}, deps: StockTradeDeps) {
  if (document.querySelector('#trade-form')) return;
  const recordingAt = new Date().toISOString();
  const model = tradeEditorModel(trade, recordingAt, deps);
  const initialDateValue = model.values.trade_date;
  const layer = openModal(trade.id ? '编辑交易' : '记一笔', '', null, async (modal) => {
    const form = modal.querySelector('#trade-form') as HTMLFormElement | null;
    if (!form) throw new Error('交易表单加载失败');
    if (!await resolveInstrument()) throw new Error('请先确认代码对应的标的');
    const account = form.elements.namedItem('account_id') as HTMLSelectElement | null;
    if (account && !account.checkValidity()) throw new Error(account.value ? account.validationMessage : '请选择实际归属的证券账户');
    await resolveReinvestmentNav();
    const fd = new FormData(form);
    if (form.dataset.resolvedSymbol) fd.set('symbol', form.dataset.resolvedSymbol);
    const body = formToTrade(fd, trade);
    if (!trade.id && !trade.trade_date && fd.get('trade_date') === initialDateValue) body.trade_date = recordingAt;
    const data = trade.id
      ? await deps.api('/trades/' + trade.id + deps.pnlQuery(), { method: 'PUT', body })
      : await deps.api('/trades' + deps.pnlQuery(), { method: 'POST', body });
    deps.applyPortfolio(data);
    return trade.id ? '交易已更新' : '交易已保存';
  }, { reload: false });
  const container = layer.querySelector('.sm-modal-body') as HTMLElement;
  (layer as any).disposeTradeEditor = mountTradeEditor(container, model);
  bindTradeForm(container);
  const form = container.querySelector('#trade-form') as HTMLFormElement;
  const resolveReinvestmentNav = bindReinvestmentNav(form, deps);
  const resolveInstrument = bindTradeInstrument(form, {
    resolve: (symbol: string) => deps.api('/instruments/resolve?' + new URLSearchParams({ symbol })),
    accounts: deps.getPortfolio()?.investmentAccounts || [],
    assetTypes: TRADE_ASSET_TYPES
  });
  const category = layer.querySelector('[name="other_category"]') as HTMLInputElement | null;
  const amount = layer.querySelector('[name="total_amount"]') as HTMLInputElement | null;
  const taxHint = document.createElement('p');
  taxHint.className = 'hint';
  taxHint.textContent = '股息税属于支出，输入正数会自动改为负数。';
  amount?.closest('label')?.append(taxHint);
  const syncTaxAmount = () => {
    const tax = isDividendTax(category?.value);
    taxHint.hidden = !tax;
    if (tax && Number(amount?.value) > 0) amount!.value = String(-Number(amount!.value));
  };
  category?.addEventListener('input', syncTaxAmount);
  amount?.addEventListener('input', syncTaxAmount);
  amount?.addEventListener('change', syncTaxAmount);
  syncTaxAmount();
  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    (layer.querySelector('[data-modal-save]') as HTMLElement | null)?.click();
  });
}

export function fundPriceDigitsFor(symbol?: string) {
  return fundPriceDigits(symbol);
}

export { escapeHtml, fmtPct, typeLabel };
