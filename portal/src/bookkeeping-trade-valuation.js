import { createSnapshotReplay, isOvernightSnapshot } from './bookkeeping-snapshot-replay.js';
import { optionSymbol, tradeDay, tradeStamp } from './bookkeeping-trade-returns.js';
import { fundIdentifier } from '../../shared/fund-holdings.js';

// Read-only securities valuation frames from the existing asset observations.
// A live quote is only used today and only after a saved baseline exists.
export function tradeValuation(db,userId,includedIds,today,currentQuotes={},currentRates={},history) {
  const exists=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bookkeeping_asset_snapshots'").get();
  const replay=createSnapshotReplay(db,userId,history);
  const frames=exists?db.prepare('SELECT date,captured_at,details FROM bookkeeping_asset_snapshots WHERE user_id=? AND date<=? ORDER BY date').all(userId,today).map(row=>{
    const accounts=replay(row).filter(a=>includedIds.has(a.id));
    const prices=new Map(),rates=new Map([['CNY',1]]);
    for(const a of accounts){if(a.rate>0)rates.set(a.currency,a.rate);for(const q of a.quotes||[])if(q.price!=null&&Number.isFinite(Number(q.price))&&Number(q.price)>=0)prices.set(q.symbol,q);}
    return {date:row.date,capturedAt:row.captured_at,prices,rates,overnight:isOvernightSnapshot(row),portfolio:accounts.some(a=>a.source==='portfolio')};
  }).filter(frame=>frame.portfolio):[];
  const first=frames[0]||null;
  const overnightStart=frames.find(frame=>frame.overnight)?.date;
  const byDay=new Map(frames.map(frame=>[frame.date,frame]));
  const hasPrices=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bookkeeping_security_prices'").get();
  const backfill=hasPrices?db.prepare("SELECT date,close FROM bookkeeping_security_prices WHERE user_id=? AND symbol=? AND date=? AND source LIKE 'verified-backfill:%'"):null;
  const at=date=>{let low=0,high=frames.length;while(low<high){const mid=(low+high)>>1;if(frames[mid].date<=date)low=mid+1;else high=mid;}return frames[low-1]||null;};
  const snapshotQuote=(frame,symbol)=>{
    const quote=frame?.prices.get(symbol);
    const navDate=fundIdentifier(symbol)&&/^\d{4}-\d{2}-\d{2}$/.test(quote?.asOf||'')?quote.asOf:null;
    return quote&&(!navDate||navDate<=frame.date)?{date:navDate||frame.date,close:Number(quote.price),source:quote.backfilled?'backfill':'valuation'}:null;
  };
  function historicalQuote(symbol,date,saved) {
    const verified=backfill?.get(userId,symbol,date);
    if(verified&&saved?.date!==date)return {...verified,source:'backfill'};
    const cached=optionSymbol(symbol)?null:history?.quote?.(symbol,date);
    const split=history?.splits?.filter(s=>s.symbol===symbol&&s.date<=date).at(-1);
    if(cached&&cached.date<=date&&(!split||cached.date>split.date)&&(!saved||cached.date>saved.date)){
      return {date:cached.date,close:cached.close,source:'backfill'};
    }
    return saved;
  }
  return {
    first,
    day(trade){
      const day=tradeDay(trade);
      if(!day||!overnightStart)return day;
      const previous=new Date(Date.parse(day+'T00:00:00Z')-86400000).toISOString().slice(0,10);
      if(previous<overnightStart)return day;
      const frame=byDay.get(previous);
      if(frame&&!frame.overnight)return day;
      const cutoff=Date.parse(frame?.capturedAt||day+'T04:30:00+08:00');
      return tradeStamp(trade)<=cutoff?previous:day;
    },
    baselineQuote:symbol=>first?historicalQuote(symbol,first.date,snapshotQuote(first,symbol)):null,
    baselineFx:currency=>first?.rates.has(currency)?{rate:first.rates.get(currency)}:null,
    quote(symbol,date){
      if(!first||date<first.date)return null;
      const q=currentQuotes[symbol],price=q?.price,asOf=q?Date.parse(q.asOf||q.updatedAt||q.date||''):NaN;
      if(date===today&&price!=null&&Number.isFinite(Number(price))&&Number(price)>=0&&(!Number.isFinite(asOf)||asOf<=Date.now()))return {date,close:Number(price),source:'current'};
      return historicalQuote(symbol,date,snapshotQuote(at(date),symbol));
    },
    fx(currency,date){
      if(!first||date<first.date)return null;
      if(date===today&&currentRates[currency]>0)return {rate:currentRates[currency]};
      const frame=at(date);return frame?.rates.has(currency)?{rate:frame.rates.get(currency)}:null;
    }
  };
}
