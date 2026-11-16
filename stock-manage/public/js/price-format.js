// Unit prices use three decimals; monetary totals keep their own precision.
export function formatPrice(value, currency = '', decimals = 3) {
  if (value == null || String(value).trim() === '' || !Number.isFinite(Number(value))) return '—';
  const prefix = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : currency === 'HKD' ? 'HK$' : '';
  return prefix + Number(value).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function priceInputValue(value, decimals = 3) {
  if (value == null || String(value).trim() === '' || !Number.isFinite(Number(value))) return '';
  return Number(value).toFixed(decimals);
}
