import { historicalFx } from './bookkeeping-historical-fx.js';
import { securityHistory } from './bookkeeping-security-history.js';
import { reconstructTradeReturns, tradeDay } from './bookkeeping-trade-returns.js';
import { inferCurrency, normalizeSymbol } from '../../stock-manage/src/markets.js';

const shift=(date,n)=>new Date(Date.parse(date+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
export async function tradeHistoryReturns(db,userId,filter,today,accounts,excludedIds=[],{history=securityHistory(db),fx=historicalFx(db)}={}) {
  const exists=name=>db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  if(!exists('portfolio_users'))return null;
  const data=JSON.parse(db.prepare('SELECT data FROM portfolio_users WHERE user_id=?').get(userId)?.data||'{}');
  const excluded=new Set(excludedIds),included=new Set(accounts.filter(a=>a.included&&!excluded.has(a.id)).map(a=>a.id));
  const rows=exists('investment_accounts')?db.prepare('SELECT id,bookkeeping_id FROM investment_accounts WHERE user_id=?').all(userId):[];
  const allowed=new Set(rows.filter(a=>included.has(a.bookkeeping_id)).map(a=>a.id));
  const original=Array.isArray(data.trades)?data.trades:[];
  const trades=original.filter(t=>t.account_id?allowed.has(t.account_id):allowed.size>0);
  if(trades.some(t=>!tradeDay(t)))return {points:[],summary:null,issues:['存在无法识别日期的证券交易，请先核对'],missingSymbols:[],pending:0,unavailable:[],unassigned:trades.filter(t=>!t.account_id).length,tradeCount:trades.length,note:'无法将全部成交归入正确日期，历史收益暂不计算。'};
  const endRequested=filter.end||(filter.month?new Date(Date.UTC(Number(filter.month.slice(0,4)),Number(filter.month.slice(5,7)),0)).toISOString().slice(0,10):today);
  const end=endRequested<today?endRequested:today,start=filter.start||(filter.month?filter.month+'-01':'');
  const valid=trades.filter(t=>tradeDay(t)&&tradeDay(t)<=end);
  await fx.ensure(valid.map(t=>({currency:inferCurrency(t.symbol,t.currency),date:tradeDay(t)})));
  const symbols=new Map();
  for(const t of valid)if(['buy','sell'].includes(t.type)){
    const symbol=normalizeSymbol(t.symbol);if(!symbol)continue;
    const item=symbols.get(symbol)||{symbol,start:shift(tradeDay(t),-10),end};
    if(shift(tradeDay(t),-10)<item.start)item.start=shift(tradeDay(t),-10);symbols.set(symbol,item);
  }
  history.ensure(userId,[...symbols.values()]);
  const prices=history.read(userId);
  const result=reconstructTradeReturns(valid,{start,end,today,quote:prices.quote,fx:fx.quote,splits:prices.splits});
  const unassigned=valid.filter(t=>!t.account_id).length;
  return {...result,pending:prices.pending,unavailable:prices.unavailable,unassigned,tradeCount:valid.length,
    note:result.note+(unassigned?' 包含 '+unassigned+' 笔历史未归属记录，独立匹配，不与已归属账户混用成本。':'')+(prices.pending?' 历史行情后台补齐中，页面会随刷新更新。':'')};
}
