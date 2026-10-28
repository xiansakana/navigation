// Read-only securities valuation frames from the existing asset observations.
// A live quote is only used today and only after a saved baseline exists.
export function tradeValuation(db,userId,includedIds,today,currentQuotes={},currentRates={}) {
  const exists=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bookkeeping_asset_snapshots'").get();
  const frames=exists?db.prepare('SELECT date,captured_at,details FROM bookkeeping_asset_snapshots WHERE user_id=? AND date<=? ORDER BY date').all(userId,today).map(row=>{
    const accounts=JSON.parse(row.details).filter(a=>includedIds.has(a.id));
    const prices=new Map(),rates=new Map([['CNY',1]]);
    for(const a of accounts){if(a.rate>0)rates.set(a.currency,a.rate);for(const q of a.quotes||[])if(q.price!=null&&Number.isFinite(Number(q.price))&&Number(q.price)>=0)prices.set(q.symbol,Number(q.price));}
    return {date:row.date,capturedAt:row.captured_at,prices,rates,portfolio:accounts.some(a=>a.source==='portfolio')};
  }).filter(frame=>frame.portfolio):[];
  const first=frames[0]||null;
  const at=date=>{let low=0,high=frames.length;while(low<high){const mid=(low+high)>>1;if(frames[mid].date<=date)low=mid+1;else high=mid;}return frames[low-1]||null;};
  const snapshotQuote=(frame,symbol)=>frame?.prices.has(symbol)?{date:frame.date,close:frame.prices.get(symbol),source:'valuation'}:null;
  return {
    first,
    baselineQuote:symbol=>snapshotQuote(first,symbol),
    baselineFx:currency=>first?.rates.has(currency)?{rate:first.rates.get(currency)}:null,
    quote(symbol,date){
      if(!first||date<first.date)return null;
      const q=currentQuotes[symbol],price=q?.price,asOf=q?Date.parse(q.asOf||q.updatedAt||q.date||''):NaN;
      if(date===today&&price!=null&&Number.isFinite(Number(price))&&Number(price)>=0&&(!Number.isFinite(asOf)||asOf<=Date.now()))return {date,close:Number(price),source:'current'};
      return snapshotQuote(at(date),symbol);
    },
    fx(currency,date){
      if(!first||date<first.date)return null;
      if(date===today&&currentRates[currency]>0)return {rate:currentRates[currency]};
      const frame=at(date);return frame?.rates.has(currency)?{rate:frame.rates.get(currency)}:null;
    }
  };
}
