import { createHash } from 'node:crypto';

export const importHistoryMetaLimit = 1024 * 1024;

export function decodeImportHistory(body, encoded) {
  if (!encoded) return { file: body, selection: null };
  if (body.length < 5) throw new Error('补录选择数据不完整，请重新预览');
  const length = body.readUInt32BE(0);
  if (!length || length > importHistoryMetaLimit || 4 + length >= body.length) throw new Error('补录选择数据无效，请重新预览');
  let selection;
  try { selection = JSON.parse(body.subarray(4, 4 + length).toString('utf8')); } catch { /* Handled below. */ }
  if (!selection || typeof selection.all !== 'boolean' || !Array.isArray(selection.indexes)
    || !selection.indexes.every(i => Number.isSafeInteger(i) && i >= 0)) throw new Error('补录选择数据无效，请重新预览');
  return { file: body.subarray(4 + length), selection };
}

export function importHistoryPlan(file, rows, account, mode) {
  const multiple = Array.isArray(account);
  const byId = multiple ? new Map(account.map(row => [row.id, row])) : null;
  const eligible = new Set();
  const actions = rows.map((row, index) => {
    const action = row.importAction || 'added';
    const enabled = mode === 'merge' && (multiple ? byId.has(row.account_id) : !!account);
    if (enabled && action === 'added' && !row.reinvestedDividend && ['buy', 'sell', 'other'].includes(row.type)
      && !row.historicalBackfill) eligible.add(index);
    const entry = [action, eligible.has(index), row.broker_order_key, row.symbol, row.type, row.trade_date,
      row.cash_effective_at, row.shares, row.price, row.total_amount, row.commission, row.other_category];
    if (multiple) entry.push(row.account_id);
    return entry;
  });
  const accountSnapshot = row => [row?.id, row?.baseline_at, row?.bookkeeping_id];
  const scope = multiple ? [account.map(accountSnapshot)] : accountSnapshot(account);
  const snapshot = createHash('sha256').update(file)
    .update(JSON.stringify([...scope, mode, actions])).digest('hex');
  return { eligible, snapshot };
}

export function selectHistoricalImports(history, selection) {
  if (!selection) return new Set();
  if (selection.snapshot !== history.snapshot || !selection.indexes.every(i => history.eligible.has(i))) {
    throw new Error('导入记录或账户已变化，请重新预览并确认历史补录项');
  }
  const indexes = new Set(selection.indexes);
  return selection.all ? new Set([...history.eligible].filter(i => !indexes.has(i))) : indexes;
}
