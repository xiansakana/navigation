/** A-share / mainland ETF symbol helpers (CNY). */

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
  const head = code[0];
  if (head === '5' || head === '6' || head === '9') return 'sh';
  return 'sz';
}

export function ashareCode(symbol) {
  const code = stripAShareDecorators(symbol);
  return /^\d{6}$/.test(code) ? code : '';
}

/** Normalize for storage: A-share → 6 digits; US/option → uppercase. */
export function normalizeSymbol(symbol) {
  const raw = String(symbol || '').trim();
  if (!raw) return '';
  if (isAShareSymbol(raw)) return ashareCode(raw);
  return raw.toUpperCase();
}

/** @returns {'CN'|'US'|'OPTION'} */
export function inferMarket(symbol) {
  const sym = String(symbol || '').trim();
  if (/^[A-Z]+\d{6}[CP]\d+(?:\.\d+)?$/i.test(sym)) return 'OPTION';
  if (isAShareSymbol(sym)) return 'CN';
  return 'US';
}

export function inferCurrency(symbol, explicit) {
  const e = String(explicit || '').trim().toUpperCase();
  if (e === 'CNY' || e === 'USD') return e;
  return inferMarket(symbol) === 'CN' ? 'CNY' : 'USD';
}

export function holdingTypeForSymbol(symbol) {
  const m = inferMarket(symbol);
  if (m === 'OPTION') return 'option';
  if (m === 'CN') return 'ashare';
  return 'stock';
}
