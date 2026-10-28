import { normalizeSymbol, inferCurrency } from '../../stock-manage/src/markets.js';
import { normalizeOtherAmount } from '../../shared/dividend-tax.js';

const round=n=>Math.round((n+Number.EPSILON)*100)/100;
const shift=(date,n)=>new Date(Date.parse(date+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
const tradeStamp=t=>{
  const value=String(t.trade_date||'');
  return Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(value)?value:(/^\d{4}-\d{2}-\d{2}$/.test(value)?value+'T00:00:00':value.replace(' ','T'))+'+08:00');
};
export const tradeDay=t=>{
  const stamp=tradeStamp(t);
  return Number.isFinite(stamp)?new Date(stamp+8*3600000).toISOString().slice(0,10):null;
};
export const optionSymbol=s=>/^([A-Z]+)(\d{6})([CP])(\d+(?:\.\d+)?)$/.exec(s);

export function reconstructTradeReturns(trades,{start,end,today,quote,fx,splits=[]}) {
  const booked=new Set();
  for(const action of splits.filter(s=>!s.uncertain)){
    const same=trades.filter(t=>normalizeSymbol(t.symbol)===action.symbol&&tradeDay(t)===action.date);
    for(const sell of same.filter(t=>t.type==='sell'))if(same.some(buy=>buy.type==='buy'&&(buy.account_id||'')===(sell.account_id||'')&&inferCurrency(buy.symbol,buy.currency)===inferCurrency(sell.symbol,sell.currency)&&tradeStamp(buy)===tradeStamp(sell)&&Number(sell.commission||0)===0&&Number(buy.commission||0)===0&&Number(buy.shares)>0&&Number(sell.total_amount)>0&&Math.abs(Number(buy.shares)-Number(sell.shares)*action.ratio)<1&&Math.abs(Number(buy.total_amount)/Number(sell.total_amount)-Number(buy.shares)/(Number(sell.shares)*action.ratio))<0.005))booked.add(JSON.stringify([action.symbol,sell.account_id||'',tradeStamp(sell)]));
  }
  const sorted=trades.map(t=>({...t,day:tradeDay(t),symbol:normalizeSymbol(t.symbol)})).filter(t=>t.day&&t.day<=end)
    .sort((a,b)=>tradeStamp(a)-tradeStamp(b)||(a.symbol===b.symbol&&(a.account_id||'')===(b.account_id||'')&&booked.has(JSON.stringify([a.symbol,a.account_id||'',tradeStamp(a)]))?(a.type==='sell'?0:1)-(b.type==='sell'?0:1):0)||String(a.id).localeCompare(String(b.id)));
  const note='证券收益按所选范围首日前一日日末归零：范围已实现净收益＝当日已实现净收益－期初已实现净收益；范围浮盈变化＝当日持仓浮盈－期初持仓浮盈；范围证券总收益＝两者相加。范围前的交易继续参与同账户、证券及币种的 FIFO 成本匹配，但不把范围前的收益计入范围总收益。计入佣金、股息、税费及其他证券收支，买卖按交易日汇率折算 CNY；历史持仓按当日可知的最近收盘价及当日汇率估值。美股收盘归北京时间次日，非交易日最多沿用此前七天收盘；不使用未来价格。期初或当日缺行情、成本或汇率处留空，不以零或当前股价代替。不包含历史现金存量汇兑及未记录持仓，与下方全资产快照收益口径不同。';
  if(!sorted.length)return {points:[],note,issues:[],summary:null};
  const beginning=shift(sorted[0].day,-1),opening=start?shift(start,-1):beginning;
  if((start&&start>end)||end<opening)return {points:[],note,issues:[],summary:null};
  const loopStart=opening<beginning?opening:beginning;
  if((Date.parse(end)-Date.parse(loopStart))/86400000>3700)return {points:[],note:note+' 历史跨度超过十年，请先核对交易起始日期。',issues:[],summary:null};
  const queues=new Map(),points=[],issues=new Set(),missingSymbols=new Set();
  let realized=0,invalidCost=false,index=0;
  const actions=[...splits].sort((a,b)=>a.date.localeCompare(b.date));let action=0;
  for(let date=loopStart;date<=end;date=shift(date,1)) {
    while(action<actions.length&&actions[action].date<=date){const s=actions[action++];for(const [key,lot] of queues)if(lot.symbol===s.symbol){const account=JSON.parse(key)[0];if(sorted.some(t=>t.day===s.date&&t.symbol===s.symbol&&(t.account_id||'')===account&&booked.has(JSON.stringify([s.symbol,account,tradeStamp(t)]))))continue;for(const item of lot.items){if(s.uncertain)item.uncertain=true;else item.shares*=s.ratio;}}}
    while(index<sorted.length&&sorted[index].day<=date){
      const t=sorted[index++],currency=inferCurrency(t.symbol,t.currency),rate=fx(currency,t.day)?.rate;
      const fee=Number(t.commission||0),amount=Number(t.total_amount),shares=Number(t.shares),key=JSON.stringify([t.account_id||'',t.symbol,currency]);
      if(!(rate>0)||!Number.isFinite(amount)||!Number.isFinite(fee)){invalidCost=true;issues.add('交易金额或交易日汇率缺失');continue;}
      realized-=fee*rate;
      const lot=queues.get(key)||{symbol:t.symbol,currency,items:[]};queues.set(key,lot);
      if(t.type==='buy'){
        if(!(shares>0)||amount<0){invalidCost=true;issues.add('买入数量或金额无效');continue;}
        lot.items.push({shares,cost:amount*rate});
      }else if(t.type==='sell'){
        if(!(shares>0)||amount<0){invalidCost=true;issues.add('卖出数量或金额无效');continue;}
        let remaining=shares,cost=0;
        while(remaining>1e-8&&lot.items.length){const item=lot.items[0],quantity=Math.min(remaining,item.shares),used=item.cost*quantity/item.shares;if(item.uncertain){invalidCost=true;issues.add('公司行为待核对的历史成本：'+t.symbol);}cost+=used;item.cost-=used;item.shares-=quantity;remaining-=quantity;if(item.shares<1e-8)lot.items.shift();}
        if(remaining>1e-8){invalidCost=true;issues.add('卖出缺少同账户买入成本：'+t.symbol);}
        realized+=amount*rate-cost;
      }else if(t.type==='other')realized+=normalizeOtherAmount(t.other_category,amount)*rate;
      else {invalidCost=true;issues.add('未支持的交易类型');}
    }
    let unrealized=0,missing=invalidCost;
    for(const lot of queues.values()){
      if(!lot.items.length)continue;
      const q=quote(lot.symbol,date),rate=fx(lot.currency,date)?.rate,lastSplit=actions.filter(s=>s.symbol===lot.symbol&&!s.uncertain&&s.date<=date).at(-1);
      if(lot.items.some(item=>item.uncertain)||!q||!(q.close>=0)||!Number.isFinite(q.close)||q.date>date||q.date<shift(date,-7)||!(rate>0)||(lastSplit&&q.date<=lastSplit.date)){
        missing=true;if(date>=opening)missingSymbols.add(lot.symbol);continue;
      }
      const shares=lot.items.reduce((n,item)=>n+item.shares,0),cost=lot.items.reduce((n,item)=>n+item.cost,0),mult=optionSymbol(lot.symbol)?100:1;
      unrealized+=shares*q.close*mult*rate-cost;
    }
    if(date>=opening)points.push({date,currency:'CNY',realized:invalidCost?null:round(realized),unrealized:missing?null:round(unrealized),total:missing?null:round(round(realized)+round(unrealized)),source:'trades',...(date===opening?{periodBoundary:'opening'}:{}),...(date===today?{provisional:true}:{})});
  }
  const baseline=points[0];
  const delta=(value,base)=>Number.isFinite(value)&&Number.isFinite(base)?round(value-base):null;
  const scoped=baseline?points.map(p=>{
    const realized=delta(p.realized,baseline.realized),unrealized=delta(p.unrealized,baseline.unrealized);
    return {...p,realized,unrealized,total:realized!==null&&unrealized!==null?round(realized+unrealized):null};
  }):[];
  const last=scoped.at(-1),missingOpening=baseline&&baseline.total===null;
  return {points:scoped,note:note+(missingOpening?' 期初估值或成本不完整，相关范围收益暂缺；补齐期初数据后恢复，不自动换用其他日期基准。':''),issues:[...issues],missingSymbols:[...missingSymbols],summary:last?{asOf:last.date,realized:last.realized,unrealized:last.unrealized,total:last.total,from:start||sorted[0].day,openingAsOf:baseline.date,opening:{realized:baseline.realized,unrealized:baseline.unrealized,total:baseline.total},complete:last.total!==null}:null};
}
