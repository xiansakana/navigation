export const TRADE_ASSET_TYPES = { stock: '股票', option: '期权', ashare: 'A股', other: '其它收支' };

export function tradeAssetType(trade) {
  if (trade?.type === 'other') return 'other';
  const symbol = String(trade?.symbol || '').trim().toUpperCase();
  if (/^[A-Z]+\d{6}[CP]\d+(?:\.\d+)?$/.test(symbol)) return 'option';
  const code = symbol.replace(/^(SH|SZ|SS)\.?/, '').replace(/\.(SH|SZ|SS)$/, '');
  return /^\d{6}$/.test(code) ? 'ashare' : 'stock';
}
