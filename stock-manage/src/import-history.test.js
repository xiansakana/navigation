import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeImportHistory, importHistoryPlan, selectHistoricalImports } from './import-history.js';

test('only new cash-bearing rows can be selected, across preview pages, and stale previews are rejected', () => {
  const rows = Array.from({ length: 65 }, (_, i) => ({ type: 'buy', symbol: 'TSM', shares: i + 1, importAction: 'added' }));
  rows[0].importAction = 'updated';
  rows[1].importAction = 'skipped';
  rows[2].reinvestedDividend = true;
  const file = Buffer.from('one worksheet');
  const account = { id: 'usd', baseline_at: '2026-11-20', bookkeeping_id: 'linked' };
  const plan = importHistoryPlan(file, rows, account, 'merge');
  const only = { snapshot: plan.snapshot, all: false, indexes: [3, 61] };
  assert.deepEqual([...selectHistoricalImports(plan, only)], [3, 61]);
  const allExcept = selectHistoricalImports(plan, { ...only, all: true });
  assert.equal(allExcept.size, 60);
  assert.ok([0, 1, 2, 3, 61].every(index => !allExcept.has(index)));
  assert.throws(() => selectHistoricalImports(plan, { ...only, indexes: [0] }), /重新预览/);
  const changed = structuredClone(rows);
  changed[61].shares = 1;
  assert.throws(() => selectHistoricalImports(importHistoryPlan(file, changed, account, 'merge'), only), /重新预览/);
  assert.equal(importHistoryPlan(file, rows, account, 'replace').eligible.size, 0);
  assert.equal(importHistoryPlan(file, rows, null, 'merge').eligible.size, 0);

  const meta = Buffer.from(JSON.stringify(only));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(meta.length);
  assert.deepEqual(decodeImportHistory(Buffer.concat([header, meta, file]), true), { file, selection: only });
  assert.throws(() => decodeImportHistory(Buffer.concat([header, meta]), true), /补录选择数据无效/);
});

test('mixed account previews bind historical selections to both accounts and cash baselines', () => {
  const rows = [{ account_id: 'usd', type: 'buy' }, { account_id: 'hkd', type: 'sell' }, { account_id: 'foreign', type: 'buy' }];
  const accounts = [{ id: 'usd', baseline_at: '2026-10-01' }, { id: 'hkd', baseline_at: '2026-11-01' }];
  const file = Buffer.from('mixed pdf batch');
  const plan = importHistoryPlan(file, rows, accounts, 'merge');
  const selection = { snapshot: plan.snapshot, all: true, indexes: [] };
  assert.deepEqual([...selectHistoricalImports(plan, selection)], [0, 1]);
  const changed = [accounts[0], { ...accounts[1], baseline_at: '2026-11-02' }];
  assert.throws(() => selectHistoricalImports(importHistoryPlan(file, rows, changed, 'merge'), selection), /重新预览/);
  const reassigned = [{ ...rows[0], account_id: 'hkd' }, ...rows.slice(1)];
  assert.throws(() => selectHistoricalImports(importHistoryPlan(file, reassigned, accounts, 'merge'), selection), /重新预览/);
});
