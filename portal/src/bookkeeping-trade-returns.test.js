import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { reconstructTradeReturns, tradeDay } from './bookkeeping-trade-returns.js';
import { parseSecurityHistory, parseSinaHistory, createSecurityHistory } from './bookkeeping-security-history.js';
import { tradeHistoryReturns } from './bookkeeping-trade-history.js';

const t=(id,type,day,shares,amount,other={})=>({id,type,trade_date:day+'T13:00:00Z',shares,total_amount:amount,commission:0,symbol:'AAPL',currency:'USD',...other});
const run=(trades,options={})=>reconstructTradeReturns(trades,{today:'2026-10-28',end:'2026-10-28',fx:(c,date)=>({rate:c==='CNY'?1:date<'2026-10-27'?7:8}),quote:(_,date)=>({date,close:12}),...options});

test('historical FIFO uses actual fills, dated FX, commissions, dividends and tax with no present-price substitution',()=>{
  const result=run([t('a','buy','2026-10-25',10,100,{commission:1}),t('b','sell','2026-10-27',4,60,{commission:1}),t('c','other','2026-10-27',0,2,{other_category:'股息税'})]);
  // Sold basis 40*7; proceeds 60*8; fees 7+8 and tax 16. Remaining basis 60*7.
  assert.equal(result.summary.realized,169);assert.equal(result.summary.unrealized,156);assert.equal(result.summary.total,325);
  const gap=run([t('a','buy','2026-10-25',10,100)],{quote:()=>null});
  assert.equal(gap.summary.realized,0);assert.equal(gap.summary.unrealized,null);assert.equal(gap.summary.total,null);
  assert.equal(gap.points[0].total,0);assert.deepEqual(gap.missingSymbols,['AAPL']);
});

test('FIFO accounts never borrow costs, options have 100 multiplier, and historical costs precede display filter',()=>{
  const trades=[t('a','buy','2026-10-25',2,100,{symbol:'QQQ261030C700',account_id:'one'}),t('b','sell','2026-10-27',1,60,{symbol:'QQQ261030C700',account_id:'one'})];
  const result=run(trades,{start:'2026-10-27',quote:(_,date)=>({date,close:0.7})});
  assert.equal(result.summary.realized,130);assert.equal(result.summary.unrealized,-70);assert.equal(result.summary.total,60);
  assert.equal(result.points[0].date,'2026-10-26');assert.equal(result.points[0].periodBoundary,'opening');
  const wrong=run([...trades,t('c','sell','2026-10-28',1,60,{symbol:'QQQ261030C700',account_id:'two'})]);
  assert.equal(wrong.summary.realized,null);assert.equal(wrong.summary.total,null);assert.match(wrong.issues[0],/缺少同账户买入成本/);
});

test('range returns reset all three series to opening and preserve older FIFO costs without counting old profits twice',()=>{
  const trades=[t('buy','buy','2026-10-23',20,200,{currency:'CNY',commission:2}),t('prior-sale','sell','2026-10-24',10,150,{currency:'CNY'}),t('sale','sell','2026-10-26',10,250,{currency:'CNY',commission:1})];
  const result=run(trades,{start:'2026-10-26',quote:(_,date)=>({date,close:20})});
  assert.deepEqual(result.summary.opening,{realized:48,unrealized:100,total:148});
  assert.deepEqual([result.points[0].realized,result.points[0].unrealized,result.points[0].total],[0,0,0]);
  assert.equal(result.summary.realized,149);assert.equal(result.summary.unrealized,-100);assert.equal(result.summary.total,49);
  assert.equal(result.summary.openingAsOf,'2026-10-25');assert.equal(result.summary.from,'2026-10-26');
  const next=run(trades,{start:'2026-10-27',quote:(_,date)=>({date,close:20})});
  assert.equal(next.summary.total,0);assert.equal(next.summary.realized,0);
});

