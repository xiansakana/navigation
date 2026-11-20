import { createRequire } from 'node:module';

function loadDecimal() {
  for (const service of ['stock-manage', 'portal', 'qqq-dip']) {
    const require = createRequire(new URL(`../${service}/package.json`, import.meta.url));
    try {
      return require('decimal.js');
    } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error;
    }
  }
  throw new Error('decimal.js 未安装，请在证券服务目录安装依赖');
}

export const Decimal = loadDecimal().clone({ precision: 40 });

export function roundDecimal(value, places) {
  return new Decimal(value instanceof Decimal ? value : Number(value))
    .toDecimalPlaces(places, Decimal.ROUND_HALF_CEIL).toNumber();
}

export function tradeCashAmount(trade) {
  if (trade.historicalBackfill) return new Decimal(0);
  const amount = new Decimal(Number(trade.total_amount || 0));
  return (trade.type === 'buy' ? amount.negated() : amount).minus(Number(trade.commission || 0));
}
