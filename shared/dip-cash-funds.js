import { requirePortfolioUserId } from './portfolio-user.js';
import { projectInvestments, investmentCashDelta, investmentRows, investmentRecordTime } from './investment-accounts.js';

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
export function dipCashFunds(db, userId, portfolio) {
  requirePortfolioUserId(userId); schema(db);
  const rows = db.prepare('SELECT * FROM dip_cash_funds WHERE user_id=?').all(userId);
  return projectInvestments(db, userId, portfolio).map((a) => {
    const reserved = (rows.find((r) => r.account_id === a.id)?.reserved || 0) / 100;
    return { accountId: a.id, name: a.name, currency: a.currency, cash: a.cash, reserved,
      ordinaryAvailable: Math.max(0, Math.round((a.cash - reserved) * 100) / 100),
      strategyAvailable: a.cash >= reserved ? reserved : 0,
      deficit: Math.max(0, Math.round((reserved - a.cash) * 100) / 100) };
  });
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
export function applyDipCashRules(db, userId, payload, before, options = {}) {
  schema(db);
  const existing = new Map(before.trades.map((t) => [t.id, t]));
  const accounts = investmentRows(db, userId);
  const baselines = new Map(accounts.map((a) => [a.id, {
    at: Math.floor(investmentRecordTime(a.baseline_at) / 1000) * 1000,
    ids: new Set(JSON.parse(a.baseline_trade_ids || '[]'))
  }]));
  const effective = (trade) => {
    const a = baselines.get(trade.account_id);
    return a && !a.ids.has(trade.id) && investmentRecordTime(trade.trade_date) >= a.at;
  };
  const reserveRows = db.prepare('SELECT * FROM dip_cash_funds WHERE user_id=?').all(userId);
  payload.trades = payload.trades.map((input) => {
    const trade = { ...input }; delete trade.dip_fund_account;
    const old = existing.get(trade.id);
    const fund = old?.dip_fund_account || (!old ? options.strategyFundId : null);
    if (fund) {
      if (trade.account_id !== fund || !reserveRows.some((r) => r.account_id === fund)) throw new Error('策略资金来源与证券账户不匹配');
      trade.dip_fund_account = fund;
      if (trade.type === 'buy' && trade.symbol === '159509' && Number(trade.shares) % 100 !== 0) throw new Error('159509 抄底买入须为100份整数倍');
      if (!old && !effective(trade)) throw new Error('策略成交必须晚于账户现金基准，历史补录请先核对资金归属');
    }
    return trade;
  });
  const next = new Map(payload.trades.map((t) => [t.id, t]));
  const strategy = new Map(), ordinary = new Map();
  for (const id of new Set([...existing.keys(), ...next.keys()])) {
    const a = existing.get(id), b = next.get(id);
    for (const [t, sign] of [[a, -1], [b, 1]]) {
      if (!t?.account_id) continue;
      if (!effective(t)) continue;
      const map = t.dip_fund_account ? strategy : ordinary;
      map.set(t.account_id, (map.get(t.account_id) || 0) + Math.round(investmentCashDelta(t) * 100) * sign);
    }
  }
  const projected = dipCashFunds(db, userId, payload);
  for (const row of reserveRows) {
    const delta = strategy.get(row.account_id) || 0;
    const remaining = row.reserved + delta;
    if (remaining < 0) throw new Error('抄底专用资金不足');
    const account = projected.find((a) => a.accountId === row.account_id);
    if (delta < 0 && (!account || account.cash * 100 + 0.5 < remaining)) throw new Error('账户现金低于策略预留，暂停抄底执行');
    if (!options.externalSync && (ordinary.get(row.account_id) || 0) < 0
      && (!account || account.cash * 100 + 0.5 < remaining)) throw new Error('普通可用现金不足，不能占用抄底预留；请先释放预留或调整买入');
    if (delta) {
      db.prepare('UPDATE dip_cash_funds SET reserved=? WHERE user_id=? AND account_id=?').run(remaining, userId, row.account_id);
      audit(db, userId, row.account_id, delta, '策略实际成交/交易更正');
    }
  }
}
