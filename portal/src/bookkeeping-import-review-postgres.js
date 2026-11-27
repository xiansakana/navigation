import { createHash } from 'node:crypto';
import { TRANSFER_TYPES } from './bookkeeping-store.js';
import { accountLedger } from './bookkeeping-ledger.js';
import { createPostgresBookkeepingStore } from './bookkeeping-postgres.js';

const day = date => String(date || '').slice(0, 10);
const fingerprint = e => JSON.stringify([e.date, e.type, e.currency, Math.round(e.amount * 100), e.accountName || '', e.toAccountName || '']);

export async function reviewIcostImportPostgres(db, portfolio, uid, rows, snapshots, selected, { visible, canPost, quote, expected } = {}) {
  return db.transaction(async client => {
    const runner = { query: (sql, args) => client.query(sql, args), transaction: fn => fn(client) };
    const store = createPostgresBookkeepingStore(runner, { portfolio });
    const accounts = await store.accounts(uid);
    const byName = new Map(accounts.map(a => [a.name, a]));
    const proposed = new Map(snapshots.map(a => [a.name, a]));
    const entries = await store.entries(uid);
    const accountNames = new Map(accounts.map(a => [a.id, a.name]));
    const adjustments = new Map();
    for (const entry of entries) {
      if (entry.type !== '余额调整') continue;
      const name = accountNames.get(entry.accountId);
      if (!adjustments.has(name)) adjustments.set(name, entry.date);
    }
    const existing = new Set(entries.map(fingerprint));
    const sources = new Set((await client.query('SELECT source_key FROM navigation.bookkeeping_entries WHERE user_id=$1 AND source_key IS NOT NULL', [uid]))
      .rows.map(r => r.source_key));
    const candidates = [], decisions = {}, touched = new Set(), reviewedAccounts = new Set();
    let unresolved = 0;
    for (const [index, row] of rows.entries()) {
      if (sources.has(row.sourceKey)) continue;
      const names = [row.accountName, row.toAccountName].filter(Boolean);
      const sides = names.map(name => {
        const a = byName.get(name), snapshot = a || proposed.get(name);
        const baseline = day(snapshot?.snapshotAt);
        const reconciled = [day(adjustments.get(name)), day(a?.investment?.baselineAt)].sort().at(-1);
        return { name, currency: snapshot?.currency || row.currency, baseline, reconciled, archived: !!a?.archived };
      });
      const date = day(row.date), similar = existing.has(fingerprint(row));
      const mixed = sides.some(a => a.baseline && date < a.baseline) && sides.some(a => !a.baseline || date >= a.baseline);
      const flags = [];
      if (similar) flags.push('账本已有同时间、金额和账户的记录');
      if (sides.some(a => a.reconciled >= date)) flags.push('之后已有余额核对');
      if (sides.some(a => a.baseline === date)) flags.push('发生在余额基准当天');
      if (sides.some(a => !a.baseline)) flags.push('余额基准日期未知');
      if (mixed) flags.push('两边余额基准不同，请跳过并分别核对');
      const transfer = TRANSFER_TYPES.includes(row.type);
      const canPostSide = side => {
        const account = byName.get(side.name);
        const investmentBaseline = day(account?.investment?.baselineAt);
        return side.currency === row.currency && !side.archived && date >= side.baseline
          && (!account || visible(account)) && (!investmentBaseline || date > investmentBaseline);
      };
      const postAllowed = !!canPost && !mixed && row.amount > 0 && !!row.accountName
        && (!transfer || !!row.toAccountName) && sides.every(canPostSide);
      if (transfer && sides.some(a => a.currency !== row.currency)) flags.push('跨币种转账缺少确认的到账金额');
      const review = similar || sides.some(a => !a.baseline || date >= a.baseline);
      const defaultDecision = review ? '' : 'history';
      const decision = selected?.[index] ?? defaultDecision;
      const valid = decision === 'skip' || (!mixed && decision === 'history') || (decision === 'post' && postAllowed);
      candidates.push({ index, date: row.date, type: row.type, amount: row.amount, currency: row.currency, note: row.note,
        sides, flags, postAllowed, historyAllowed: !mixed, defaultDecision });
      if (!valid) { unresolved++; decisions[index] = 'skip'; continue; }
      decisions[index] = decision;
      if (decision === 'skip') continue;
      names.forEach(name => touched.add(name));
      if (review) names.forEach(name => reviewedAccounts.add(name));
    }
    for (const snapshot of snapshots) touched.add(snapshot.name);
    await client.query('SAVEPOINT icost_review');
    let result;
    try {
      const imported = await store.importRows(uid, rows, snapshots, decisions);
      const after = await store.accounts(uid), ledgerEntries = await store.entries(uid);
      const balances = after.filter(a => touched.has(a.name) && visible(a)).map(a => {
        const current = byName.has(a.name) ? byName.get(a.name).balance : Number(proposed.get(a.name)?.balance ?? 0);
        const ledger = accountLedger(ledgerEntries, a, quote);
        const latest = ledger.values().next().value?.balanceAfter ?? null;
        const change = Number.isFinite(a.balance) && Number.isFinite(current) ? Math.round((a.balance - current) * 100) / 100 : null;
        const mismatch = latest !== null && Number.isFinite(a.balance) && Math.round((latest - a.balance) * 100) !== 0;
        return { name: a.name, currency: a.currency, current, change, after: a.balance, latest, mismatch, blocking: reviewedAccounts.has(a.name) && mismatch };
      });
      result = { ...imported, balances };
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT icost_review');
      await client.query('RELEASE SAVEPOINT icost_review');
    }
    const revision = createHash('sha256').update(JSON.stringify({ rows: candidates, decisions, snapshots, result })).digest('hex');
    if (expected !== undefined) {
      if (unresolved || revision !== expected || result.balances.some(a => a.blocking)) throw new Error('导入选择或账户余额尚未核对，请重新生成余额预览');
      return store.importRows(uid, rows, snapshots, decisions);
    }
    return { ...result, candidates, unresolved, revision };
  });
}
