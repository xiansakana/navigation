import { summarize, TRANSFER_TYPES } from './bookkeeping-store.js';
const rounded = n => Math.round((n + Number.EPSILON) * 100) / 100;
const previousMonth = month => new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7))-2,1)).toISOString().slice(0,7);
function totals(entries) { return summarize(entries).totals; }
function series(entries, month, today) {
  const buckets = new Map(), granularity = month ? 'day' : 'month';
  for (const day of summarize(entries).days) {
    const date = month ? day.date : day.date.slice(0,7), key = day.currency+'|'+date;
    const item=buckets.get(key)||{date,currency:day.currency,income:0,expense:0};
    item.income=rounded(item.income+day.income);item.expense=rounded(item.expense+day.expense);buckets.set(key,item);
  }
  const currencies=[...new Set(entries.map(e=>e.currency))], result=[];
  for (const currency of currencies) {
    const items=[...buckets.values()].filter(x=>x.currency===currency).sort((a,b)=>a.date.localeCompare(b.date));
    if(!items.length)continue;
    let cursor=month?month+'-01':items[0].date+'-01';
    const monthEnd=month?new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),0)).toISOString().slice(0,10):'';
    const last=month?(month===today.slice(0,7)?[today,...items.map(p=>p.date)].sort().at(-1):monthEnd):items.at(-1).date+'-01';
    let cumulative=0;
    for(let i=0;cursor<=last && i<3700;i++) {
      const date=month?cursor:cursor.slice(0,7), item=buckets.get(currency+'|'+date)||{date,currency,income:0,expense:0};
      cumulative=rounded(cumulative+item.income-item.expense);result.push({...item,net:rounded(item.income-item.expense),cumulative});
      const d=new Date(cursor+'T12:00:00Z');if(month)d.setUTCDate(d.getUTCDate()+1);else d.setUTCMonth(d.getUTCMonth()+1);cursor=d.toISOString().slice(0,10);
    }
  }
  return {granularity,points:result};
}
export function assetTrends(accounts, entries, today) {
  const included=accounts.filter(a=>a.included), groups=new Map();
  for(const a of included)(groups.get(a.currency)||groups.set(a.currency,[]).get(a.currency)).push(a);
  const live=entries.filter(e=>!e.historical), points=[], baselines=[];
  for(const [currency,list] of groups) {
    const ids=new Set(list.map(a=>a.id));
    const dates=list.map(a=>{
      const declared=String(a.snapshotAt||'').slice(0,10);
      if(/^\d{4}-\d{2}-\d{2}$/.test(declared)&&Number.isFinite(Date.parse(declared)))return declared;
      const first=live.filter(e=>e.accountId===a.id||e.toAccountId===a.id).map(e=>e.date.slice(0,10)).sort()[0];
      return first||today;
    });
    const baseline=dates.sort().at(-1), changes=new Map();
    for(const e of live) {
      let delta=0;
      if(TRANSFER_TYPES.includes(e.type)) {if(ids.has(e.accountId))delta-=e.amount+e.fee;if(ids.has(e.toAccountId))delta+=e.toAmount??e.amount;}
      else if(ids.has(e.accountId))delta+=['支出','已报销'].includes(e.type)?-e.amount-e.fee:e.amount-e.fee;
      if(delta)changes.set(e.date.slice(0,10),rounded((changes.get(e.date.slice(0,10))||0)+delta));
    }
    let balance=rounded(list.reduce((n,a)=>n+a.opening,0));
    for(const [date,delta] of changes)if(date<baseline)balance=rounded(balance+delta);
    const end=[today,baseline,...changes.keys()].sort().at(-1);
    const datesToShow=[...new Set([baseline,end,...[...changes.keys()].filter(d=>d>=baseline)])].sort();
    for(const date of datesToShow) {balance=rounded(balance+(changes.get(date)||0));points.push({date,currency,balance});}
    baselines.push({currency,date:baseline,accounts:list.length,declared:list.every(a=>!!a.snapshotAt)});
  }
  return {points,baselines,note:'资产曲线依据账户余额基准和联动余额的新账单重建，按当前“计入总资产”设置统计；历史导入账单不参与资产还原，不含未记录的市场涨跌。各币种从全部相关账户具备基准的日期起展示。'};
}
export function analyzeBookkeeping(entries, allEntries, accounts, settings, filter={}, today=new Date(Date.now()+8*60*60*1000).toISOString().slice(0,10)) {
  const summary=summarize(entries), month=filter.month||'', previous=month?previousMonth(month):null;
  const compare=previous?allEntries.filter(e=>e.date.startsWith(previous) && (!filter.currency||e.currency===filter.currency) && (!filter.book||e.book===filter.book) && (!filter.category||e.category===filter.category) && (!filter.subcategory||e.subcategory===filter.subcategory) && (!filter.accountId||e.accountId===filter.accountId||e.toAccountId===filter.accountId) && (!filter.type||e.type===filter.type) && (!filter.q||[e.note,e.category,e.subcategory,e.tags,e.location,e.accountName,e.toAccountName].some(v=>String(v||'').toLowerCase().includes(filter.q.toLowerCase())))):[];
  // A focused day/flow is not a comparable full-month period.
  const comparable=!!month && !filter.day && !filter.flow && !filter.through && (!filter.month || month!==today.slice(0,7));
  const comparison=totals(compare), insights=[];
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
    insights.push({currency,count:entries.filter(e=>e.currency===currency).length,...t,topCategory:lead||null,share:lead && positive?lead.amount/positive:0,comparison:change===null?null:{month:previous,expense:prev.expense,change},budget,suggestions});
  }
  const asset=accounts?assetTrends(accounts,allEntries,today):null;
  return {billing:series(entries,month,today),insights,asset,comparisonNote:month===today.slice(0,7)?'本月尚未结束，不与完整上月直接比较。':filter.day||filter.flow||filter.through?'当前为穿透筛选，不计算整月环比。':'环比基于相同筛选范围的上一完整月份；缺少上月支出时不计算。'};
}
