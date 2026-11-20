import { historicalFx } from './bookkeeping-historical-fx.js';
import { securityHistory } from './bookkeeping-security-history.js';
import { optionSymbol, reconstructTradeReturns, tradeDay, tradeStamp } from './bookkeeping-trade-returns.js';
import { inferCurrency } from '../../stock-manage/src/markets.js';
import { tradeValuation } from './bookkeeping-trade-valuation.js';
import { tradesWithReinvestmentIncome } from '../../shared/fund-reinvestment.js';

export async function tradeHistoryReturns(db,userId,filter,today,accounts,excludedIds=[],{history=securityHistory(db),fx=historicalFx(db),currentRates={}}={}) {
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
  const prices=history.read(userId);
  const valuation=tradeValuation(db,userId,included,today,data.quotes||{},currentRates,prices);
  const valid=trades.filter(t=>valuation.day(t)<=end);
  const entries=tradesWithReinvestmentIncome(valid);
  await fx.ensure(valid.map(t=>({currency:inferCurrency(t.symbol,t.currency),date:tradeDay(t)})));
  const first=valuation.first;
  const requests=new Map();
  const withBackfill=(lookup)=>(symbol,date)=>{
    const quote=lookup(symbol,date);
    if(optionSymbol(symbol)||quote&&Date.parse(date)-Date.parse(quote.date)<=7*86400000)return quote;
    const previous=requests.get(symbol);
    if(previous)previous.end=date>previous.end?date:previous.end;
    else requests.set(symbol,{symbol,start:new Date(Date.parse(date)-7*86400000).toISOString().slice(0,10),end:date});
    return quote;
  };
  let anchorUnrealized=null;
  if(first && first.date<=end){
    const before=entries.filter(t=>tradeStamp(t)<=Date.parse(first.capturedAt));
    const baselineQuote=withBackfill(valuation.baselineQuote);
    const anchor=reconstructTradeReturns(before,{end:first.date,today:first.date,quote:(symbol,date)=>date===first.date?baselineQuote(symbol,date):null,fx:fx.quote,valuationFx:valuation.baselineFx,splits:prices.splits,valuationDay:valuation.day});
    anchorUnrealized=before.length?anchor.summary?.unrealized??null:0;
  }
  const result=reconstructTradeReturns(entries,{start,end,today,quote:withBackfill(valuation.quote),fx:fx.quote,valuationFx:valuation.fx,splits:prices.splits,valuationDay:valuation.day,hybrid:{cutover:first?.date||null,anchorUnrealized}});
  const pending=requests.size?history.ensure?.(userId,[...requests.values()])||0:0;
  const unassigned=valid.filter(t=>!t.account_id).length;
  return {...result,mode:'hybrid',valuationCutover:first?.date||null,pending,unavailable:prices.unavailable||[],unassigned,tradeCount:valid.length,
    note:(valid.length?result.note:'当前范围没有可用证券成交记录。')+(unassigned?' 包含 '+unassigned+' 笔历史未归属记录，独立匹配，不与已归属账户混用成本。':'')};
}
