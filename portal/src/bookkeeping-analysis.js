import { summarize, TRANSFER_TYPES } from './bookkeeping-store.js';
const rounded = n => Math.round((n + Number.EPSILON) * 100) / 100;
const previousMonth = month => new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7))-2,1)).toISOString().slice(0,7);
function totals(entries) { return summarize(entries).totals; }
function series(entries, month, today, filter={}) {
  const buckets = new Map(), start=filter.start|| (month?month+'-01':''),end=filter.end||'',daily=!!month || (start && end && (Date.parse(end)-Date.parse(start))/86400000<=62), granularity = daily ? 'day' : 'month';
  for (const day of summarize(entries).days) {
    const date = daily ? day.date : day.date.slice(0,7), key = day.currency+'|'+date;
    const item=buckets.get(key)||{date,currency:day.currency,income:0,expense:0};
    item.income=rounded(item.income+day.income);item.expense=rounded(item.expense+day.expense);buckets.set(key,item);
  }
  const currencies=[...new Set(entries.map(e=>e.currency))], result=[];
  for (const currency of currencies) {
    const items=[...buckets.values()].filter(x=>x.currency===currency).sort((a,b)=>a.date.localeCompare(b.date));
    if(!items.length)continue;
    let cursor=daily?(start||items[0].date):(start?start.slice(0,7)+'-01':items[0].date+'-01');
    const monthEnd=month?new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),0)).toISOString().slice(0,10):'';
    const defaultLast=month?(month===today.slice(0,7)?[today,...items.map(p=>p.date)].sort().at(-1):monthEnd):items.at(-1).date+'-01';
    const actualEnd=[today,...entries.map(e=>e.date.slice(0,10))].sort().at(-1);
    const boundedEnd=end && end<actualEnd?end:actualEnd;
    const last=end?(daily?boundedEnd:boundedEnd.slice(0,7)+'-01'):defaultLast;
    let cumulative=0;
    for(let i=0;cursor<=last && i<3700;i++) {
      const date=daily?cursor:cursor.slice(0,7), item=buckets.get(currency+'|'+date)||{date,currency,income:0,expense:0};
      cumulative=rounded(cumulative+item.income-item.expense);result.push({...item,net:rounded(item.income-item.expense),cumulative});
      const d=new Date(cursor+'T12:00:00Z');if(daily)d.setUTCDate(d.getUTCDate()+1);else d.setUTCMonth(d.getUTCMonth()+1);cursor=d.toISOString().slice(0,10);
    }
  }
  return {granularity,points:result};
}
function conversion(entries, rates) {
  const missing=[...new Set(entries.filter(e=>e.fxMissing || (!Number.isFinite(e.cnyAmount) && (!Number.isFinite(Number(rates[e.currency]))||rates[e.currency]<=0))).map(e=>e.currency))];
  return {missing,entries:missing.length?[]:entries.map(e=>({...e,currency:'CNY',amount:Number.isFinite(e.cnyAmount)?e.cnyAmount:rounded(e.amount*rates[e.currency]),fee:Number.isFinite(e.cnyFee)?e.cnyFee:rounded((e.fee||0)*rates[e.currency])}))};
}
export function assetTrends(accounts, entries, today, rates={CNY:1}, filter={}) {
  const included=accounts.filter(a=>a.included), byId=new Map(accounts.map(a=>[a.id,a])), ids=new Set(included.map(a=>a.id));
  const relevant=entries.filter(e=>ids.has(e.accountId)||ids.has(e.toAccountId)||(!e.accountId&&!e.toAccountId));
  const missing=[...new Set([...included.map(a=>a.currency).filter(c=>!Number.isFinite(Number(rates[c]))||rates[c]<=0),...relevant.filter(e=>e.fxMissing).map(e=>e.currency),...relevant.map(e=>e.toFxMissing).filter(Boolean)])];
  const note='以当前计入总资产的账户余额为终点，倒序撤销历史及新增账单的资产影响，反推历史日末余额。账单变化按账单日期的历史参考汇率折算 CNY，当前资产作为锚点按当前汇率折算；包含已记录的余额调整；不含未记录的资产涨跌及外币存量的汇率重估；历史账户范围按当前计入设置处理。跨币种转账缺少到账金额时，按等值本金估算，内部转账只影响手续费；未关联账户的收支按总资产变化估算。';
  if(missing.length)return {points:[],missingCurrencies:missing,note,estimatedTransfers:0,unlinkedEntries:0};
  if(!included.length)return {points:[],missingCurrencies:[],note,estimatedTransfers:0,unlinkedEntries:0};
  const current=rounded(included.reduce((n,a)=>n+a.balance*rates[a.currency],0)), changes=new Map();
  let estimatedTransfers=0,unlinkedEntries=0;
  for(const e of relevant) {
    const rate=e.historicalRate||rates[e.currency],principal=Number.isFinite(e.cnyAmount)?e.cnyAmount:e.amount*rate,fee=Number.isFinite(e.cnyFee)?e.cnyFee:(e.fee||0)*rate;let delta=0;
    const from=ids.has(e.accountId),to=ids.has(e.toAccountId),unlinked=!e.accountId&&!e.toAccountId;
    if(TRANSFER_TYPES.includes(e.type)) {
      if(from)delta-=principal+fee;
      if(to) {
        const destination=byId.get(e.toAccountId);
        delta+=e.toAmount!=null?e.toAmount*(e.toHistoricalRate||rates[destination.currency]):principal;
        if(e.toAmount==null && destination.currency!==e.currency)estimatedTransfers++;
      }
      if(unlinked && fee){delta-=fee;unlinkedEntries++;}
    } else if(from || unlinked) {
      delta=['支出','已报销'].includes(e.type)?-principal-fee:principal-fee;
      if(unlinked)unlinkedEntries++;
    }
    const date=e.date.slice(0,10);changes.set(date,rounded((changes.get(date)||0)+delta));
  }
  const dates=[...changes.keys()].sort(),end=[today,...dates].sort().at(-1),points=[];
  let balance=rounded(current-[...changes.values()].reduce((n,v)=>n+v,0));
  if(dates.length) {const d=new Date(dates[0]+'T12:00:00Z');d.setUTCDate(d.getUTCDate()-1);points.push({date:d.toISOString().slice(0,10),currency:'CNY',balance});}
  for(const date of [...new Set([...dates,end])].sort()){balance=rounded(balance+(changes.get(date)||0));points.push({date,currency:'CNY',balance});}
  // Anchor to the actual equivalent balance, avoiding accumulated rounding drift.
  points.at(-1).balance=current;
  const lower=filter.start && filter.start>points[0].date?filter.start:points[0].date,upper=filter.end && filter.end<end?filter.end:end;
  const at=date=>points.filter(p=>p.date<=date).at(-1)?.balance??points[0].balance;
  const scoped=lower<=upper?[...new Set([lower,...points.map(p=>p.date).filter(d=>d>=lower && d<=upper),upper])].sort().map(date=>({date,currency:'CNY',balance:at(date)})):[];
  return {points:scoped,missingCurrencies:[],note,estimatedTransfers,unlinkedEntries,current,asOf:end};
}
export function analyzeBookkeeping(entries, allEntries, accounts, settings, filter={}, today=new Date(Date.now()+8*60*60*1000).toISOString().slice(0,10), fxRates=settings.rates||{CNY:1}) {
  entries=entries.filter(e=>e.type!=='余额调整');
  const rates={...fxRates,CNY:1}, converted=conversion(entries,rates);
  const summary=summarize(converted.entries), month=filter.month||'', previous=month?previousMonth(month):null;
  const compare=previous?allEntries.filter(e=>e.date.startsWith(previous) && (!filter.currency||e.currency===filter.currency) && (!filter.book||e.book===filter.book) && (!filter.category||e.category===filter.category) && (!filter.subcategory||e.subcategory===filter.subcategory) && (!filter.accountId||e.accountId===filter.accountId||e.toAccountId===filter.accountId) && (!filter.type||e.type===filter.type) && (!filter.q||[e.note,e.category,e.subcategory,e.tags,e.location,e.accountName,e.toAccountName].some(v=>String(v||'').toLowerCase().includes(filter.q.toLowerCase())))):[];
  // A focused day/flow is not a comparable full-month period.
  const comparable=!!month && !filter.day && !filter.flow && !filter.through && (!filter.month || month!==today.slice(0,7));
  const comparison=totals(conversion(compare.filter(e=>e.type!=='余额调整'),rates).entries), insights=[];
  for(const [currency,t] of Object.entries(summary.totals)) {
    const top=summary.categories.filter(c=>c.currency===currency && c.amount>0), positive=top.reduce((n,c)=>n+c.amount,0), lead=top[0];
    const prev=comparison[currency], change=comparable && prev && prev.expense>0?(t.expense-prev.expense)/prev.expense:null;
    const fullMonth=month && !['book','category','subcategory','accountId','type','q','day','flow','through'].some(k=>filter[k]);
    const budget=currency==='CNY' && fullMonth?Number(settings.budgets?.[month]||0):0;
    const suggestions=[];
    if(lead && positive>0 && lead.amount/positive>=0.35)suggestions.push({kind:'concentration',category:lead.category,share:lead.amount/positive,target:comparable && fullMonth?rounded(lead.amount*0.9):null});
    if(t.expense>t.income)suggestions.push({kind:'deficit',amount:rounded(t.expense-t.income)});
    if(budget>0)suggestions.push({kind:t.expense>budget?'over-budget':'budget',remaining:rounded(budget-t.expense),budget});
    if(change!==null && change>0.2)suggestions.push({kind:'increase',change,previous});
    if(!suggestions.length && lead)suggestions.push({kind:'review',category:lead.category});
    insights.push({currency,count:entries.length,...t,topCategory:lead||null,share:lead && positive?lead.amount/positive:0,comparison:change===null?null:{month:previous,expense:prev.expense,change},budget,suggestions});
  }
  const asset=accounts?assetTrends(accounts,allEntries,today,rates,filter):null;
  return {billing:{...series(converted.entries,month,today,filter),missingCurrencies:converted.missing},equivalentSummary:summary,insights,asset,rates,conversionNote:'账单按日期的历史参考汇率折算 CNY；非报价日或尚未发布的日期使用此前最近已发布报价日，最多回溯 14 天；筛选货币仍指原始账单币种。',comparisonNote:!month?'周、年和自定义范围不直接计算整月环比，可选择完整月份进行比较。':month===today.slice(0,7)?'本月尚未结束，不与完整上月直接比较。':filter.day||filter.flow||filter.through?'当前为穿透筛选，不计算整月环比。':'环比基于相同筛选范围的上一完整月份；缺少上月支出时不计算。'};
}
