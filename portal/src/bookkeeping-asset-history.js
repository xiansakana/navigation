import { assetTrends } from './bookkeeping-analysis.js';
import { createBookkeepingStore } from './bookkeeping-store.js';
import { historicalFx } from './bookkeeping-historical-fx.js';
import { effectiveBookkeepingFx, refreshBookkeepingFx } from './bookkeeping-fx.js';

const round = n => Math.round((n + Number.EPSILON) * 100) / 100;
export const assetDate = time => new Date(time + 8 * 3600000).toISOString().slice(0,10);
const previousDate = date => new Date(Date.parse(date + 'T12:00:00Z') - 86400000).toISOString().slice(0,10);

export function createAssetHistory(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS bookkeeping_asset_baselines (
    user_id TEXT PRIMARY KEY, cutover_date TEXT NOT NULL, history TEXT NOT NULL
  ); CREATE TABLE IF NOT EXISTS bookkeeping_asset_snapshots (
    user_id TEXT NOT NULL, date TEXT NOT NULL, captured_at TEXT NOT NULL, balance REAL NOT NULL,
    details TEXT NOT NULL, PRIMARY KEY(user_id,date)
  );`);
  function capture(userId, accounts, entries, rates, now = Date.now()) {
    const linked = accounts.filter(a => a.included && a.balanceSource === 'portfolio');
    if (!linked.length || linked.some(a => !Number.isFinite(a.ledgerBalance))) return false;
    const date = assetDate(now);
    return db.transaction(() => {
      const latest = db.prepare('SELECT MAX(date) AS date FROM bookkeeping_asset_snapshots WHERE user_id=?').get(userId);
      if (latest.date && date < latest.date) return false;
      let baseline = db.prepare('SELECT * FROM bookkeeping_asset_baselines WHERE user_id=?').get(userId);
      if (!baseline) {
        // Freeze the old ledger curve once. Future prices must never revalue these points.
        const ledger = accounts.map(a => a.balanceSource === 'portfolio' ? { ...a, balance:a.ledgerBalance, balanceSource:'ledger' } : a);
        const history = assetTrends(ledger, entries, date, rates, { end:previousDate(date) });
        if (!entries.length && Number.isFinite(history.current)) history.points=[{date:previousDate(date),currency:'CNY',balance:history.current}];
        if (!history.points.length || history.missingCurrencies.length) return false;
        db.prepare('INSERT INTO bookkeeping_asset_baselines VALUES (?,?,?)').run(userId,date,JSON.stringify(history));
        baseline = { cutover_date:date };
      }
      if (date < baseline.cutover_date) return false;
      const included = accounts.filter(a => a.included);
      if (included.some(a => !Number.isFinite(a.balance) || !(rates[a.currency] > 0))) return false;
      const balance = round(included.reduce((n,a) => n + a.balance * rates[a.currency],0));
      const details = included.map(a => ({ id:a.id, currency:a.currency, balance:a.balance, rate:rates[a.currency],
        source:a.balanceSource || 'ledger', quotes:a.investment?.positions?.map(p=>({symbol:p.symbol,asOf:p.quoteAsOf,price:p.price})) || [] }));
      // Each day's last observation becomes its historical valuation. Never overwrite an older observation.
      db.prepare(`INSERT INTO bookkeeping_asset_snapshots VALUES (?,?,?,?,?)
        ON CONFLICT(user_id,date) DO UPDATE SET captured_at=excluded.captured_at,balance=excluded.balance,details=excluded.details
        WHERE excluded.captured_at >= bookkeeping_asset_snapshots.captured_at`).run(userId,date,new Date(now).toISOString(),balance,JSON.stringify(details));
      return true;
    })();
  }
  function read(userId, filter = {}, today = assetDate(Date.now())) {
    const baseline = db.prepare('SELECT * FROM bookkeeping_asset_baselines WHERE user_id=?').get(userId);
    if (!baseline) return null;
    const history = JSON.parse(baseline.history);
    const snapshots = db.prepare('SELECT date,balance,captured_at FROM bookkeeping_asset_snapshots WHERE user_id=? AND date<=? ORDER BY date').all(userId,today);
    const points = [...history.points.map(p=>({...p,source:'ledger'})),...snapshots.map(p=>({date:p.date,currency:'CNY',balance:p.balance,source:'valuation',capturedAt:p.captured_at}))];
    if (!points.length) return null;
    const start = filter.start || (filter.month ? filter.month + '-01' : points[0].date);
    const requestedEnd = filter.end || (filter.month ? new Date(Date.UTC(Number(filter.month.slice(0,4)),Number(filter.month.slice(5,7)),0)).toISOString().slice(0,10) : today);
    const end = requestedEnd < today ? requestedEnd : today;
    const at = date => points.filter(p=>p.date<=date).at(-1) || points[0];
    const boundary = date => {const p=at(date);return {...p,date,asOf:p.date,source:p.date===date?p.source:'carried'};};
    const openingAsOf = previousDate(start), opening = at(openingAsOf), closing = at(end);
    const scoped = start<=end ? [boundary(start),...points.filter(p=>p.date>start && p.date<end),...(end>start?[boundary(end)]:[])] : [];
    return { points:scoped, missingCurrencies:[], estimatedTransfers:history.estimatedTransfers, unlinkedEntries:history.unlinkedEntries,
      historyMode:'hybrid', valuationCutover:baseline.cutover_date, latestValuation:snapshots.at(-1)?.captured_at || null,
      current:points.at(-1).balance, asOf:points.at(-1).date,
      period:start<=end?{start,end,openingAsOf,opening:opening.balance,closing:closing.balance,change:round(closing.balance-opening.balance),openingSource:opening.source,closingSource:closing.source,closingAsOf:closing.date}:null,
      note:`${baseline.cutover_date} 前保留账单与余额调整反推的历史账面资产；从该日起按采集时的账户范围、现金及证券最新可用行情记录 CNY 估值，每日保留最后一次观测。未采集日期沿用上一观测，不代表当日实际收盘净值；切换日可能包含账面与行情估值的口径差额，资产变化不等同投资收益。历史反推数据已冻结，不随最新股价重算。` };
  }
  return { capture, read };
}

export function startAssetHistory(db, { intervalMs = 300000, clock = Date.now, refresh = refreshBookkeepingFx } = {}) {
  const history = createAssetHistory(db);
  let running = false;
  const collect = async () => {
    if (running) return;
    running = true;
    try {
      const store = createBookkeepingStore(db), fx = historicalFx(db);
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='investment_accounts'").get()) return;
      const users = db.prepare('SELECT DISTINCT user_id FROM investment_accounts WHERE bookkeeping_id IS NOT NULL').all();
      for (const {user_id:userId} of users) {
        try {
          const original = store.entries(userId);
          const accounts = store.accounts(userId);
          const destinations = original.filter(e=>e.toAccountId).map(e=>({...e,currency:accounts.find(a=>a.id===e.toAccountId)?.currency || e.currency}));
          await fx.ensure([...original,...destinations]);
          await refresh(store,userId);
          const entries = store.entries(userId).map(fx.enrich);
          for (const e of entries) if (e.toAccountId) {
            const currency = accounts.find(a=>a.id===e.toAccountId)?.currency;
            e.toHistoricalRate = currency ? fx.quote(currency,e.date.slice(0,10))?.rate : null;
            if (e.toAmount!=null && !e.toHistoricalRate) e.toFxMissing=currency;
          }
          // Read balances again after network requests so the observation is current.
          history.capture(userId,store.accounts(userId),entries,effectiveBookkeepingFx(store.settings(userId)).rates,clock());
        } catch (error) { console.error('[asset-history]', error.message); }
      }
    } catch (error) { console.error('[asset-history]', error.message); }
    finally { running = false; }
  };
  void collect();
  const timer = setInterval(collect,intervalMs); timer.unref();
  return { collect, stop:()=>clearInterval(timer) };
}
