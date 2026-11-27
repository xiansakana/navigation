import { formatPrice, formatQuantity } from '../../public/js/price-format.js';

export const TOAST = {
  error(message: string) {
    if (typeof (window as any).portalToast?.error === 'function') (window as any).portalToast.error(message);
    else window.alert(message);
  },
  warn(message: string) {
    if (typeof (window as any).portalToast?.warn === 'function') (window as any).portalToast.warn(message);
    else window.alert(message);
  },
  ok(message: string) {
    if (typeof (window as any).portalToast?.success === 'function') (window as any).portalToast.success(message);
    else window.alert(message);
  },
  info(message: string) {
    if (typeof (window as any).portalToast?.info === 'function') (window as any).portalToast.info(message);
    else window.alert(message);
  }
};

export const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (char) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>
)[char]);

export const fmt = (n: number) => Number.isFinite(n)
  ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
export const fmtUsd = (n: number) => Number.isFinite(n) ? '$' + fmt(n) : '—';
export const fmtCny = (n: number) => Number.isFinite(n) ? '¥' + fmt(n) : '—';
export const fmtMoney = (n: number, currency = 'USD') => {
  if (!Number.isFinite(n)) return '—';
  const prefix: Record<string, string> = { USD: '$', CNY: '¥', HKD: 'HK$' };
  return (prefix[currency] || '') + fmt(n);
};
export const fmtUsdSigned = (n: number) => !Number.isFinite(n) ? '—' : `${n >= 0 ? '+' : ''}$${fmt(n)}`;
export const fmtMoneySigned = (n: number, currency = 'USD') => !Number.isFinite(n)
  ? '—' : (n >= 0 ? '+' : '-') + fmtMoney(Math.abs(n), currency);
export const fmtMoneyPair = (usd: number, cny: number, format = fmtMoney) => `${format(usd, 'USD')}（${format(cny, 'CNY')}）`;
export const fmtCommission = (n: number, currency = 'USD') => {
  if (!Number.isFinite(n) || !(n > 0)) return '—';
  return '-' + fmtMoney(n, currency);
};
export const fmtPct = (n: number) => Number.isFinite(n) ? n.toFixed(2) + '%' : '—';
export const cls = (n: number) => n > 0 ? 'pos' : n < 0 ? 'neg' : '';
export const MASK = '<span class="sm-mask">—</span>';
export const fundPriceDigits = (symbol?: string) => /^HK\d{10}$/i.test(symbol || '') ? 5 : 4;
export { formatPrice, formatQuantity };

const pad2 = (n: number) => String(n).padStart(2, '0');

export function localDateParts(iso?: string) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return null;
  return {
    y: d.getFullYear(), m: pad2(d.getMonth() + 1), day: pad2(d.getDate()),
    h: pad2(d.getHours()), min: pad2(d.getMinutes()), s: pad2(d.getSeconds())
  };
}

export function formatLocalDateTime(iso?: string) {
  const p = localDateParts(iso);
  return p ? `${p.y}-${p.m}-${p.day} ${p.h}:${p.min}:${p.s}` : (iso || '—');
}

export function localDateKey(iso?: string) {
  const p = localDateParts(iso);
  return p ? `${p.y}-${p.m}-${p.day}` : String(iso || '').slice(0, 10);
}

export function looksLikeAShare(symbol?: string) {
  const s = String(symbol || '').trim().replace(/^(sh|sz|ss)\.?/i, '').replace(/\.(SH|SZ|SS)$/i, '');
  return /^\d{6}$/.test(s);
}

export function looksLikeHongKong(symbol?: string) {
  return /^(?:HK\.?)?\d{1,5}(?:\.HK)?$/i.test(String(symbol || '').trim());
}

export function holdingTypeLabel(h: any) {
  if (h.type === 'hkstock') return '港股';
  if (h.type === 'fund') return '场外基金';
  if (h.type === 'option') return '期权';
  if (h.type === 'ashare' || h.currency === 'CNY' || looksLikeAShare(h.symbol)) return 'A股/ETF';
  return '股票';
}

export function typeLabel(t: any) {
  if (t.reinvestedDividend) return '红利再投资';
  if (t.type === 'buy') return '买入';
  if (t.type === 'sell') return '卖出';
  if (t.type === 'other') return '其它/' + (t.other_category || '');
  return t.type;
}

export function tradeAmountLabel(trade: any) {
  const currency = trade.currency || (looksLikeAShare(trade.symbol) ? 'CNY' : 'USD');
  if (trade.reinvestedDividend) return trade.estimatedReinvestmentIncome == null ? '—'
    : `估算 ${fmtMoney(trade.estimatedReinvestmentIncome, currency)}`;
  return fmtMoney(trade.total_amount, currency);
}

export const pnlToday = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
export const pnlIso = (day: Date) => day.toISOString().slice(0, 10);
