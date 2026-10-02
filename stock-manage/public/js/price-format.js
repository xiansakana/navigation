// Unit prices use three decimals; monetary totals keep their own precision.
export function formatPrice(value, currency = '') {
  if (value == null || String(value).trim() === '' || !Number.isFinite(Number(value))) return '—';
  const prefix = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : '';
  return prefix + Number(value).toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}

export function priceInputValue(value) {
  if (value == null || String(value).trim() === '' || !Number.isFinite(Number(value))) return '';
  return Number(value).toFixed(3);
}
