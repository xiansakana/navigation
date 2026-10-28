import { assetTrends } from './bookkeeping-analysis.js';
import { createBookkeepingStore } from './bookkeeping-store.js';
import { historicalFx } from './bookkeeping-historical-fx.js';
import { effectiveBookkeepingFx, refreshBookkeepingFx } from './bookkeeping-fx.js';
import { SOCIAL_ACCOUNT_GROUP } from './bookkeeping-scope.js';
import { investmentReturns } from './bookkeeping-investment-returns.js';

const round = n => Math.round((n + Number.EPSILON) * 100) / 100;
export const assetDate = time => new Date(time + 8 * 3600000).toISOString().slice(0,10);
const previousDate = date => new Date(Date.parse(date + 'T12:00:00Z') - 86400000).toISOString().slice(0,10);
const captureTime = now => Date.parse(assetDate(now) + 'T23:59:00+08:00');
export const nextAssetCapture = now => captureTime(now) + (now >= captureTime(now) ? 86400000 : 0);

export function createAssetHistory(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS bookkeeping_asset_baselines (
    user_id TEXT PRIMARY KEY, cutover_date TEXT NOT NULL, history TEXT NOT NULL
  ); CREATE TABLE IF NOT EXISTS bookkeeping_asset_snapshots (
    user_id TEXT NOT NULL, date TEXT NOT NULL, captured_at TEXT NOT NULL, balance REAL NOT NULL,
    details TEXT NOT NULL, PRIMARY KEY(user_id,date)
  );`);
  function capture(userId, accounts, entries, rates, now = Date.now(), { snapshot = true, daily = false } = {}) {
    const linked = accounts.filter(a => a.included && a.balanceSource === 'portfolio');
    if (!linked.length || linked.some(a => !Number.isFinite(a.ledgerBalance))) return false;
    const date = assetDate(now);
    return db.transaction(() => {
      if (daily) {
        if (now < captureTime(now)) return false;
        const saved = db.prepare('SELECT captured_at FROM bookkeeping_asset_snapshots WHERE user_id=? AND date=?').get(userId,date);
        if (saved && Date.parse(saved.captured_at) >= captureTime(now)) return false;
      }
      const latest = db.prepare('SELECT MAX(date) AS date FROM bookkeeping_asset_snapshots WHERE user_id=?').get(userId);
      if (latest.date && date < latest.date) return false;
      let baseline = db.prepare('SELECT * FROM bookkeeping_asset_baselines WHERE user_id=?').get(userId);
      if (!baseline) {
        // Freeze the old ledger curve once. Future prices must never revalue these points.
        const ledger = accounts.map(a => a.balanceSource === 'portfolio' ? { ...a, balance:a.ledgerBalance, balanceSource:'ledger' } : a);
        const history = assetTrends(ledger, entries, date, rates, { end:previousDate(date) });
        if (!entries.length && Number.isFinite(history.current)) history.points=[{date:previousDate(date),currency:'CNY',balance:history.current}];
        if (!history.points.length || history.missingCurrencies.length) return false;
        history.accountHistories=Object.fromEntries(ledger.filter(a=>a.group===SOCIAL_ACCOUNT_GROUP).map(a=>{
          const curve=assetTrends(ledger.map(item=>({...item,included:item.id===a.id&&item.included})),entries.filter(e=>e.accountId===a.id||e.toAccountId===a.id),date,rates,{end:previousDate(date)});
          return [a.id,curve.points.length?curve.points:Number.isFinite(curve.current)?[{date:previousDate(date),currency:'CNY',balance:curve.current}]:[]];
        }));
        db.prepare('INSERT INTO bookkeeping_asset_baselines VALUES (?,?,?)').run(userId,date,JSON.stringify(history));
        baseline = { cutover_date:date };
      }
      if (date < baseline.cutover_date) return false;
      if (!snapshot) return true;
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
  function read(userId, filter = {}, today = assetDate(Date.now()), currentBalance = null, scope = {}) {
    const baseline = db.prepare('SELECT * FROM bookkeeping_asset_baselines WHERE user_id=?').get(userId);
    if (!baseline) return null;
    const history = JSON.parse(baseline.history);
    const snapshots = db.prepare('SELECT date,balance,captured_at,details FROM bookkeeping_asset_snapshots WHERE user_id=? AND date<=? ORDER BY date').all(userId,today);
    const excluded=new Set(scope.excludedAccountIds||[]);
    const atCurve=(curve,date)=>{
      let low=0,high=curve.length;
      while(low<high){const mid=(low+high)>>1;if(curve[mid].date<=date)low=mid+1;else high=mid;}
      return curve[Math.max(0,low-1)]?.balance??0;
    };
    let legacy=history.points.map(p=>({...p,source:'ledger'})), estimated=false;
    if(excluded.size) {
      const first=snapshots[0], details=first?JSON.parse(first.details):[];
      const knownEntries=first && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bookkeeping_entries'").get()
        ? new Set(db.prepare('SELECT id FROM bookkeeping_entries WHERE user_id=? AND created_at<=?').all(userId,first.captured_at).map(e=>e.id)) : null;
      const missingCurrencies=[],missingValuations=[];
      const curves=[...excluded].map(id=>{
        if(history.accountHistories && Object.hasOwn(history.accountHistories,id))return history.accountHistories[id];
        estimated=true;
        const observed=details.find(a=>a.id===id), account=scope.accounts?.find(a=>a.id===id);
        if(!account || (first && !observed))return [];
        const anchorDate=first?.date||today;
        const anchorRates={...scope.rates,...Object.fromEntries(details.map(a=>[a.currency,a.rate])),CNY:1};
        const anchorAccounts=scope.accounts.map(a=>({...a,included:a.id===id,balance:a.id===id?(observed?.balance??a.ledgerBalance??a.balance):a.balance,balanceSource:'ledger'}));
        const bills=(scope.entries||[]).filter(e=>(e.accountId===id||e.toAccountId===id)&&e.date.slice(0,10)<=anchorDate&&(!knownEntries||knownEntries.has(e.id)));
        const curve=assetTrends(anchorAccounts,bills,anchorDate,anchorRates);
        missingCurrencies.push(...curve.missingCurrencies);missingValuations.push(...(curve.missingValuations||[]));
        return curve.points;
      });
      if(missingCurrencies.length||missingValuations.length)return {points:[],missingCurrencies:[...new Set(missingCurrencies)],missingValuations,historyMode:'hybrid',period:null,note:'所选排除账户的历史汇率或余额不完整，暂无法计算筛选后的历史资产。'};
      const dates=[...new Set([...legacy.map(p=>p.date),...curves.flat().map(p=>p.date).filter(date=>date>=legacy[0].date&&date<=legacy.at(-1).date)])].sort();
      legacy=dates.map(date=>({date,currency:'CNY',source:'ledger',balance:round(atCurve(history.points,date)-curves.reduce((sum,curve)=>sum+atCurve(curve,date),0)),...(estimated?{scopeEstimated:true}:{})}));
    }
    const points=[...legacy,...snapshots.map(p=>({date:p.date,currency:'CNY',balance:excluded.size?round(JSON.parse(p.details).filter(a=>!excluded.has(a.id)).reduce((sum,a)=>sum+a.balance*a.rate,0)):p.balance,source:'valuation',capturedAt:p.captured_at}))];
    if (!points.length) return null;
    // Today's observation is a display-only estimate; never rewrite daily snapshots.
    const live = Number.isFinite(currentBalance);
    if (live) {
      const index=points.findIndex(p=>p.date===today);
      if(index>=0)points.splice(index);
      points.push({date:today,currency:'CNY',balance:round(currentBalance),source:'current'});
    }
    const start = filter.start || (filter.month ? filter.month + '-01' : history.period?.start || points[0].date);
    const requestedEnd = filter.end || (filter.month ? new Date(Date.UTC(Number(filter.month.slice(0,4)),Number(filter.month.slice(5,7)),0)).toISOString().slice(0,10) : today);
    const end = requestedEnd < today ? requestedEnd : today;
    const at = date => points.filter(p=>p.date<=date).at(-1) || points[0];
    const boundary = date => {const p=at(date);return {...p,date,asOf:p.date,source:p.date===date?p.source:'carried'};};
    const openingAsOf = previousDate(start), opening = at(openingAsOf), closing = at(end);
    const scoped = start<=end ? [{...boundary(openingAsOf),periodBoundary:'opening'},boundary(start),...points.filter(p=>p.date>start && p.date<end),...(end>start?[boundary(end)]:[])] : [];
    return { points:scoped, missingCurrencies:[], estimatedTransfers:history.estimatedTransfers, unlinkedEntries:history.unlinkedEntries,
      historyMode:'hybrid', valuationCutover:baseline.cutover_date, latestValuation:snapshots.at(-1)?.captured_at || null,
      ...(estimated?{scopeEstimatedBefore:baseline.cutover_date}:{}),
      current:points.at(-1).balance, asOf:points.at(-1).date,
      period:start<=end?{start,end,openingAsOf,opening:opening.balance,closing:closing.balance,change:round(closing.balance-opening.balance),openingSource:opening.source,closingSource:closing.source,closingAsOf:closing.date}:null,
      note:`${baseline.cutover_date} 前保留账单与余额调整反推的历史账面资产；从该日起按采集时的账户范围、现金及证券最新可用行情记录 CNY 估值，每天北京时间 23:59 采集一次。曲线包含范围首日前一日日末的期初基准，首尾差值与范围内资产变化一致。范围覆盖今天时使用当前账户余额、最新可用证券行情及当前汇率显示“今日暂估”，刷新不会改写历史快照。其他未采集日期沿用上一观测，不代表当日实际收盘净值；切换日可能包含账面与行情估值的口径差额，资产变化不等同投资收益。历史反推数据已冻结，不随最新股价重算。`+(excluded.size?' 已按选择排除社保公积金等账户；快照段使用各账户当时的余额与汇率。':'')+(estimated?` ${baseline.cutover_date} 前原冻结数据未保存账户拆分，排除部分按最早可用账户快照及账单反推，属于估算；原始总曲线保持不变。`:'') };
  }
  function returns(userId, filter, today, accounts, entries, rates, excludedAccountIds=[]) {
    const excluded=new Set(excludedAccountIds);
    const observations=db.prepare('SELECT date,captured_at,details FROM bookkeeping_asset_snapshots WHERE user_id=? AND date<=? ORDER BY date').all(userId,today)
      .map(p=>({date:p.date,capturedAt:p.captured_at,source:'valuation',accounts:JSON.parse(p.details).filter(a=>!excluded.has(a.id))}));
    const included=accounts.filter(a=>a.included && !excluded.has(a.id));
    if(included.length && included.every(a=>Number.isFinite(a.balance) && rates[a.currency]>0)) {
      const index=observations.findIndex(p=>p.date===today);if(index>=0)observations.splice(index);
      observations.push({date:today,capturedAt:new Date().toISOString(),source:'current',accounts:included.map(a=>({id:a.id,currency:a.currency,balance:a.balance,rate:rates[a.currency],source:a.balanceSource||'ledger'}))});
    }
    const events=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='investment_account_audit'").get()
      ? db.prepare("SELECT at,data FROM investment_account_audit WHERE user_id=? AND action IN ('cash-baseline','unlink')").all(userId).filter(e=>{
        const data=JSON.parse(e.data),id=data.before?.bookkeeping_id || data.input?.bookkeepingId || data.bookkeepingId;
        return !id || included.some(a=>a.id===id);
      }) : [];
    return investmentReturns(observations,entries,filter,today,events);
  }
  return { capture, read, returns };
}

export function startAssetHistory(db, { clock = Date.now, refresh = refreshBookkeepingFx, schedule = setTimeout, cancel = clearTimeout } = {}) {
  const history = createAssetHistory(db);
  let running = false;
  const collect = async () => {
    if (running || clock() < captureTime(clock())) return;
    running = true;
    try {
      const store = createBookkeepingStore(db), fx = historicalFx(db);
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='investment_accounts'").get()) return;
      const users = db.prepare('SELECT DISTINCT user_id FROM investment_accounts WHERE bookkeeping_id IS NOT NULL').all();
      for (const {user_id:userId} of users) {
        try {
          const saved = db.prepare('SELECT captured_at FROM bookkeeping_asset_snapshots WHERE user_id=? AND date=?').get(userId,assetDate(clock()));
          if (saved && Date.parse(saved.captured_at) >= captureTime(clock())) continue;
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
          history.capture(userId,store.accounts(userId),entries,effectiveBookkeepingFx(store.settings(userId)).rates,clock(),{daily:true});
        } catch (error) { console.error('[asset-history]', error.message); }
      }
    } catch (error) { console.error('[asset-history]', error.message); }
    finally { running = false; }
  };
  let timer, stopped = false;
  const arm = () => {
    if (stopped) return;
    timer = schedule(async()=>{await collect();arm();},Math.max(1,nextAssetCapture(clock())-clock()));
    timer.unref?.();
  };
  void collect();
  arm();
  return { collect, stop:()=>{stopped=true;cancel(timer);} };
}
