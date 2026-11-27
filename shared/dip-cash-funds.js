import { requirePortfolioUserId } from './portfolio-user.js';
import { projectInvestments, investmentCashDelta, investmentRows, tradeCashBaseline, tradeAfterCashBaseline } from './investment-accounts.js';

const cents = (value) => {
  const number = Number(value);
  if (value === '' || value == null || !Number.isFinite(number) || number < 0
    || !Number.isSafeInteger(Math.round(number * 100))) throw new Error('预留金额必须是有效的非负金额');
  return Math.round(number * 100);
};
function schema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS dip_cash_funds (
    user_id TEXT NOT NULL, account_id TEXT NOT NULL, reserved INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(user_id,account_id));
    CREATE TABLE IF NOT EXISTS dip_cash_fund_audit (
      id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, account_id TEXT NOT NULL,
      delta INTEGER NOT NULL, reason TEXT NOT NULL, at TEXT NOT NULL);`);
}

export function dipCashFundsFrom(accounts, reserveRows = []) {
  return accounts.map((a) => {
    const reserved = (reserveRows.find((r) => r.account_id === a.id)?.reserved || 0) / 100;
    return { accountId: a.id, name: a.name, currency: a.currency, cash: a.cash, reserved,
      ordinaryAvailable: Math.max(0, Math.round((a.cash - reserved) * 100) / 100),
      strategyAvailable: a.cash >= reserved ? reserved : 0,
      deficit: Math.max(0, Math.round((reserved - a.cash) * 100) / 100) };
  });
}

export function dipCashFunds(db, userId, portfolio) {
  requirePortfolioUserId(userId); schema(db);
  const rows = db.prepare('SELECT * FROM dip_cash_funds WHERE user_id=?').all(userId);
  return dipCashFundsFrom(projectInvestments(db, userId, portfolio), rows);
}
function audit(db, userId, accountId, delta, reason) {
  db.prepare('INSERT INTO dip_cash_fund_audit(user_id,account_id,delta,reason,at) VALUES(?,?,?,?,?)')
    .run(userId, accountId, delta, reason, new Date().toISOString());
}
export function setDipCashReserve(db, userId, accountId, amount) {
  requirePortfolioUserId(userId); schema(db);
  const target = cents(amount);
  return db.transaction(() => {
    const account = dipCashFunds(db, userId).find((a) => a.accountId === accountId);
    if (!account) throw new Error('请选择本人名下的证券账户');
    if (target > cents(account.reserved) && target > Math.round(account.cash * 100)) throw new Error('账户现金不足，不能增加预留');
    db.prepare('INSERT INTO dip_cash_funds(user_id,account_id,reserved) VALUES(?,?,?) ON CONFLICT(user_id,account_id) DO UPDATE SET reserved=excluded.reserved')
      .run(userId, accountId, target);
    audit(db, userId, accountId, target - cents(account.reserved), '调整预留（不改变现金总额）');
    return dipCashFunds(db, userId);
  }).immediate();
}

// Called within the portfolio write transaction, across all trade entry points.
// Only a server-authorized write option can classify a new trade as strategy.
// Pure planner shared by the SQLite store and the PostgreSQL repository.
export function planDipCashRules({ payload, before, accounts, reserveRows, options = {}, project }) {
  if (typeof project !== 'function') throw new Error('缺少组合投影函数');
  const existing = new Map(before.trades.map((t) => [t.id, t]));
  const baselines = new Map(accounts.map(a => [a.id, tradeCashBaseline(a)]));
  const effective = trade => tradeAfterCashBaseline(trade, baselines.get(trade.account_id));
  const classified = payload.trades.map((input) => {
    const trade = { ...input }; delete trade.dip_fund_account;
    const old = existing.get(trade.id);
    const fund = old?.dip_fund_account || (!old ? options.strategyFundId : null);
    if (fund) {
      if (trade.historicalBackfill) throw new Error('补录历史交易不能使用抄底专用资金');
      if (trade.account_id !== fund || !reserveRows.some((r) => r.account_id === fund)) throw new Error('策略资金来源与证券账户不匹配');
      trade.dip_fund_account = fund;
      if (trade.type === 'buy' && ['159509', '513850', '161128'].includes(trade.symbol) && Number(trade.shares) % 100 !== 0) throw new Error(`${trade.symbol} 抄底买入须为100份整数倍`);
      if (!old && !effective(trade)) throw new Error('策略成交必须晚于账户现金基准，历史补录请先核对资金归属');
    }
    return trade;
  });
  const next = new Map(classified.map((t) => [t.id, t]));
  const strategy = new Map(), ordinary = new Map();
  for (const correction of options.historicalCashCorrections || []) {
    const map = correction.strategy ? strategy : ordinary;
    map.set(correction.accountId, (map.get(correction.accountId) || 0) + correction.adjustment);
  }
  for (const id of new Set([...existing.keys(), ...next.keys()])) {
    const a = existing.get(id), b = next.get(id);
    for (const [t, sign] of [[a, -1], [b, 1]]) {
      if (!t?.account_id) continue;
      if (!effective(t)) continue;
      const map = t.dip_fund_account ? strategy : ordinary;
      map.set(t.account_id, (map.get(t.account_id) || 0) + Math.round(investmentCashDelta(t) * 100) * sign);
    }
  }
  const projected = project({ ...payload, trades: classified });
  const reserveUpdates = [], audits = [];
  for (const row of reserveRows) {
    const delta = strategy.get(row.account_id) || 0;
    const remaining = row.reserved + delta;
    if (remaining < 0) throw new Error('抄底专用资金不足');
    const account = projected.find((a) => a.accountId === row.account_id);
    if (delta < 0 && (!account || account.cash * 100 + 0.5 < remaining)) throw new Error('账户现金低于策略预留，暂停抄底执行');
    if (!options.externalSync && (ordinary.get(row.account_id) || 0) < 0
      && (!account || account.cash * 100 + 0.5 < remaining)) throw new Error('普通可用现金不足，不能占用抄底预留；请先释放预留或调整买入');
    if (delta) {
      reserveUpdates.push({ accountId: row.account_id, remaining });
      audits.push({ accountId: row.account_id, delta, reason: '策略实际成交/交易更正', at: new Date().toISOString() });
    }
  }
  return { trades: classified, reserveUpdates, audits };
}

export function applyDipCashRules(db, userId, payload, before, options = {}) {
  schema(db);
  const accounts = investmentRows(db, userId);
  const reserveRows = db.prepare('SELECT * FROM dip_cash_funds WHERE user_id=?').all(userId);
  const plan = planDipCashRules({
    payload, before, accounts, reserveRows, options,
    project: next => dipCashFundsFrom(projectInvestments(db, userId, next), reserveRows)
  });
  payload.trades = plan.trades;
  for (const update of plan.reserveUpdates) {
    db.prepare('UPDATE dip_cash_funds SET reserved=? WHERE user_id=? AND account_id=?')
      .run(update.remaining, userId, update.accountId);
  }
  for (const entry of plan.audits) audit(db, userId, entry.accountId, entry.delta, entry.reason);
}
