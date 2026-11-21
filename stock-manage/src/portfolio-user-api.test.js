import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import XLSX from 'xlsx';
import { createRequire } from 'node:module';
import { createBookkeepingStore } from '../../portal/src/bookkeeping-store.js';
import { parseImportBuffer } from './import-moomoo.js';

test('real API rejects anonymous access and scopes portfolio, updates, import, export, review and summary', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-user-api-'));
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify({ server: { host: '127.0.0.1', port }, dbPath: path.join(directory, 'db.sqlite'), dataFile: path.join(directory, 'empty.json') }));
  const server = fileURLToPath(new URL('./server.js', import.meta.url));
  const provider = path.join(directory, 'quote-provider.mjs');
  fs.writeFileSync(provider, `globalThis.fetch = async url => {
    if (String(url).includes('fundCode=000198')) return Response.json({Data:{FundType:'005',SYType:'每万份收益',LSJZList:[{DWJZ:'0.2168',FSRQ:'2026-11-13'}]}});
    if (String(url).includes('/f10/lsjz') && String(url).includes('startDate=')) {
      const code = new URL(url).searchParams.get('fundCode');
      const dividend = {DWJZ:'1.6656',FSRQ:'2026-11-05',FHFCZ:'0.005',FHSP:'每10份派现金0.0500元'};
      return Response.json({ErrCode:0,Data:{LSJZList:[
        {DWJZ:'1.6825',FSRQ:'2026-11-06'}, dividend,
        ...(code === '000001' ? [{...dividend,FSRQ:'2026-11-04'}] : [])
      ]}});
    }
    if (String(url).includes('/f10/lsjz')) return Response.json({Data:{LSJZList:[
      {DWJZ:'2.9800',FSRQ:'2026-11-13'}, {DWJZ:'2.9000',FSRQ:'2026-11-12'}
    ]}});
    if (String(url).includes('/chart/AAPL')) return Response.json({chart:{result:[{meta:{longName:'Apple Inc.',regularMarketPrice:25,chartPreviousClose:20}}]}});
    if (String(url).includes('FundSearchAPI.ashx')) {
      const code = new URL(url).searchParams.get('key');
      const fund = (NAME, MINSG) => ({CODE:code, NAME, CATEGORY:700, FundBaseInfo:{MINSG}});
      const datas = ({
        '000001': [fund('华夏成长混合',10), {CODE:code, NAME:'平安银行', CATEGORY:150, STOCKMARKET:'2'}],
        '110022': [fund('易方达消费行业股票',10)],
        '159509': [fund('纳指科技ETF景顺',null)]
      })[code] || [];
      return Response.json({ErrCode:0,Datas:datas});
    }
    if (String(url).includes('q=hk00700')) {
      const fields = Array(83).fill('');
      fields[1] = 'Tencent'; fields[2] = '00700'; fields[3] = '40'; fields[4] = '39';
      fields[30] = '2026/11/16 15:00:00'; fields[82] = 'HKD';
      return new Response('v_hk00700="'+fields.join('~')+'";');
    }
    if (String(url).includes('DEXHKUS')) return new Response('observation_date,DEXCHUS,DEXHKUS\\n2026-11-13,7.1,8\\n');
    if (String(url).includes('fredgraph.csv')) return new Response('observation_date,DEXCHUS\\n2026-10-23,7.1\\n');
    throw new Error('Unexpected fixture request');
  };`);
  const child = spawn(process.execPath, ['--import', pathToFileURL(provider).href, server], { cwd: directory, env: { ...process.env, NAVIGATION_DB_PATH: path.join(directory, 'db.sqlite') }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}/api`;
  const call = (url, user, method = 'GET', body) => fetch(base + url, { method, headers: { ...(user ? { 'x-portal-user-id': user, 'x-portal-permissions': Buffer.from('["*"]').toString('base64url') } : {}), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(base + '/health')).ok) { ready = true; break; } } catch { /* startup */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(ready);
    assert.equal((await call('/portfolio')).status, 401);
    assert.deepEqual(await (await call('/fund-reinvestment/nav?symbol=022951.OF&date=2026-11-06','a')).json(),
      {nav:1.6656,date:'2026-11-05'});
    assert.equal(await (await call('/fund-reinvestment/nav?symbol=022951.OF&date=2026-11-10','a')).json(),null);
    assert.equal(await (await call('/fund-reinvestment/nav?symbol=000001.OF&date=2026-11-06','a')).json(),null);
    assert.equal((await call('/portfolio', 'bad id')).status, 401);
    let response = await call('/cash', 'a', 'PUT', { cashUsd: 1000, userId: 'b' });
    assert.equal(response.status, 200);
    response = await call('/trades', 'a', 'POST', { type: 'buy', symbol: 'AAPL', name: 'Apple', shares: 1, price: 10, userId: 'b', trade_date: '2026-01-01T00:00:00Z' });
    const a = await response.json();
    assert.equal(a.trades.length, 1);
    const id = a.trades[0].id;
    const b = await (await call('/portfolio?userId=a', 'b')).json();
    assert.equal(b.trades.length, 0);
    assert.equal(b.cashUsd, 0);
    assert.equal((await call('/trades/' + id, 'b', 'DELETE')).status, 404);
    assert.equal((await call('/trades/' + id, 'b', 'PUT', { type: 'buy', symbol: 'AAPL', name: 'Apple', shares: 1, price: 2 })).status, 404);
    assert.deepEqual(await (await call('/trades/summary', 'b')).json(), []);
    assert.equal((await (await call('/trades/review', 'b')).json()).currencies.length, 0);
    const workbook = XLSX.read(Buffer.from(await (await call('/trades/export', 'b')).arrayBuffer()));
    assert.equal(XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]).length, 0);
    const payload = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(payload, XLSX.utils.aoa_to_sheet([['时间','类型','交易方向','其它类别','代码','名称','股数','价格','金额','手续费'],['2026-01-02 12:00:00','股票','买入','','GOOG','Google',1,20,20,0]]), '交易记录');
    const imported = await fetch(base + '/trades/import?mode=replace', { method: 'POST', headers: { 'x-portal-user-id': 'b', 'Content-Type': 'application/octet-stream' }, body: XLSX.write(payload, { type: 'buffer', bookType: 'xlsx' }) });
    assert.equal(imported.status, 200);
    assert.equal((await (await call('/portfolio', 'a')).json()).trades[0].symbol, 'AAPL');
    assert.equal((await (await call('/portfolio', 'b')).json()).trades[0].symbol, 'GOOG');
    assert.match((await call('/portfolio', 'a')).headers.get('cache-control'), /no-store/);
    const require = createRequire(import.meta.url);
    const Database = require('../../portal/node_modules/better-sqlite3');
    const db = new Database(path.join(directory, 'db.sqlite'));
    let lid;
    try { lid = createBookkeepingStore(db).saveAccount('a', { name: '海外理财', currency: 'USD', balance: 99999 }); } finally { db.close(); }
    const denied = await fetch(base + '/accounts', { headers: { 'x-portal-user-id': 'a', 'x-portal-permissions': Buffer.from('[]').toString('base64url') } });
    assert.equal(denied.status, 403);
    assert.equal((await call('/accounts', 'a', 'POST', { name: '券商', currency: 'USD', bookkeepingId: lid, baselineCash: 100 })).status, 200);
    const investment = (await (await call('/accounts', 'a')).json()).accounts[0];
    assert.equal(investment.cash, 100);
    assert.equal((await (await call('/accounts', 'b')).json()).accounts.length, 0);
    assert.equal((await call('/accounts/' + investment.id, 'b', 'PUT', { name: '越权' })).status, 400);
    assert.equal((await call('/cash', 'a', 'PUT', { cashUsd: 999 })).status, 400);
    assert.equal((await call('/accounts/' + investment.id + '/assign', 'a', 'POST', {})).status, 200);
    const assigned = await (await call('/portfolio?accountId=' + investment.id, 'a')).json();
    assert.equal(assigned.trades[0].account_id, investment.id);
    assert.equal(assigned.holdings[0].accountName, '券商');
    assert.equal(assigned.cashUsd, 100);
    assert.deepEqual(assigned.missingQuotes, ['AAPL']);
    assert.equal(assigned.summary.totalAssets, null);
    const refreshed = await (await call('/quotes/refresh', 'a', 'POST', { symbol: 'AAPL' })).json();
    assert.equal(refreshed.refresh.ok, 1);
    assert.deepEqual(refreshed.missingQuotes, []);
    assert.equal(refreshed.summary.totalAssets, 125);
    assert.equal(refreshed.cashUsd, 100);
    const bbaeBook = XLSX.utils.book_new();
    const bbaeRows = [['订单状态','方向','股票代码','成交价','成交数量','总计','下单时间','成交时间'],['已成','买入','AAPL','$25.000',1,'$26.00','2099/01/01 20:00:00','2099/01/01 20:00:01']];
    XLSX.utils.book_append_sheet(bbaeBook, XLSX.utils.aoa_to_sheet(bbaeRows), '股票');
    const upload = (route, user = 'a') => fetch(base + route, { method:'POST', headers:{'x-portal-user-id':user,'x-portal-permissions':Buffer.from('["*"]').toString('base64url'),'Content-Type':'application/octet-stream'},body:XLSX.write(bbaeBook,{type:'buffer',bookType:'xlsx'}) });
    assert.equal((await upload('/trades/import/preview')).status,400);
    assert.equal((await upload('/trades/import/preview?accountId='+investment.id,'b')).status,400);
    let bbae = await (await upload('/trades/import/preview?accountId='+investment.id)).json();
    assert.deepEqual(bbae.summary,{added:1,updated:0,skipped:0});
    const [resolvedAapl] = await (await call('/instruments/resolve?symbol=AAPL', 'a')).json();
    assert.notEqual(resolvedAapl.name, 'AAPL');
    assert.equal(bbae.preview[0].name, resolvedAapl.name);
    const importRoute='/trades/import?accountId='+investment.id;
    bbae=await (await upload(importRoute)).json();
    assert.equal(bbae.importSummary.added,1);assert.equal(bbae.cashUsd,74);
    assert.equal(bbae.trades.find(t => t.broker === 'bbae').name, resolvedAapl.name);
    bbae=await (await upload(importRoute)).json();
    assert.deepEqual(bbae.importSummary,{added:0,updated:0,skipped:1});assert.equal(bbae.cashUsd,74);
    bbaeRows[1][5]='$26.02';bbaeBook.Sheets['股票']=XLSX.utils.aoa_to_sheet(bbaeRows);
    assert.equal((await upload(importRoute)).status,400);
    bbae=await (await upload(importRoute+'&allowUpdates=1')).json();
    assert.equal(bbae.importSummary.updated,1);assert.equal(bbae.cashUsd,73.98);
    assert.equal((await upload(importRoute+'&mode=replace')).status,400);
    const importedTrade = bbae.trades.find(t => t.broker === 'bbae');
    const edited = await (await call('/trades/'+importedTrade.id,'a','PUT',{...importedTrade,trade_date:'2099-01-01T12:02:00.000Z'})).json();
    assert.equal(edited.trades.find(t=>t.id===importedTrade.id).broker_order_key,importedTrade.broker_order_key);
    bbae=await (await upload(importRoute+'&allowUpdates=1')).json();
    assert.equal(bbae.importSummary.updated,1);assert.equal(bbae.trades.filter(t=>t.broker==='bbae').length,1);
    // Eastmoney follows the same authenticated preview/confirm flow, scoped to CNY accounts.
    const cnCreated = await call('/accounts','a','POST',{name:'东方财富',currency:'CNY',baselineCash:2000});
    assert.equal(cnCreated.status,200);
    const cnId = (await (await call('/accounts','a')).json()).accounts.find(a=>a.currency==='CNY').id;
    const accountOrder = [cnId, investment.id];
    assert.equal((await call('/accounts/order', '', 'PUT', { ids: accountOrder })).status, 401);
    assert.equal((await call('/accounts/order', 'a', 'PUT', { ids: [cnId, cnId] })).status, 400);
    assert.equal((await call('/accounts/order', 'b', 'PUT', { ids: accountOrder })).status, 409);
    assert.equal((await call('/accounts/order', 'a', 'PUT', { ids: accountOrder })).status, 200);
    assert.deepEqual((await (await call('/accounts','a')).json()).accounts.map(account => account.id), accountOrder);
    assert.deepEqual((await (await call('/portfolio?accountId='+investment.id,'a')).json()).investmentAccounts.map(account => account.id), accountOrder);
    const cnBook=XLSX.utils.book_new();
    const cnColumns=['交收日期','发生日期','发生时间','证券代码','证券名称','交易类别','成交数量','成交均价','成交金额','发生金额','佣金','其他费用','印花税','过户费','成交编号','流水号','股东账号','币种'];
    const cnRow=['2099-01-02','2099-01-01','13:00:00','501225','全球芯片LOF','证券买入',200,3.554,710.8,-710.98,0.15,0.03,0,0,'0001','0002','A','人民币'];
    const cnIgnored=[...cnRow];cnIgnored[5]='天天宝申购';
    XLSX.utils.book_append_sheet(cnBook,XLSX.utils.aoa_to_sheet([cnColumns,cnRow,cnIgnored]),'交割单');
    const cnUpload=(route,user='a')=>fetch(base+route,{method:'POST',headers:{'x-portal-user-id':user,'x-portal-permissions':Buffer.from('["*"]').toString('base64url'),'Content-Type':'application/octet-stream'},body:XLSX.write(cnBook,{type:'buffer',bookType:'xlsx'})});
    assert.equal((await cnUpload('/trades/import/preview')).status,400);
    assert.equal((await cnUpload('/trades/import/preview?accountId='+investment.id)).status,400);
    assert.equal((await cnUpload('/trades/import/preview?accountId='+cnId,'b')).status,400);
    const cnRoute='/trades/import?accountId='+cnId;
    const cnPreview=await (await cnUpload('/trades/import/preview?accountId='+cnId)).json();
    assert.equal(cnPreview.count,1);assert.equal(cnPreview.format,'eastmoney');assert.equal(cnPreview.summary.excluded[0].count,1);
    assert.equal((await cnUpload(cnRoute+'&mode=replace')).status,400);
    let cnResult=await (await cnUpload(cnRoute)).json();
    assert.equal(cnResult.importSummary.added,1);assert.equal(cnResult.cashCny,1289.02);
    cnResult=await (await cnUpload(cnRoute)).json();
    assert.equal(cnResult.importSummary.skipped,1);assert.equal(cnResult.cashCny,1289.02);
    assert.equal((await (await call('/portfolio','b')).json()).trades.some(t=>t.broker==='eastmoney'),false);
    const fund = `/fund-holdings/${cnId}/501225`;
    const fundInput = { name:'场外份额', shares:250.5, cost:700 };
    assert.equal((await call(fund, 'b', 'PUT', fundInput)).status, 400);
    assert.equal((await call(`/fund-holdings/${cnId}/000198`, 'a', 'PUT', fundInput)).status, 400);
    assert.equal((await fetch(base+fund,{method:'PUT',headers:{'x-portal-user-id':'a','x-portal-permissions':'W10','Content-Type':'application/json'},body:JSON.stringify(fundInput)})).status,403);
    assert.equal((await call(fund, 'a', 'PUT', fundInput)).status, 200);
    assert.equal((await call(fund, 'a', 'PUT', fundInput)).status, 409);
    const fundPortfolio = await (await call('/portfolio?accountId='+cnId, 'a')).json();
    assert.equal(fundPortfolio.cashCny, 1289.02);
    assert.equal(fundPortfolio.fundHoldings[0].marketValue, 746.49);
    assert.equal(fundPortfolio.fundHoldings[0].pnl, 46.49);
    assert.equal(fundPortfolio.fundHoldings[0].dailyPnl, null);
    assert.equal(fundPortfolio.fundHoldings[0].dailyPnlPct, null);
    assert.equal(fundPortfolio.holdings.find(t=>t.symbol==='501225').shares, 200);
    const grouped = await (await call('/holdings-meta/501225.OF', 'a', 'PUT', {groupWith:'AAPL'})).json();
    const groupedFund = grouped.fundHoldings[0];
    const groupAnchor = grouped.holdings.find(h => h.symbol === 'AAPL');
    assert.equal(groupedFund.groupWith, 'AAPL');
    assert.equal(groupedFund.groupMarketValue, groupAnchor.groupMarketValue);
    assert.equal(groupedFund.weight, groupAnchor.weight);
    assert.notEqual(grouped.holdings.find(h => h.symbol === '501225').groupKey, 'AAPL');
    const resetGroup = await (await call('/holdings-meta/501225.OF', 'a', 'PUT', {groupWith:''})).json();
    assert.equal(resetGroup.fundHoldings[0].groupWith, '');
    assert.equal((await (await call('/portfolio?accountId='+investment.id, 'a')).json()).fundHoldings.length, 0);
    assert.equal((await (await call('/portfolio','b')).json()).fundHoldings.length, 0);
    assert.equal((await call(fund+'/refresh','a','POST')).status, 200);
    const refreshedFund = await (await call('/portfolio?accountId='+cnId, 'a')).json();
    assert.equal(refreshedFund.fundHoldings[0].dailyPnl, 20.04);
    assert.equal(refreshedFund.fundHoldings[0].dailyPnlPct, 2.7586206896551726);
    assert.equal(refreshedFund.summary.marketDailyPnlCny, 20.04);
    const channelDb = new Database(path.join(directory, 'db.sqlite'));
    try {
      const channel = createBookkeepingStore(channelDb).saveAccount('a', { name:'基金渠道', currency:'CNY', balance:9999 });
      assert.equal((await call('/accounts','a','POST',{name:'基金渠道',currency:'CNY',bookkeepingId:channel,baselineCash:50})).status,200);
      const account = (await (await call('/accounts','a')).json()).accounts.find(x=>x.bookkeepingId===channel);
      const channelFund = `/fund-holdings/${account.id}/501225`;
      assert.equal((await call(channelFund,'a','PUT',fundInput)).status,200);
      const linked = createBookkeepingStore(channelDb).accounts('a').find(x=>x.id===channel);
      assert.equal(linked.ledgerBalance,9999);
      assert.equal(linked.balance,796.49);
      assert.equal((await call('/accounts','a').then(r=>r.json())).accounts.find(x=>x.id===account.id).cash,50);
      assert.equal((await call(fund,'a','DELETE')).status,200);
      assert.equal((await call(channelFund,'a','DELETE')).status,200);
    } finally { channelDb.close(); }
    assert.equal((await (await call('/portfolio','a')).json()).fundHoldings.length, 0);
    const resolve = async symbol => (await call('/instruments/resolve?symbol=' + symbol, 'a')).json();
    assert.deepEqual((await resolve('000001')).map(i => [i.symbol, i.name]),
      [['000001','平安银行'], ['000001.OF','华夏成长混合']]);
    assert.deepEqual((await resolve('159509')).map(i => i.assetType), ['ashare']);
    assert.deepEqual(await resolve('110022'), [{symbol:'110022.OF', name:'易方达消费行业股票', assetType:'fund', currency:'CNY'}]);
    assert.equal((await resolve('00700'))[0].name, 'Tencent');
    assert.equal((await resolve('AAPL'))[0].name, 'Apple Inc.');
    assert.equal((await resolve('000001.OF'))[0].name, '华夏成长混合');
    assert.equal((await fetch(base + '/instruments/resolve?symbol=AAPL', {headers:{'x-portal-user-id':'a','x-portal-permissions':'W10'}})).status, 403);

    assert.equal((await call(fund, 'a', 'PUT', fundInput)).status, 200);
    const fundTrade = { symbol:'501225.OF', account_id:cnId, type:'sell', shares:50.5,
      price:3.1234, commission:1, trade_date:'2099-01-01T12:00:00Z' };
    const sale = await call('/trades?accountId=' + cnId, 'a', 'POST', fundTrade);
    assert.equal(sale.status, 200);
    const afterSale = await sale.json();
    const sold = afterSale.trades.find(t => t.symbol === fundTrade.symbol);
    assert.equal(sold.price, 3.1234);
    assert.equal(afterSale.cashCny, 1445.75);
    assert.equal(afterSale.fundHoldings[0].shares, 200);
    assert.equal(afterSale.fundHoldings[0].cost, 558.88);
    assert.equal(afterSale.fundHoldings[0].marketValue, 596);
    assert.equal(afterSale.fundHoldings[0].editableSnapshot, false);
    assert.equal(afterSale.holdings.find(t => t.symbol === '501225').shares, 200);
    assert.equal(afterSale.trades.some(t => t.openingFund), false);
    const fundSummary = await (await call('/trades/summary?assetType=fund&accountId=' + cnId, 'a')).json();
    assert.equal(fundSummary[0].totalBuyAmount, 0);
    assert.ok(fundSummary[0].netPnl > 0);
    assert.ok(fundSummary[0].netPnlRate > 0);
    const review = await (await call('/trades/review?assetType=fund&accountId=' + cnId, 'a')).json();
    assert.equal(review.firstDate, '2099-01-01');
    assert.equal(review.currencies[0].unmatched.length, 0);
    assert.equal(review.currencies[0].holding[0].key, 'unknown');
    assert.equal((await call(fund, 'a', 'DELETE')).status, 409);
    assert.equal((await call('/trades', 'a', 'POST', {...fundTrade, shares:201})).status, 400);
    assert.equal((await call('/trades/' + sold.id, 'a', 'DELETE')).status, 200);
    assert.equal((await call(fund, 'a', 'DELETE')).status, 200);
    const buy = await call('/trades?accountId=' + cnId, 'a', 'POST',
      {...fundTrade, type:'buy', symbol:'110022.OF', shares:100, price:2.9001, commission:0});
    assert.equal(buy.status, 200);
    const afterBuy = await buy.json();
    assert.equal(afterBuy.cashCny, 999.01);
    assert.equal(afterBuy.fundHoldings[0].name, '易方达消费行业股票');
    assert.equal(afterBuy.fundHoldings[0].marketValue, 298);
    assert.equal(afterBuy.fundHoldings[0].dailyPnl, 8);
    assert.equal((await call(`/fund-holdings/${cnId}/110022/refresh`, 'a', 'POST')).status, 200);
    const bought = afterBuy.trades.find(t => t.symbol === '110022.OF');
    const exportFund = await call('/trades/export?assetType=fund', 'a');
    const exported = XLSX.read(Buffer.from(await exportFund.arrayBuffer()), {cellNF:true});
    assert.equal(exported.Sheets.交易记录.K2.v, 2.9001);
    assert.equal(exported.Sheets.交易记录.K2.z, '0.0000');
    assert.equal((await call('/trades/' + bought.id, 'a', 'DELETE')).status, 200);
    const fundBook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(fundBook, XLSX.utils.aoa_to_sheet([
      ['成交日期','基金代码','基金名称','操作','成交数量','成交金额','基金账号','合同编号'],
      ['2099-01-01','017730','嘉实全球产业升级','申购',167.3,500,'test-fund-account','test-contract']
    ]), '基金');
    const uploadFund = route => fetch(base + route, { method:'POST', headers:{
      'x-portal-user-id':'a','x-portal-permissions':'WyIqIl0','Content-Type':'application/octet-stream'
    }, body:XLSX.write(fundBook,{type:'buffer',bookType:'xlsx'}) });
    assert.equal((await uploadFund('/trades/import/preview?accountId=' + investment.id)).status,400);
    const fp = await (await uploadFund('/trades/import/preview?accountId=' + cnId)).json();
    assert.equal(fp.format,'fund');
    assert.equal(fp.preview[0].symbol,'017730.OF');
    assert.equal(fp.preview[0].total_amount,500);
    const fundImported = await (await uploadFund('/trades/import?accountId=' + cnId)).json();
    assert.equal(fundImported.importSummary.added,1);
    assert.equal(fundImported.cashCny,789.02);
    assert.equal(fundImported.fundHoldings[0].shares,167.3);
    assert.equal(fundImported.fundHoldings[0].cost,500);
    const reinvest = await (await call('/trades?accountId=' + cnId, 'a', 'POST', {
      type:'buy', symbol:'017730.OF', shares:3.61, reinvestedDividend:true, account_id:cnId,
      trade_date:'2099-01-02T16:11:13+08:00'
    })).json();
    assert.equal(reinvest.cashCny,789.02);
    assert.equal(reinvest.fundHoldings[0].shares,170.91);
    assert.equal(reinvest.fundHoldings[0].cost,500);
    const oldReinvest = reinvest.trades.find(t=>t.reinvestedDividend);
    const estimated = await (await call('/trades/' + oldReinvest.id + '?accountId=' + cnId, 'a', 'PUT',
      {...oldReinvest, reinvestmentNav:1.6656})).json();
    assert.equal(estimated.cashCny,789.02);
    assert.equal(estimated.fundHoldings[0].shares,170.91);
    assert.equal(estimated.fundHoldings[0].cost,506.01);
    assert.equal(estimated.trades.find(t=>t.reinvestedDividend).estimatedReinvestmentIncome,6.01);
    assert.equal(estimated.trades.filter(t=>t.reinvestedDividend).length,1);
    const reinvestSummary = await (await call('/trades/summary?assetType=fund&accountId=' + cnId, 'a')).json();
    assert.ok(reinvestSummary.some(t=>t.otherCategory==='红利再投资（估算）' && t.otherAmount > 0));
    const [reinvestExport] = parseImportBuffer(Buffer.from(await (await call('/trades/export?assetType=fund&start=2099-01-02', 'a')).arrayBuffer()));
    assert.equal(reinvestExport.reinvestedDividend,true);
    assert.equal(reinvestExport.shares,3.61);
    assert.equal(reinvestExport.reinvestmentNav,1.6656);
    assert.equal((await call('/trades/' + reinvest.trades.find(t=>t.reinvestedDividend).id,'a','DELETE')).status,200);
    const again = await (await uploadFund('/trades/import?accountId=' + cnId)).json();
    assert.equal(again.importSummary.skipped,1);
    assert.equal(again.cashCny,789.02);
    assert.equal((await call('/trades/' + fundImported.trades.find(t=>t.broker==='fund-settlement').id,'a','DELETE')).status,200);
    const hkTrade = {type:'buy',symbol:'0700.HK',shares:10,price:32,commission:8,trade_date:'2099-01-01T12:00:00Z'};
    assert.equal((await call('/trades','b','POST',hkTrade)).status,400);
    const hkDb = new Database(path.join(directory, 'db.sqlite'));
    try {
      const ledger = createBookkeepingStore(hkDb).saveAccount('a', { name:'港币券商', currency:'HKD', balance:9999 });
      const hkCreated = await call('/accounts','a','POST',{name:'港股',currency:'HKD',bookkeepingId:ledger,baselineCash:800});
      assert.equal(hkCreated.status,200);
      const hkId = (await hkCreated.json()).id;
      assert.equal((await call('/trades','a','POST',{...hkTrade,account_id:investment.id})).status,400);
      assert.equal((await call('/trades','a','POST',{...hkTrade,account_id:hkId})).status,200);
      const refresh = await (await call('/quotes/refresh?accountId='+hkId,'a','POST',{symbol:'00700'})).json();
      assert.equal(refresh.refresh.ok,1);
      assert.equal(refresh.cashHkd,472);
      assert.equal(refresh.summary.assetsHkd,872);
      assert.equal(refresh.summary.totalAssets,109);
      assert.equal(refresh.summary.totalPnlHkd,80);
      assert.equal(refresh.summary.dailyTotalPnlHkd,10);
      assert.equal(refresh.summary.commission,1);
      assert.equal(refresh.holdings[0].symbol,'00700.HK');
      assert.equal(refresh.holdings[0].currency,'HKD');
      assert.equal(createBookkeepingStore(hkDb).accounts('a').find(a=>a.id===ledger).balance,872);
      const hidden = await fetch(base+'/portfolio?accountId='+hkId,{headers:{'x-portal-user-id':'a','x-portal-permissions':'W10'}}).then(r=>r.json());
      assert.equal('cashHkd' in hidden,false);
      assert.equal('assetsHkd' in hidden.summary,false);
      assert.equal((await (await call('/trades/summary?assetType=hkstock','a')).json())[0].totalBuyAmount,40);
      assert.equal((await call('/trades','a','POST',{...hkTrade,type:'sell',symbol:'00700',shares:5,price:40,commission:4,account_id:hkId,trade_date:'2099-01-02T12:00:00Z'})).status,200);
      const afterSale = await (await call('/portfolio?accountId='+hkId,'a')).json();
      assert.equal(afterSale.cashHkd,668);
      assert.equal(afterSale.holdings[0].shares,5);
      assert.equal(afterSale.summary.realizedPL,5);
      assert.equal(afterSale.summary.netPL,3.5);
      assert.equal(afterSale.summary.totalAssets,108.5);
      assert.equal(createBookkeepingStore(hkDb).accounts('a').find(a=>a.id===ledger).balance,868);
    } finally { hkDb.close(); }
    const readonly = await fetch(base + '/accounts', { headers: { 'x-portal-user-id': 'a', 'x-portal-permissions': Buffer.from('["service:stock-manage:accounts:view"]').toString('base64url') } });
    const masked = await readonly.json();
    assert.equal('cash' in masked.accounts[0], false);
    assert.deepEqual(masked.accounts.slice(0, 2).map(account => account.id), accountOrder);
    const holdingsOnly = {
      headers: {
        'x-portal-user-id': 'a',
        'x-portal-permissions': Buffer.from('["service:stock-manage:view"]').toString('base64url')
      }
    };
    const portfolio = await (await fetch(base + '/portfolio', holdingsOnly)).json();
    assert.ok(portfolio.holdings.length > 0);
    assert.deepEqual(portfolio.investmentAccounts, []);
    assert.ok(portfolio.holdings.every(holding => !('accountName' in holding)));
    assert.ok(portfolio.fundHoldings.every(fund => !('accountName' in fund)));
    assert.deepEqual(portfolio.trades, []);
    assert.equal('chartSparse' in portfolio, false);
    for (const field of ['totalBuy', 'totalSell', 'commission', 'otherAmount', 'realizedPL', 'netPL']) {
      assert.equal(field in portfolio.summary, false);
    }
    for (const path of ['/accounts', '/pnl', '/trades/summary', '/trades/export', '/trades/review']) {
      assert.equal((await fetch(base + path, holdingsOnly)).status, 403, path);
    }
  } finally {
    child.kill();
    await new Promise((resolve) => child.exitCode != null ? resolve() : child.once('exit', resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
