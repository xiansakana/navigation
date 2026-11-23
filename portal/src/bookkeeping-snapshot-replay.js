import { investmentCashDelta, investmentRecordTime, tradeAfterCashBaseline, tradeCashBaseline } from '../../shared/investment-accounts.js';
import { inferCurrency, isAShareSymbol } from '../../stock-manage/src/markets.js';
import { tradeDay, tradeStamp, optionSymbol } from './bookkeeping-trade-returns.js';

export const snapshotDay = time => new Date(time + 8*3600000 - 86400000).toISOString().slice(0,10);
export const isOvernightSnapshot = row => snapshotDay(Date.parse(row.captured_at)) === row.date;
const exists = (db, name) => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const usable = price => typeof price === 'number' && Number.isFinite(price) && price >= 0;

function cachedClose(point, symbol, date, actions) {
  if (!point || !usable(point.close) || point.date > date) return undefined;
  if (actions?.some(a => a.symbol === symbol && a.date <= date && (a.date > point.date || a.uncertain && a.date === point.date))) return undefined;
  if (point.date === date) {
    const sources = optionSymbol(symbol) ? ['polygon', 'yahoo'] : ['sina', 'yahoo', 'gaoteng-fund-nav', 'chinaamc-hk-fund-nav', 'eastmoney-fund-nav'];
    return sources.includes(point.source) ? point.close : undefined;
  }
  const weekend = new Date(date + 'T00:00:00Z').getUTCDay();
  const precedingFriday = Date.parse(date) - (weekend === 0 ? 2 : 1) * 86400000;
  if (isAShareSymbol(symbol) && (weekend === 0 || weekend === 6) &&
    Date.parse(point.date) === precedingFriday && ['sina', 'yahoo'].includes(point.source)) return point.close;
  return undefined;
}

export function createSnapshotReplay(db, userId, history) {
  const trades = exists(db,'portfolio_users') ? JSON.parse(db.prepare('SELECT data FROM portfolio_users WHERE user_id=?').get(userId)?.data || '{}').trades || [] : [];
  const byAccount = new Map();
  for (const trade of trades) {
    if (!byAccount.has(trade.account_id)) byAccount.set(trade.account_id,[]);
    byAccount.get(trade.account_id).push(trade);
  }
  const accounts = exists(db,'investment_accounts') ? db.prepare('SELECT * FROM investment_accounts WHERE user_id=?').all(userId) : [];
  const byLedgerId = new Map(accounts.map(account=>[account.bookkeeping_id,account]));
  const pastBaselines = new Map();
  if (exists(db,'investment_account_audit')) {
    const audits = db.prepare("SELECT account_id,data FROM investment_account_audit WHERE user_id=? AND action='cash-baseline' ORDER BY at DESC,id DESC").all(userId);
    for (const audit of audits) {
      const prior = JSON.parse(audit.data).before;
      if (!prior?.bookkeeping_id || !prior.baseline_trade_ids || !Number.isFinite(investmentRecordTime(prior.baseline_at))) continue;
      if (!pastBaselines.has(audit.account_id)) pastBaselines.set(audit.account_id, []);
      pastBaselines.get(audit.account_id).push(prior);
    }
  }
  const storedPrice = exists(db,'bookkeeping_security_prices') ? db.prepare(`SELECT close FROM bookkeeping_security_prices
    WHERE user_id=? AND symbol=? AND date=? AND source LIKE 'verified-backfill:%'`) : null;
  return (row, details=JSON.parse(row.details)) => {
    const cutoff=Date.parse(row.captured_at);
    return details.map(account=>{
      if(account.source!=='portfolio')return account;
      const binding=account.investmentId ? accounts.find(a=>a.id===account.investmentId) : byLedgerId.get(account.id);
      if(!binding)return account;
      const owned=byAccount.get(binding.id)||[];
      const late=owned.filter(t=>!t.historicalBackfill && Date.parse(t.created_at)>cutoff && (tradeStamp(t)<=cutoff || investmentRecordTime(t.cash_effective_at||t.trade_date)<=cutoff));
      if(!late.length)return account;
      const cashBasis=account.cashBaseline || [binding,...(pastBaselines.get(binding.id)||[])]
        .filter(b=>b.bookkeeping_id===account.id && investmentRecordTime(b.baseline_at)<=cutoff)
        .sort((a,b)=>investmentRecordTime(b.baseline_at)-investmentRecordTime(a.baseline_at))[0];
      const baseline=cashBasis?tradeCashBaseline(cashBasis):null;
      const quotes=new Map((account.quotes||[]).map(q=>[q.symbol,q]));
      const quantities=new Map();
      let delta=0, pending=!baseline, changed=false;
      for(const trade of late) {
        const stamp=tradeStamp(trade);
        const cashApplied=baseline && tradeAfterCashBaseline(trade,baseline) && investmentRecordTime(trade.cash_effective_at||trade.trade_date)<=cutoff;
        // The observed equity at the cash baseline already anchors earlier positions.
        // Adding their market value without the corresponding cash leg duplicates assets.
        const positionApplied=stamp<=cutoff && ['buy','sell'].includes(trade.type) && (!baseline || stamp>=baseline.at && !baseline.ids.has(trade.id));
        if(!cashApplied&&!positionApplied)continue;
        changed=true;
        if(inferCurrency(trade.symbol,trade.currency)!==account.currency){pending=true;continue;}
        if(cashApplied)delta+=investmentCashDelta(trade);
        if(!positionApplied)continue;
        // An original snapshot does not record how many shares a corporate action converted.
        if(history?.splits?.some(action=>action.symbol===trade.symbol&&action.date>tradeDay(trade)&&action.date<=row.date))pending=true;
        const direction=trade.type==='buy'?1:-1;
        quantities.set(trade.symbol,(quantities.get(trade.symbol)||0)+direction*Number(trade.shares));
      }
      if(!changed&&!pending)return account;
      for(const [symbol,shares] of quantities) {
        if(!Number.isFinite(shares)){pending=true;continue;}
        if(Math.abs(shares)<1e-8)continue;
        let quote=quotes.get(symbol);
        if(!usable(quote?.price)) {
          const exact=storedPrice?.get(userId,symbol,row.date);
          const cached=history?.quote?.(symbol,row.date);
          const close=exact?.close ?? cachedClose(cached,symbol,row.date,history?.splits);
          const recent=owned.filter(t=>t.symbol===symbol&&['buy','sell'].includes(t.type)&&usable(Number(t.price))&&Number(t.price)>0&&tradeStamp(t)<=cutoff&&tradeStamp(t)>=cutoff-300000).sort((a,b)=>tradeStamp(b)-tradeStamp(a))[0];
          if(usable(close))quote={symbol,price:close,asOf:exact?row.date:cached.date,backfilled:true};
          else if(recent)quote={symbol,price:Number(recent.price),asOf:new Date(tradeStamp(recent)).toISOString(),backfilled:true};
          else history?.request?.(symbol,row.date);
          if(quote)quotes.set(symbol,quote);
        }
        if(usable(quote?.price))delta+=shares*quote.price*(optionSymbol(symbol)?100:1);
        else pending=true;
      }
      return {...account,balance:pending?null:Math.round((account.balance+delta)*100)/100,
        quotes:[...quotes.values()],revised:!pending,revisionPending:pending};
    });
  };
}
