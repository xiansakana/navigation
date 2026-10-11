import { fetchQuoteResource } from '../../shared/quote-network.js';
const series={USD:['DEXCHUS',false],HKD:['DEXHKUS',false],JPY:['DEXJPUS',false],MYR:['DEXMAUS',false],EUR:['DEXUSEU',true],GBP:['DEXUSUK',true],SGD:['DEXSIUS',false]};
const valid=n=>Number.isFinite(n)&&n>0&&n<1e6;
export function parseHistoricalFx(csv) {
  const lines=String(csv).trim().split(/\r?\n/),header=lines.shift().split(','),rows=[];
  for(const line of lines) {
    const cells=line.split(','),date=cells[0],cny=Number(cells[header.indexOf('DEXCHUS')]);if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!valid(cny))continue;
    for(const [currency,[id,inverse]] of Object.entries(series)) {
      const n=Number(cells[header.indexOf(id)]);if(!valid(n))continue;const rate=currency==='USD'?cny:inverse?cny*n:cny/n;
      if(valid(rate))rows.push({currency,date,rate,source:'fred-h10'});
    }
  }
  return rows;
}
export function createHistoricalFx(db,{request=fetchQuoteResource,clock=Date.now}={}) {
  db.exec(`CREATE TABLE IF NOT EXISTS bookkeeping_fx_history(currency TEXT NOT NULL,date TEXT NOT NULL,rate REAL NOT NULL,source TEXT NOT NULL,PRIMARY KEY(currency,date));CREATE TABLE IF NOT EXISTS bookkeeping_fx_history_meta(key TEXT PRIMARY KEY,updated_at INTEGER NOT NULL);`);
  let pending=null,lastAttempt=0;
  const lookup=db.prepare('SELECT * FROM bookkeeping_fx_history WHERE currency=? AND date<=? AND date>=? ORDER BY date DESC LIMIT 1');
  function quote(currency,date) {
    if(currency==='CNY')return {rate:1,date,source:'fixed'};
    const before=new Date(date+'T12:00:00Z');if(!Number.isFinite(before.getTime()))return null;before.setUTCDate(before.getUTCDate()-14);
    return lookup.get(currency,date,before.toISOString().slice(0,10))||null;
  }
  async function ensure(entries) {
    const needed=entries.filter(e=>e.currency!=='CNY');if(!needed.length)return;
    const meta=db.prepare("SELECT updated_at FROM bookkeeping_fx_history_meta WHERE key='h10'").get();
    if(needed.every(e=>quote(e.currency,e.date.slice(0,10))) && meta && clock()-meta.updated_at<21600000)return;
    if(pending)return pending;if(clock()-lastAttempt<60000)return;lastAttempt=clock();
    pending=(async()=>{
      try {
        const csv=await request('https://fred.stlouisfed.org/graph/fredgraph.csv?id='+[...new Set(Object.values(series).map(v=>v[0]))].join(','),{json:false,timeoutMs:20000,retries:0});
        const rows=parseHistoricalFx(csv);if(!rows.length)throw new Error('没有历史汇率数据');
        db.transaction(()=>{const save=db.prepare('INSERT INTO bookkeeping_fx_history VALUES(?,?,?,?) ON CONFLICT(currency,date) DO UPDATE SET rate=excluded.rate,source=excluded.source');for(const r of rows)save.run(r.currency,r.date,r.rate,r.source);db.prepare("INSERT INTO bookkeeping_fx_history_meta VALUES('h10',?) ON CONFLICT(key) DO UPDATE SET updated_at=excluded.updated_at").run(clock());})();
      }catch { /* Missing history remains explicit; current quotes are never used as historical rates. */ }
    })();try{await pending;}finally{pending=null;}
  }
  function enrich(e) {
    const q=quote(e.currency,e.date.slice(0,10));
    return {...e,cnyAmount:q?Math.round(e.amount*q.rate*100)/100:null,cnyFee:q?Math.round((e.fee||0)*q.rate*100)/100:null,historicalRate:q?.rate||null,rateDate:q?.date||null,rateSource:q?.source||null,fxMissing:!q};
  }
  return {ensure,quote,enrich};
}
let instance,instanceDb;
export function historicalFx(db) {if(instanceDb!==db){instance=createHistoricalFx(db);instanceDb=db;}return instance;}
