import fs from 'node:fs';
import { fetchQuoteResource } from '../../shared/quote-network.js';
import { isAShareSymbol, ashareExchange } from '../../stock-manage/src/markets.js';
import { optionSymbol } from './bookkeeping-trade-returns.js';
import { verifiedCorporateActions } from './bookkeeping-corporate-actions.js';

const shift=(date,n)=>new Date(Date.parse(date+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
const day=stamp=>new Date(stamp*1000).toISOString().slice(0,10);
export function parseSecurityHistory(symbol,data) {
  const result=data?.chart?.result?.[0];
  if(!result || result.error)throw new Error('没有历史行情');
  const splits=Object.values(result.events?.splits||{}).map(s=>({symbol,date:day(s.date),ratio:Number(s.numerator)/Number(s.denominator)})).filter(s=>s.ratio>0);
  const prices=(result.timestamp||[]).map((stamp,i)=>{
    const marketDate=day(stamp),raw=result.indicators?.quote?.[0]?.close?.[i];
    // Yahoo OHLC are split-adjusted. Restore contemporaneous prices; the FIFO
    // reconstruction applies each split to the lots on its actual effective day.
    const factor=splits.filter(s=>s.date>marketDate).reduce((n,s)=>n*s.ratio,1);
    return {date:isAShareSymbol(symbol)?marketDate:shift(marketDate,1),close:raw==null?NaN:Number(raw)*factor,source:'yahoo'};
  }).filter(p=>Number.isFinite(p.close)&&p.close>=0);
  if(!prices.length)throw new Error('没有历史行情');
  return {prices,splits};
}

export function parseSinaHistory(symbol,rows,start,end) {
  const number=value=>value==null||value===''?NaN:Number(value);
  const data=(Array.isArray(rows)?rows:rows?.result?.data||[]).map(p=>({marketDate:String(p.d||p.day||'').slice(0,10),open:number(p.o??p.open),close:number(p.c??p.close)}))
    .filter(p=>/^\d{4}-\d{2}-\d{2}$/.test(p.marketDate)&&Number.isFinite(p.close)&&p.close>=0).sort((a,b)=>a.marketDate.localeCompare(b.marketDate));
  const splits=[];
  // A discontinuity is not proof of a split. Flag affected existing lots instead
  // of inventing a corporate-action ratio from price changes.
  for(let i=1;i<data.length;i++){const ratio=data[i].open/data[i-1].close;if((ratio>=1.4||ratio<=0.65)&&ratio>0&&data[i].marketDate>=start&&data[i].marketDate<=end)splits.push({symbol,date:data[i].marketDate,uncertain:true});}
  const prices=data.filter(p=>p.marketDate>=start&&p.marketDate<=end).map(p=>({date:isAShareSymbol(symbol)?p.marketDate:shift(p.marketDate,1),close:p.close,source:'sina'}));
  if(!prices.length)throw new Error('没有历史行情');
  return {prices,splits};
}

function polygonKey() {
  if(process.env.POLYGON_API_KEY)return process.env.POLYGON_API_KEY;
  try{return JSON.parse(fs.readFileSync(new URL('../../stock-manage/config.json',import.meta.url),'utf8')).polygonApiKey||'';}catch{return '';}
}
export function createSecurityHistory(db,{request=fetchQuoteResource,key=polygonKey(),clock=Date.now}={}) {
  db.exec(`CREATE TABLE IF NOT EXISTS bookkeeping_security_prices(user_id TEXT NOT NULL,symbol TEXT NOT NULL,date TEXT NOT NULL,close REAL NOT NULL,source TEXT NOT NULL,PRIMARY KEY(user_id,symbol,date));
    CREATE TABLE IF NOT EXISTS bookkeeping_security_history_meta(user_id TEXT NOT NULL,symbol TEXT NOT NULL,start TEXT NOT NULL,end TEXT NOT NULL,attempted_at INTEGER NOT NULL,status TEXT NOT NULL,splits TEXT NOT NULL,PRIMARY KEY(user_id,symbol));`);
  const queue=[],pending=new Set();let active=0,yahooBlockedUntil=0,polygonBlockedUntil=0;
  async function load(symbol,start,end) {
    const option=optionSymbol(symbol);
    if(option && key && clock()>=polygonBlockedUntil) {
      const ticker='O:'+option[1]+option[2]+option[3]+String(Math.round(Number(option[4])*1000)).padStart(8,'0');
      try {
        const data=await request('https://api.polygon.io/v2/aggs/ticker/'+encodeURIComponent(ticker)+'/range/1/day/'+start+'/'+end+'?adjusted=false&sort=asc&limit=50000&apiKey='+encodeURIComponent(key),{timeoutMs:6000,retries:0,logger:null});
        const prices=(data.results||[]).map(p=>({date:shift(new Date(p.t).toISOString().slice(0,10),1),close:Number(p.c),source:'polygon'})).filter(p=>Number.isFinite(p.close)&&p.close>=0);
        if(prices.length)return {prices,splits:[]};
      }catch(error){if(/HTTP 429/.test(error.message))polygonBlockedUntil=clock()+3600000;}
    }
    if(option && '20'+option[2].slice(0,2)+'-'+option[2].slice(2,4)+'-'+option[2].slice(4,6)<new Date(clock()).toISOString().slice(0,10))throw new Error('缺少过期期权行情');
    const yahoo=option?option[1]+option[2]+option[3]+String(Math.round(Number(option[4])*1000)).padStart(8,'0'):isAShareSymbol(symbol)?symbol+(ashareExchange(symbol)==='sh'?'.SS':'.SZ'):symbol.replace('/','-');
    try{
      if(clock()<yahooBlockedUntil)throw new Error('Yahoo 暂停请求');
      const data=await request('https://query1.finance.yahoo.com/v8/finance/chart/'+encodeURIComponent(yahoo)+'?period1='+Math.floor(Date.parse(start+'T00:00:00Z')/1000)+'&period2='+Math.floor(Date.parse(shift(end,1)+'T00:00:00Z')/1000)+'&interval=1d&events=splits',{headers:{'User-Agent':'Mozilla/5.0'},timeoutMs:6000,retries:0,logger:null});
      return parseSecurityHistory(symbol,data);
    }catch(error){
      if(/HTTP 429/.test(error.message))yahooBlockedUntil=clock()+3600000;
      if(option)throw error;
      const url=isAShareSymbol(symbol)?'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol='+ashareExchange(symbol)+symbol+'&scale=240&ma=no&datalen=1970'
        :'https://stock.finance.sina.com.cn/usstock/api/json.php/US_MinKService.getDailyK?symbol='+encodeURIComponent(symbol.replace('/','.'))+'&___qn=3';
      return parseSinaHistory(symbol,await request(url,{headers:{'User-Agent':'Mozilla/5.0',Referer:'https://finance.sina.com.cn/'},timeoutMs:6000,retries:0,logger:null}),start,end);
    }
  }
  function drain(){
    while(active<2 && queue.length){const job=queue.shift();active++;
      void load(job.symbol,job.start,job.end).then(result=>{
        if(!db.open)return;
        db.transaction(()=>{const insert=db.prepare('INSERT INTO bookkeeping_security_prices VALUES(?,?,?,?,?) ON CONFLICT(user_id,symbol,date) DO UPDATE SET close=excluded.close,source=excluded.source');for(const p of result.prices)insert.run(job.userId,job.symbol,p.date,p.close,p.source);
          db.prepare('INSERT INTO bookkeeping_security_history_meta VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id,symbol) DO UPDATE SET start=excluded.start,end=excluded.end,attempted_at=excluded.attempted_at,status=excluded.status,splits=excluded.splits').run(job.userId,job.symbol,job.start,job.end,clock(),'ready',JSON.stringify(result.splits));})();
      }).catch(()=>{if(db.open)db.prepare('INSERT INTO bookkeeping_security_history_meta VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id,symbol) DO UPDATE SET attempted_at=excluded.attempted_at,status=excluded.status').run(job.userId,job.symbol,job.start,job.end,clock(),'unavailable','[]');})
        .finally(()=>{active--;pending.delete(job.id);if(db.open)drain();});
    }
  }
  function ensure(userId,requests){
    for(const r of requests){const id=JSON.stringify([userId,r.symbol]);if(pending.has(id))continue;
      const meta=db.prepare('SELECT * FROM bookkeeping_security_history_meta WHERE user_id=? AND symbol=?').get(userId,r.symbol);
      const covered=meta?.status==='ready'&&meta.start<=r.start&&meta.end>=r.end;
      if(covered || (meta && meta.status!=='ready' && clock()-meta.attempted_at<6*3600000))continue;
      pending.add(id);queue.push({...r,userId,id});
    }
    drain();
  }
  function read(userId){
    const bySymbol=new Map();
    for(const p of db.prepare('SELECT symbol,date,close,source FROM bookkeeping_security_prices WHERE user_id=? ORDER BY symbol,date').all(userId)){if(!bySymbol.has(p.symbol))bySymbol.set(p.symbol,[]);bySymbol.get(p.symbol).push(p);}
    const meta=db.prepare('SELECT * FROM bookkeeping_security_history_meta WHERE user_id=?').all(userId);
    const actions=new Map();for(const s of [...meta.flatMap(m=>JSON.parse(m.splits)),...verifiedCorporateActions])actions.set(s.symbol+'|'+s.date,s);
    return {quote(symbol,date){const values=bySymbol.get(symbol)||[];let low=0,high=values.length;while(low<high){const mid=(low+high)>>1;if(values[mid].date<=date)low=mid+1;else high=mid;}return values[low-1]||null;},splits:[...actions.values()],pending:[...pending].filter(k=>JSON.parse(k)[0]===userId).length,unavailable:meta.filter(m=>m.status==='unavailable').map(m=>m.symbol)};
  }
  return {ensure,read};
}
const instances=new WeakMap();
export function securityHistory(db){if(!instances.has(db))instances.set(db,createSecurityHistory(db));return instances.get(db);}
