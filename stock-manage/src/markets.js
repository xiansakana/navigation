/** A-share / mainland ETF symbol helpers (CNY). */
import { fundCode } from '../../shared/fund-holdings.js';

export function stripAShareDecorators(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  s = s.replace(/^(sh|sz|ss)\.?/i, '');
  s = s.replace(/\.(SH|SZ|SS)$/i, '');
  return s.trim();
}

/** True when symbol is a 6-digit A-share / 场内 ETF code (with optional SH/SZ decorators). */
export function isAShareSymbol(symbol) {
  const code = stripAShareDecorators(symbol);
  return /^\d{6}$/.test(code);
}

/**
 * Shanghai vs Shenzhen prefix for quote APIs.
 * Heuristic: leading 5/6/9 → sh; 0/1/2/3 → sz.
 */
export function ashareExchange(codeOrSymbol) {
  const code = stripAShareDecorators(codeOrSymbol);
  if (!/^\d{6}$/.test(code)) return null;
  if (code.startsWith('11')) return 'sh'; // Shanghai convertible bonds, e.g. 113708.
  const head = code[0];
  if (head === '5' || head === '6' || head === '9') return 'sh';
  return 'sz';
}

export function ashareCode(symbol) {
  const code = stripAShareDecorators(symbol);
  return /^\d{6}$/.test(code) ? code : '';
}

export function hkCode(symbol) {
  const match = String(symbol ?? '').trim().match(/^(?:HK\.?)?(\d{1,5})(?:\.HK)?$/i);
  return match && Number(match[1]) > 0 ? match[1].padStart(5, '0') : '';
}

/** Normalize for storage: A-share → 6 digits; US/option → uppercase. */
export function normalizeSymbol(symbol) {
  const raw = String(symbol || '').trim();
  if (!raw) return '';
  if (isAShareSymbol(raw)) return ashareCode(raw);
  const hk = hkCode(raw);
  return hk ? `${hk}.HK` : raw.toUpperCase();
}

/** @returns {'CN'|'HK'|'US'|'OPTION'|'FUND'} */
export function inferMarket(symbol) {
  const sym = String(symbol || '').trim();
  if (fundCode(sym)) return 'FUND';
  if (/^[A-Z]+\d{6}[CP]\d+(?:\.\d+)?$/i.test(sym)) return 'OPTION';
  if (isAShareSymbol(sym)) return 'CN';
  if (hkCode(sym)) return 'HK';
  return 'US';
}

export function inferCurrency(symbol, explicit) {
  const e = String(explicit || '').trim().toUpperCase();
  if (hkCode(symbol)) return 'HKD';
  if (fundCode(symbol)) return 'CNY';
  if (['CNY', 'USD', 'HKD'].includes(e)) return e;
  return inferMarket(symbol) === 'CN' ? 'CNY' : 'USD';
}

export function holdingTypeForSymbol(symbol) {
  const m = inferMarket(symbol);
  if (m === 'OPTION') return 'option';
  if (m === 'CN') return 'ashare';
  if (m === 'HK') return 'hkstock';
  if (m === 'FUND') return 'fund';
  return 'stock';
}