test('unknown opening valuations remain unknown even if the last day has a price, and pre-trade periods start at zero',()=>{
  const trades=[t('buy','buy','2026-10-25',1,10,{currency:'CNY'})];
  const missing=run(trades,{start:'2026-10-27',quote:(_,date)=>date==='2026-10-26'?null:{date,close:12}});
  assert.equal(missing.summary.realized,0);assert.equal(missing.summary.unrealized,null);assert.equal(missing.summary.total,null);assert.match(missing.note,/期初估值或成本不完整/);
  const early=run(trades,{start:'2026-10-01'});
  assert.equal(early.points[0].date,'2026-09-30');assert.equal(early.points[0].total,0);assert.equal(early.summary.total,2);
  assert.equal(run(trades,{start:'2026-10-29'}).summary,null);
});

test('split lots preserve total basis and future, stale or missing prices never fill historical floating profit',()=>{
  const trades=[t('a','buy','2026-10-25',1,100),t('b','sell','2026-10-27',5,60)];
  const result=run(trades,{splits:[{symbol:'AAPL',date:'2026-10-26',ratio:10}]});
  assert.equal(result.summary.realized,130);assert.equal(result.summary.unrealized,130);
  for(const quote of [()=>({date:'2026-10-29',close:12}),()=>({date:'2026-09-01',close:12}),()=>null])assert.equal(run(trades,{quote}).summary.total,null);
  assert.equal(run([t('a','buy','2026-10-25',1,100)],{fx:()=>null}).summary.total,null);
  assert.equal(tradeDay({trade_date:'2026-10-25T23:00:00Z'}),'2026-10-26');
  assert.equal(tradeDay({trade_date:'2026-10-25 23:00:00'}),'2026-10-25');
});

test('Yahoo split-adjusted candles are restored to contemporaneous prices and US closes become available next China day',()=>{
  const stamp=d=>Date.parse(d+'T13:30:00Z')/1000;
  const data={chart:{result:[{timestamp:[stamp('2026-10-25'),stamp('2026-10-26')],indicators:{quote:[{close:[10,12]}]},events:{splits:{x:{date:stamp('2026-10-26'),numerator:10,denominator:1}}}}]}};
  const result=parseSecurityHistory('AAPL',data);assert.equal(result.prices[0].close,100);assert.equal(result.prices[0].date,'2026-10-26');assert.equal(result.prices[1].close,12);
  assert.equal(parseSecurityHistory('518600',data).prices[0].date,'2026-10-25');
});

test('fallback raw prices flag uncertain corporate actions without guessing a split ratio or profit',()=>{
  const data=parseSinaHistory('AAPL',[{d:'2026-10-25',o:100,c:100},{d:'2026-10-26',o:10,c:12}],'2026-10-01','2026-10-28');
  assert.equal(data.prices[0].close,100);assert.equal(data.splits[0].uncertain,true);assert.equal(data.splits[0].ratio,undefined);
  const result=run([t('a','buy','2026-10-25',1,100)],{splits:data.splits});
  assert.equal(result.summary.realized,0);assert.equal(result.summary.unrealized,null);
  const fresh=run([t('a','buy','2026-10-27',1,10)],{splits:data.splits});assert.equal(fresh.summary.unrealized,16);
});

test('an explicitly booked reverse split replays its sell then buy once without applying the share conversion twice',()=>{
  const trades=[t('old','buy','2026-10-25',100,855,{currency:'CNY'}),t('a-new-buy','buy','2026-10-26',33,846.45,{currency:'CNY'}),t('z-old-sell','sell','2026-10-26',100,855,{currency:'CNY'})];
  const result=run(trades,{splits:[{symbol:'AAPL',date:'2026-10-26',ratio:1/3}],quote:(_,date)=>({date,close:26})});
  assert.equal(result.summary.realized,0);assert.equal(result.summary.unrealized,11.55);assert.deepEqual(result.issues,[]);
  const genuine=run([t('old','buy','2026-10-25',300,855,{currency:'CNY'}),t('a-sell','sell','2026-10-26',100,2331,{currency:'CNY'}),t('b-buy','buy','2026-10-26',33,769.23,{currency:'CNY'})],{splits:[{symbol:'AAPL',date:'2026-10-26',ratio:1/3}],quote:(_,date)=>({date,close:26})});
  assert.equal(genuine.summary.realized,1476);assert.equal(genuine.summary.unrealized,88.77);
});

