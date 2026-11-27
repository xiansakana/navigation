import crypto from 'node:crypto';
import { requirePortfolioUserId } from '../portfolio-user.js';
import { correctDividendTaxPortfolio } from '../dividend-tax.js';
import { Decimal, roundDecimal } from '../portfolio-decimal.js';
import {
  ledgerCashDelta,
  planHistoricalPositionAllocations,
  planHistoricalTradeCashCorrections,
  prepareInvestmentTradesFrom,
  projectInvestmentsFrom
} from '../investment-accounts.js';
import { dipCashFundsFrom, planDipCashRules } from '../dip-cash-funds.js';
import { normalizePortfolio, DEFAULT_USD_CNY_RATE } from './portfolio-store.js';

const roundMoney = (n) => roundDecimal(n, 2);
const num = (value) => value == null ? value : Number(value);

function mapInvestmentAccount(row) {
  return {
    ...row,
    baseline_cash: Number(row.baseline_cash),
    old_ledger_balance: row.old_ledger_balance == null ? null : Number(row.old_ledger_balance)
  };
}

function mapReserve(row) {
  return { ...row, reserved: Number(row.reserved) };
}

function mapLedger(row) {
  return { ...row, archived: Number(row.archived), opening: Number(row.opening) };
}

export function createPostgresPortfolioStore(db, userId, options = {}) {
  const owner = requirePortfolioUserId(userId);
  const sqlite = options.sqlite || null;
  const bookkeeping = options.bookkeepingDatabase || null;
  const tableExists = (name) => sqlite
    ? !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)
    : false;

  async function investmentRows(run, uid) {
    const { rows } = await run.query(`SELECT * FROM navigation.investment_accounts
      WHERE user_id=$1 ORDER BY created_at,id`, [uid]);
    return rows.map(mapInvestmentAccount);
  }

  async function fundRows(run, uid) {
    const { rows } = await run.query('SELECT * FROM navigation.fund_holdings WHERE user_id=$1 ORDER BY account_id,code', [uid]);
    return rows;
  }

  async function reserveRows(run, uid) {
    const { rows } = await run.query('SELECT * FROM navigation.dip_cash_funds WHERE user_id=$1', [uid]);
    return rows.map(mapReserve);
  }

  async function portfolioRow(run, uid, lock = false) {
    const { rows } = await run.query(`SELECT data FROM navigation.portfolio_users WHERE user_id=$1${lock ? ' FOR UPDATE' : ''}`, [uid]);
    return rows[0] ? normalizePortfolio(JSON.parse(rows[0].data)) : null;
  }

  async function ledgerContext(run, uid) {
    const ledgers = new Map();
    if (bookkeeping) {
      const { rows: accounts } = await run.query('SELECT id,name,archived,opening,currency,account_type FROM navigation.bookkeeping_accounts WHERE user_id=$1', [uid]);
      const { rows: entries } = await run.query('SELECT * FROM navigation.bookkeeping_entries WHERE user_id=$1 AND affects_balance=1', [uid]);
      for (const row of accounts) ledgers.set(row.id, mapLedger(row));
      return { ledgers, entries };
    }
    if (!sqlite) return { ledgers, entries: [] };
    const entries = tableExists('bookkeeping_entries')
      ? sqlite.prepare('SELECT * FROM bookkeeping_entries WHERE user_id=? AND affects_balance=1').all(uid) : [];
    if (tableExists('bookkeeping_accounts')) {
      for (const row of sqlite.prepare('SELECT id,name,archived,opening,currency,account_type FROM bookkeeping_accounts WHERE user_id=?').all(uid)) {
        ledgers.set(row.id, mapLedger(row));
      }
    }
    return { ledgers, entries };
  }

  async function readLedger(run, uid, id) {
    if (bookkeeping) {
      const { rows: [row] } = await run.query('SELECT * FROM navigation.bookkeeping_accounts WHERE user_id=$1 AND id=$2', [uid, id]);
      return row ? mapLedger(row) : null;
    }
    if (!sqlite || !tableExists('bookkeeping_accounts')) return null;
    const row = sqlite.prepare('SELECT * FROM bookkeeping_accounts WHERE user_id=? AND id=?').get(uid, id);
    return row ? mapLedger(row) : null;
  }

  async function balanceEntries(run, uid) {
    if (bookkeeping) {
      return (await run.query('SELECT * FROM navigation.bookkeeping_entries WHERE user_id=$1 AND affects_balance=1', [uid])).rows;
    }
    if (!sqlite || !tableExists('bookkeeping_entries')) return [];
    return sqlite.prepare('SELECT * FROM bookkeeping_entries WHERE user_id=? AND affects_balance=1').all(uid);
  }

  async function project(run, uid, raw) {
    const accounts = await investmentRows(run, uid);
    if (!accounts.length) return [];
    const funds = await fundRows(run, uid);
    const ledger = await ledgerContext(run, uid);
    const portfolio = raw ?? await portfolioRow(run, uid) ?? {};
    return projectInvestmentsFrom({ rows: accounts, funds, entries: ledger.entries, ledgers: ledger.ledgers, raw: portfolio });
  }

  async function readWith(run, uid = owner) {
    const data = await portfolioRow(run, uid) || normalizePortfolio({});
    const accounts = await investmentRows(run, uid);
    if (!accounts.length) return data;
    const investments = await project(run, uid, data);
    const sum = cur => roundMoney(investments.filter(a => a.currency === cur).reduce((s, a) => s.plus(a.cash), new Decimal(0)));
    const cashHkd = sum('HKD');
    const cash = sum('USD') + sum('CNY') / data.usdCnyRate + (cashHkd ? cashHkd / data.usdHkdRate : 0);
    return { ...data, cashUsd: sum('USD'), cashCny: sum('CNY'), cashHkd, cash: Number.isFinite(cash) ? roundMoney(cash) : null,
      investmentAccounts: investments, accountCashEnabled: true };
  }

  async function read(uid = owner) {
    return readWith(db, requirePortfolioUserId(uid));
  }

  async function readRaw(uid = owner) {
    return portfolioRow(db, requirePortfolioUserId(uid)) || normalizePortfolio({});
  }

  async function write(input, writeOptions = {}) {
    return db.transaction(async client => {
      const before = await portfolioRow(client, owner, true) || normalizePortfolio({});
      const payload = correctDividendTaxPortfolio(normalizePortfolio(input));
      const loadedAccounts = await investmentRows(client, owner);
      const funds = await fundRows(client, owner);
      const ledger = await ledgerContext(client, owner);
      const reserves = await reserveRows(client, owner);
      const accounts = loadedAccounts.map(account => ({ ...account }));
      payload.trades = prepareInvestmentTradesFrom({ next: payload.trades, before, accounts, funds });
      if (accounts.length) {
        // Managed cash is derived, never write a displayed aggregate back into its baseline.
        payload.cashUsd = before.cashUsd; payload.cashCny = before.cashCny; payload.cash = before.cash;
      }
      const at = new Date().toISOString();
      const cashCorrections = planHistoricalTradeCashCorrections({
        previousTrades: before.trades, nextTrades: payload.trades, accounts, at
      });
      const baselineUpdates = new Map();
      const addBaseline = (accountId, delta) => baselineUpdates.set(accountId, (baselineUpdates.get(accountId) || 0) + delta);
      for (const correction of cashCorrections) {
        addBaseline(correction.accountId, correction.adjustment);
        const account = accounts.find(a => a.id === correction.accountId);
        if (account) account.baseline_cash += correction.adjustment;
      }
      const allocation = planHistoricalPositionAllocations({ before, next: payload, accounts, at });
      for (const update of allocation.updates) {
        addBaseline(update.accountId, update.adjustment);
        const account = accounts.find(a => a.id === update.accountId);
        if (account) account.baseline_cash += update.adjustment;
      }
      const dipPlan = planDipCashRules({
        payload, before, accounts, reserveRows: reserves,
        options: { ...writeOptions, historicalCashCorrections: [...cashCorrections, ...allocation.corrections] },
        project: next => dipCashFundsFrom(projectInvestmentsFrom({
          rows: accounts, funds, entries: ledger.entries, ledgers: ledger.ledgers, raw: next
        }), reserves)
      });
      payload.trades = dipPlan.trades;
      await client.query(`INSERT INTO navigation.portfolio_users(user_id,data,updated_at) VALUES($1,$2,$3)
        ON CONFLICT(user_id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at`,
      [owner, JSON.stringify(payload), at]);
      for (const [accountId, delta] of baselineUpdates) {
        await client.query('UPDATE navigation.investment_accounts SET baseline_cash=baseline_cash+$1 WHERE user_id=$2 AND id=$3',
          [delta, owner, accountId]);
      }
      for (const audit of allocation.audits) {
        await client.query(`INSERT INTO navigation.investment_account_audit(user_id,account_id,action,data,at)
          VALUES($1,$2,'historical-position-allocation',$3,$4)`,
        [owner, audit.accountId, JSON.stringify(audit.data), audit.at]);
      }
      for (const correction of cashCorrections) {
        await client.query(`INSERT INTO navigation.investment_account_audit(user_id,account_id,action,data,at)
          VALUES($1,$2,'trade-cash-correction',$3,$4)`,
        [owner, correction.accountId, JSON.stringify(correction), at]);
      }
      for (const update of dipPlan.reserveUpdates) {
        await client.query('UPDATE navigation.dip_cash_funds SET reserved=$1 WHERE user_id=$2 AND account_id=$3',
          [update.remaining, owner, update.accountId]);
      }
      for (const entry of dipPlan.audits) {
        await client.query(`INSERT INTO navigation.dip_cash_fund_audit(user_id,account_id,delta,reason,at)
          VALUES($1,$2,$3,$4,$5)`, [owner, entry.accountId, entry.delta, entry.reason, entry.at]);
      }
      return readWith(client, owner);
    });
  }

  async function saveInvestmentAccount(uid, input, id) {
    const user = requirePortfolioUserId(uid);
    return db.transaction(async client => {
      const accounts = await investmentRows(client, user);
      const old = id ? accounts.find(a => a.id === id) : null;
      if (id && !old) throw new Error('证券账户不存在');
      const name = String(input.name ?? old?.name ?? '').trim();
      if (!name || name.length > 100) throw new Error('请填写100字以内的账户名称');
      const cur = input.currency || old?.currency;
      if (!['USD', 'CNY', 'HKD'].includes(cur) || (old && old.currency !== cur)) throw new Error('证券账户币种只能为 USD、CNY 或 HKD，创建后不可更改');
      const duplicate = await client.query('SELECT 1 FROM navigation.investment_accounts WHERE user_id=$1 AND currency=$2 AND name=$3 AND id!=$4',
        [user, cur, name, id || '']);
      if (duplicate.rowCount) throw new Error('同币种账户名称已存在，请使用可区分的名称');
      const reconcile = Object.hasOwn(input, 'baselineCash');
      if (!old && !reconcile) throw new Error('首次启用必须确认可用现金，不能使用券商总资产代替');
      const cents = (value) => {
        if (value === '' || value == null || !Number.isFinite(Number(value))) throw new Error('请填写有效的可用现金');
        const n = roundDecimal(new Decimal(Number(value)).times(100), 0);
        if (!Number.isSafeInteger(n)) throw new Error('请填写有效的可用现金');
        return n;
      };
      const baselineCash = reconcile ? cents(input.baselineCash) : old.baseline_cash;
      const baselineAt = reconcile ? new Date().toISOString() : old.baseline_at;
      const bookkeepingId = Object.hasOwn(input, 'bookkeepingId') ? input.bookkeepingId || null : old?.bookkeeping_id || null;
      let snapshot = old?.old_ledger_balance ?? null;
      if (old && old.bookkeeping_id && bookkeepingId !== old.bookkeeping_id) throw new Error('已绑定账户不可直接换绑，请先核对现金后解除绑定');
      if (bookkeepingId) {
        const ledger = await readLedger(client, user, bookkeepingId);
        if (!ledger) throw new Error('请先在记账模块创建理财账户');
        if (ledger.archived || ledger.currency !== cur || ledger.account_type === '信用卡') throw new Error('请选择本人名下、同币种、未归档的非信用卡账户');
        const bound = await client.query('SELECT 1 FROM navigation.investment_accounts WHERE user_id=$1 AND bookkeeping_id=$2 AND id!=$3',
          [user, bookkeepingId, id || '']);
        if (bound.rowCount) throw new Error('该记账账户已绑定其他证券账户');
        if (!old?.bookkeeping_id) {
          if (!reconcile) throw new Error('首次绑定需重新确认当前现金');
          const entries = await balanceEntries(client, user);
          snapshot = ledger.opening + entries.reduce((s, e) => s + ledgerCashDelta(e, bookkeepingId), 0);
        }
      }
      const accountId = old?.id || crypto.randomUUID();
      await client.query(`INSERT INTO navigation.investment_accounts
        (id,user_id,name,currency,bookkeeping_id,baseline_cash,baseline_at,old_ledger_balance,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,bookkeeping_id=excluded.bookkeeping_id,
          baseline_cash=excluded.baseline_cash,baseline_at=excluded.baseline_at,old_ledger_balance=excluded.old_ledger_balance`,
      [accountId, user, name, cur, bookkeepingId, baselineCash, baselineAt, snapshot, old?.created_at || baselineAt]);
      if (reconcile) {
        const entryIds = bookkeeping
          ? (await client.query('SELECT id FROM navigation.bookkeeping_entries WHERE user_id=$1', [user])).rows.map(e => e.id)
          : (sqlite && tableExists('bookkeeping_entries') ? sqlite.prepare('SELECT id FROM bookkeeping_entries WHERE user_id=?').all(user).map(e => e.id) : []);
        await client.query('UPDATE navigation.investment_accounts SET baseline_entry_ids=$1 WHERE user_id=$2 AND id=$3',
          [JSON.stringify(entryIds), user, accountId]);
        const portfolio = await portfolioRow(client, user);
        await client.query('UPDATE navigation.investment_accounts SET baseline_trade_ids=$1 WHERE user_id=$2 AND id=$3',
          [JSON.stringify((portfolio?.trades || []).map(t => t.id)), user, accountId]);
      }
      await client.query(`INSERT INTO navigation.investment_account_audit(user_id,account_id,action,data,at)
        VALUES($1,$2,$3,$4,$5)`,
      [user, accountId, reconcile ? 'cash-baseline' : 'rename',
        JSON.stringify({ before: old, input: { name, currency: cur, bookkeepingId, baselineCash: baselineCash / 100 } }),
        new Date().toISOString()]);
      return accountId;
    });
  }

  async function unlinkInvestmentAccount(uid, accountId) {
    const user = requirePortfolioUserId(uid);
    return db.transaction(async client => {
      const portfolio = await portfolioRow(client, user, true) || normalizePortfolio({});
      const accounts = await project(client, user, portfolio);
      const account = accounts.find(a => a.id === accountId);
      if (!account?.bookkeepingId) throw new Error('账户未绑定记账账户');
      if (account.equity == null) throw new Error('请先补齐行情，核对当前总资产后再解除绑定');
      const ledger = await readLedger(client, user, account.bookkeepingId);
      const entries = await balanceEntries(client, user);
      const oldBalance = ledger.opening + entries.reduce((s, e) => s + ledgerCashDelta(e, ledger.id), 0);
      const now = new Date().toISOString();
      const entryId = crypto.randomBytes(16).toString('hex');
      const entryDate = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 19);
      const amount = roundDecimal(new Decimal(Number(account.equity)).times(100), 0) - oldBalance;
      if (bookkeeping) {
        await client.query(`INSERT INTO navigation.bookkeeping_entries
          (id,user_id,date,type,amount,currency,category,account_id,note,affects_balance,raw,created_at)
          VALUES($1,$2,$3,'余额调整',$4,$5,'证券解绑估值',$6,'解除证券绑定，保存当时总资产',1,$7,$8)`,
        [entryId, user, entryDate, amount, account.currency, ledger.id, JSON.stringify({ kind: 'investment-unlink', accountId }), now]);
      } else if (sqlite && tableExists('bookkeeping_entries')) {
        sqlite.prepare(`INSERT INTO bookkeeping_entries(id,user_id,date,type,amount,currency,category,account_id,note,affects_balance,raw,created_at)
          VALUES(?,?,?,'余额调整',?,?,'证券解绑估值',?,'解除证券绑定，保存当时总资产',1,?,?)`)
          .run(entryId, user, entryDate, amount, account.currency, ledger.id, JSON.stringify({ kind: 'investment-unlink', accountId }), now);
      } else {
        throw new Error('请先在记账模块创建理财账户');
      }
      await client.query(`UPDATE navigation.investment_accounts
        SET bookkeeping_id=NULL,baseline_cash=$1,baseline_at=$2 WHERE user_id=$3 AND id=$4`,
      [Math.round(Number(account.cash) * 100), now, user, accountId]);
      await client.query('UPDATE navigation.investment_accounts SET baseline_trade_ids=$1 WHERE user_id=$2 AND id=$3',
        [JSON.stringify((portfolio.trades || []).map(t => t.id)), user, accountId]);
      await client.query(`INSERT INTO navigation.investment_account_audit(user_id,account_id,action,data,at)
        VALUES($1,$2,'unlink',$3,$4)`, [user, accountId, JSON.stringify(account), now]);
    });
  }

  async function dipFunds(uid, portfolio) {
    const user = requirePortfolioUserId(uid);
    const raw = portfolio || (await portfolioRow(db, user)) || normalizePortfolio({});
    const [investments, reserves] = await Promise.all([project(db, user, raw), reserveRows(db, user)]);
    return dipCashFundsFrom(investments, reserves);
  }

  async function setDipReserve(uid, accountId, amount) {
    const user = requirePortfolioUserId(uid);
    const cents = (value) => {
      const number = Number(value);
      if (value === '' || value == null || !Number.isFinite(number) || number < 0
        || !Number.isSafeInteger(Math.round(number * 100))) throw new Error('预留金额必须是有效的非负金额');
      return Math.round(number * 100);
    };
    const target = cents(amount);
    return db.transaction(async client => {
      const raw = await portfolioRow(client, user, true) || normalizePortfolio({});
      const investments = await project(client, user, raw);
      const reserves = await reserveRows(client, user);
      const account = dipCashFundsFrom(investments, reserves).find(a => a.accountId === accountId);
      if (!account) throw new Error('请选择本人名下的证券账户');
      if (target > cents(account.reserved) && target > Math.round(account.cash * 100)) throw new Error('账户现金不足，不能增加预留');
      await client.query(`INSERT INTO navigation.dip_cash_funds(user_id,account_id,reserved) VALUES($1,$2,$3)
        ON CONFLICT(user_id,account_id) DO UPDATE SET reserved=excluded.reserved`, [user, accountId, target]);
      await client.query(`INSERT INTO navigation.dip_cash_fund_audit(user_id,account_id,delta,reason,at)
        VALUES($1,$2,$3,$4,$5)`,
      [user, accountId, target - cents(account.reserved), '调整预留（不改变现金总额）', new Date().toISOString()]);
      const updatedReserves = await reserveRows(client, user);
      return dipCashFundsFrom(await project(client, user, raw), updatedReserves);
    });
  }

  async function saveFundHolding(uid, accountId, code, input) {
    const user = requirePortfolioUserId(uid);
    const result = await db.query(`INSERT INTO navigation.fund_holdings(user_id,account_id,code,name,shares,cost,nav,nav_date)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(user_id,account_id,code) DO NOTHING`,
    [user, accountId, code, input.name, input.shares, input.cost, input.nav, input.navDate]);
    return result.rowCount > 0;
  }

  async function updateFundHolding(uid, accountId, code, input) {
    const user = requirePortfolioUserId(uid);
    const result = await db.query('UPDATE navigation.fund_holdings SET name=$1,shares=$2,cost=$3 WHERE user_id=$4 AND account_id=$5 AND code=$6',
      [input.name, input.shares, input.cost, user, accountId, code]);
    return result.rowCount > 0;
  }

  async function removeFundHolding(uid, accountId, code) {
    const user = requirePortfolioUserId(uid);
    await db.query('DELETE FROM navigation.fund_holdings WHERE user_id=$1 AND account_id=$2 AND code=$3', [user, accountId, code]);
  }

  async function orderedAccountIds(uid) {
    const user = requirePortfolioUserId(uid);
    const { rows: [row] } = await db.query('SELECT value FROM navigation.portfolio_user_meta WHERE user_id=$1 AND key=$2',
      [user, 'investment_account_order']);
    return row ? JSON.parse(row.value) : null;
  }

  async function saveAccountOrder(uid, ids) {
    const user = requirePortfolioUserId(uid);
    return db.transaction(async client => {
      const accounts = await investmentRows(client, user);
      const owned = new Set(accounts.map(a => a.id));
      if (owned.size !== ids.length || ids.some(id => !owned.has(id))) return false;
      await client.query(`INSERT INTO navigation.portfolio_user_meta(user_id,key,value) VALUES($1,$2,$3)
        ON CONFLICT (user_id,key) DO UPDATE SET value=excluded.value`,
      [user, 'investment_account_order', JSON.stringify(ids)]);
      return true;
    });
  }

  async function meta(uid, key) {
    const user = requirePortfolioUserId(uid);
    const { rows: [row] } = await db.query('SELECT value FROM navigation.portfolio_user_meta WHERE user_id=$1 AND key=$2', [user, key]);
    return row?.value ?? null;
  }

  async function setMeta(uid, key, value) {
    const user = requirePortfolioUserId(uid);
    await db.query(`INSERT INTO navigation.portfolio_user_meta(user_id,key,value) VALUES($1,$2,$3)
      ON CONFLICT (user_id,key) DO UPDATE SET value=excluded.value`, [user, key, value == null ? '' : String(value)]);
  }

  return {
    userId: owner, db, mode: 'postgres',
    read, readRaw, write, project: (uid = owner, raw) => project(db, uid, raw),
    investmentRows: (uid = owner) => investmentRows(db, uid),
    fundHoldings: (uid = owner) => fundRows(db, uid),
    saveFundHolding, updateFundHolding, removeFundHolding,
    saveInvestmentAccount, unlinkInvestmentAccount,
    dipFunds, setDipReserve, orderedAccountIds, saveAccountOrder, meta, setMeta
  };
}

export { DEFAULT_USD_CNY_RATE };
