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
  const sorted=trades.map(t=>({...t,day:tradeDay(t),symbol:normalizeSymbol(t.symbol)})).filter(t=>t.day&&t.day<=end)
    .sort((a,b)=>tradeStamp(a)-tradeStamp(b)||String(a.id).localeCompare(String(b.id)));
  const note='历史证券收益按买卖记录逐日重建：同账户、证券及币种独立 FIFO，使用实际成交金额分配成本，计入佣金、股息、税费及其他证券收支。买入成本与卖出收入分别按交易日汇率折算 CNY，持仓按当日可知的最近收盘价及当日汇率估值。美股收盘价归入北京时间次日，非交易日沿用此前收盘（最多 7 天），不使用未来价格；缺行情、缺成本或汇率处留空，不以零或当前股价代替。金额为自首笔交易累计，日期筛选仅截取展示；不是该筛选范围内新增收益。不包含历史现金存量汇兑及未记录持仓，与下方全资产快照收益口径不同。';
  if(!sorted.length)return {points:[],note,issues:[],summary:null};
  const beginning=shift(sorted[0].day,-1),opening=start?shift(start,-1):beginning;
  if(end<opening)return {points:[],note,issues:[],summary:null};
  if((Date.parse(end)-Date.parse(beginning))/86400000>3700)return {points:[],note:note+' 历史跨度超过十年，请先核对交易起始日期。',issues:[],summary:null};
  const queues=new Map(),points=[],issues=new Set(),missingSymbols=new Set();
  let realized=0,invalidCost=false,index=0;
  const actions=[...splits].sort((a,b)=>a.date.localeCompare(b.date));let action=0;
  for(let date=beginning;date<=end;date=shift(date,1)) {
    while(action<actions.length&&actions[action].date<=date){const s=actions[action++];for(const lot of queues.values())if(lot.symbol===s.symbol)for(const item of lot.items){if(s.uncertain)item.uncertain=true;else item.shares*=s.ratio;}}
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
  const last=points.at(-1);
  return {points,note,issues:[...issues],missingSymbols:[...missingSymbols],summary:last?{asOf:last.date,realized:last.realized,unrealized:last.unrealized,total:last.total,from:sorted[0].day,complete:last.total!==null}:null};
}
