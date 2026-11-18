const quantityFormat = new Intl.NumberFormat('en-US', {
  useGrouping: false, maximumSignificantDigits: 15, maximumFractionDigits: 12, roundingPriority: 'lessPrecision'
});

export function formatQuantity(value) {
  if (!Number.isFinite(value)) return '—';
  return value !== 0 && Math.abs(value) < 1e-12 ? String(value) : quantityFormat.format(value);
}

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