test('price backfill is bounded, deduplicated, cached per user and does not fabricate failed option quotes',async()=>{
  const db=new Database(':memory:');let calls=0,release;
  const held=new Promise(resolve=>{release=resolve;});
  const history=createSecurityHistory(db,{key:'',clock:()=>Date.parse('2026-10-28T00:00:00Z'),request:async()=>{calls++;await held;return {chart:{result:[{timestamp:[Date.parse('2026-10-26T13:30:00Z')/1000],indicators:{quote:[{close:[12]}]}}]}};}});
  try{
    const request={symbol:'AAPL',start:'2026-10-01',end:'2026-10-28'};
    history.ensure('one',[request,request]);history.ensure('one',[request]);assert.equal(calls,1);assert.equal(history.read('one').pending,1);
    release();const deadline=Date.now()+2000;while(history.read('one').pending && Date.now()<deadline)await new Promise(r=>setTimeout(r,5));
    assert.equal(history.read('one').quote('AAPL','2026-10-27').close,12);assert.equal(history.read('two').quote('AAPL','2026-10-27'),null);
    history.ensure('one',[request]);assert.equal(calls,1);
    history.ensure('one',[{...request,start:'2026-09-01'}]);
    while(history.read('one').pending && Date.now()<deadline)await new Promise(r=>setTimeout(r,5));
    assert.equal(calls,2); // Successful short caches may expand immediately when the user changes range.
    history.ensure('one',[{...request,symbol:'QQQ250221P500'}]);
    while(history.read('one').pending && Date.now()<deadline)await new Promise(r=>setTimeout(r,5));
    assert.equal(history.read('one').quote('QQQ250221P500','2026-10-27'),null);assert.ok(history.read('one').unavailable.includes('QQQ250221P500'));
  }finally{release();db.close();}
});

test('trade service isolates owners, retains a distinct legacy pool and respects account inclusion',async()=>{
  const db=new Database(':memory:');
  db.exec('CREATE TABLE portfolio_users(user_id TEXT PRIMARY KEY,data TEXT);CREATE TABLE investment_accounts(id TEXT,user_id TEXT,bookkeeping_id TEXT)');
  db.prepare('INSERT INTO portfolio_users VALUES(?,?)').run('one',JSON.stringify({quotes:{AAPL:{price:13}},trades:[t('a','buy','2026-10-25',1,10),t('b','buy','2026-10-25',1,10,{account_id:'included'}),t('c','buy','2026-10-25',1,100,{account_id:'excluded'})]}));
  db.prepare('INSERT INTO investment_accounts VALUES(?,?,?)').run('included','one','ledger');db.prepare('INSERT INTO investment_accounts VALUES(?,?,?)').run('excluded','one','other');
  const history={ensure(){},read:()=>({quote:(_,date)=>({date,close:12}),splits:[],pending:0,unavailable:[]})},fx={ensure:async()=>{},quote:()=>({rate:1})};
  try{
    const result=await tradeHistoryReturns(db,'one',{},'2026-10-28',[{id:'ledger',included:true}],[],{history,fx});
    assert.equal(result.tradeCount,2);assert.equal(result.unassigned,1);assert.equal(result.summary.total,6);
    assert.equal(result.points.find(p=>p.date==='2026-10-27').total,4);
    assert.equal((await tradeHistoryReturns(db,'two',{},'2026-10-28',[{id:'ledger',included:true}],[],{history,fx})).tradeCount,0);
    assert.equal((await tradeHistoryReturns(db,'one',{},'2026-10-28',[{id:'ledger',included:true}],['ledger'],{history,fx})).tradeCount,0);
  }finally{db.close();}
});
