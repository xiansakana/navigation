import test from 'node:test';
import assert from 'node:assert/strict';
import { tradeAssetType } from './trade-asset-type.js';

test('trade types distinguish options, decorated A-shares and other receipts', () => {
  for (const symbol of ['159509', 'sz159509', '600000.SH']) assert.equal(tradeAssetType({ symbol }), 'ashare');
  for (const symbol of ['QQQ261009C600', 'aapl261009p250.5']) assert.equal(tradeAssetType({ symbol }), 'option');
  for (const symbol of ['AAPL', 'QQQ']) assert.equal(tradeAssetType({ symbol }), 'stock');
  assert.equal(tradeAssetType({ type: 'other', symbol: 'AAPL' }), 'other');
});
