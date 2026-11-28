import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

function fixture() {
  const dom=new JSDOM(fs.readFileSync(new URL('../public/bookkeeping/index.html',import.meta.url),'utf8'),{runScripts:'outside-only'}),w=dom.window;
  const $=id=>w.document.getElementById(id),drills=[];
  const state={analysis:{billing:{missingCurrencies:[],granularity:'day',points:[
    {date:'2026-10-01',currency:'CNY',income:1000,expense:20,cumulative:980},
    {date:'2026-10-02',currency:'CNY',income:0,expense:30,cumulative:950}
  ]},insights:[],comparisonNote:'',asset:{points:[{date:'2026-09-30',currency:'CNY',balance:500},{date:'2026-10-02',currency:'CNY',balance:600}],historyMode:'hybrid',missingCurrencies:[],note:''}}};
  w.HTMLElement.prototype.scrollIntoView=function(){};
  w.eval(fs.readFileSync(new URL('../public/bookkeeping/candles.js',import.meta.url),'utf8'));
  w.__assetCalls=[];w.__assetMode='candle';
  // ECharts cannot render in jsdom; record the wiring instead of the pixels.
  w.createBookkeepingAssetChart=()=>({
    mode:()=>w.__assetMode,
    render:(points,currency,bucket)=>w.__assetCalls.push({points:points.length,currency,unit:bucket&&bucket.unit}),
    setMode:mode=>{w.__assetMode=mode;},
    dispose(){}
  });
  w.eval(fs.readFileSync(new URL('../public/bookkeeping/analysis.js',import.meta.url),'utf8'));
  const money=(amount,currency)=>currency+' '+amount.toFixed(2);
  const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  const controller=w.createBookkeepingAnalysis({$,esc,money,m:(a,c)=>'<span data-money>'+money(a,c)+'</span>',can:()=>true,load(){},tab:name=>drills.push(name),getState:()=>state,periods:{focusDate:data=>drills.push(data),restore(){}}});
  controller.render();
  // The page now defaults to candlesticks; these cases cover the line view, so
  // switch once here and keep every later render in that mode.
  w.document.querySelector('[data-chart-mode="line"]').click();
  const button=key=>$('billing-charts').querySelector('[data-billing-series="'+key+'"]');
  const toggle=key=>button(key).click();
  return {dom,w,$,state,controller,button,toggle,drills};
}

test('each legend independently hides its line and drill points without changing totals or asset chart',()=>{
  const f=fixture();
  try {
    const asset=f.$('asset-overview-charts').innerHTML, totals=f.$('billing-charts').querySelector('.bk-chart-legend').textContent;
    assert.equal(f.$('billing-charts').querySelectorAll('polyline').length,3);
    f.toggle('income');
    assert.equal(f.button('income').getAttribute('aria-pressed'),'false');
    assert.equal(f.$('billing-charts').querySelector('[data-chart-series="income"]'),null);
    assert.equal(f.$('billing-charts').querySelectorAll('polyline').length,2);
    assert.equal(f.$('billing-charts').querySelector('.bk-chart-legend').textContent,totals);
    assert.equal(f.$('asset-overview-charts').innerHTML,asset);
    assert.equal(f.w.document.activeElement,f.button('income'));
    f.$('billing-charts').querySelector('[data-chart-series="expense"] circle').dispatchEvent(new f.w.MouseEvent('click',{bubbles:true}));
    assert.equal(f.drills[0].day,'2026-10-01');assert.equal(f.drills[0].flow,'expense');assert.equal(f.drills[1],'entries');
    assert.ok(f.button('income').querySelector('[data-money]'));
    assert.equal(f.button('income').getAttribute('aria-label'),'收入合计折线');
  } finally {f.dom.window.close();}
});

test('axis follows visible lines and all-hidden state can restore any line',()=>{
  const f=fixture();
  try {
    const prior=f.$('billing-charts').querySelector('[data-chart-series="expense"] polyline').getAttribute('points');
    f.toggle('income');f.toggle('cumulative');
    assert.notEqual(f.$('billing-charts').querySelector('[data-chart-series="expense"] polyline').getAttribute('points'),prior);
    assert.ok([...f.$('billing-charts').querySelectorAll('svg text')].some(e=>e.textContent==='30'));
    f.toggle('expense');assert.equal(f.$('billing-charts').querySelectorAll('polyline').length,0);
    assert.match(f.$('billing-charts').textContent,/所有折线已隐藏/);
    assert.doesNotMatch(f.$('billing-charts').innerHTML,/NaN|Infinity/);
    f.toggle('cumulative');assert.equal(f.$('billing-charts').querySelectorAll('polyline').length,1);
    assert.equal(f.button('cumulative').getAttribute('aria-pressed'),'true');
  } finally {f.dom.window.close();}
});

test('visibility survives period data reload, no-data and missing-FX views',()=>{
  const f=fixture();
  try {
    f.toggle('expense');
    f.state.analysis.billing.points=[];f.controller.render();assert.match(f.$('billing-charts').textContent,/暂无记录/);
    f.state.analysis.billing.missingCurrencies=['USD'];f.controller.render();assert.match(f.$('billing-charts').textContent,/缺少 USD 汇率/);
    f.state.analysis.billing.missingCurrencies=[];
    f.state.analysis.billing.points=[{date:'2026-11-01',currency:'CNY',income:100,expense:80,cumulative:20}];f.controller.render();
    assert.equal(f.button('expense').getAttribute('aria-pressed'),'false');
    assert.equal(f.$('billing-charts').querySelectorAll('polyline').length,2);
    assert.match(f.button('expense').textContent,/80\.00/);
    f.toggle('expense');assert.equal(f.$('billing-charts').querySelectorAll('polyline').length,3);
  } finally {f.dom.window.close();}
});

test('the accounts tab renders one balance chart with the portfolio style switch',()=>{
  const f=fixture();
  try{
    const host=f.$('asset-overview-charts');
    assert.ok(host.querySelector('.bk-chart-card'),'asset card should render');
    assert.equal(host.querySelectorAll('[data-asset-mode]').length,2);
    assert.equal(host.querySelector('[data-asset-mode="candle"]').getAttribute('aria-pressed'),'true');
    assert.equal(f.w.__assetCalls.length,1);
    assert.equal(f.w.__assetCalls[0].points,2);
    assert.equal(f.w.__assetCalls[0].unit,'day');
    assert.match(host.textContent,/每根 K 线对应一个观测日/);
    assert.equal(host.querySelector('[data-asset-unit="day"]').getAttribute('aria-pressed'),'true');
    host.querySelector('[data-asset-unit="month"]').click();
    assert.equal(f.w.__assetCalls.at(-1).unit,'month');
    assert.equal(host.querySelector('[data-asset-unit="month"]').getAttribute('aria-pressed'),'true');
    assert.match(host.textContent,/每根 K 线按「月」聚合/);
    host.querySelector('[data-asset-mode="line"]').click();
    assert.equal(host.querySelector('[data-asset-mode="line"]').getAttribute('aria-pressed'),'true');
    assert.equal(f.w.__assetMode,'line');
    assert.match(host.textContent,/折线为逐日观测值/);
    // A later reload must not drag the asset chart back to the candle mode that
    // the billing chart happens to be in.
    f.controller.render();
    assert.equal(f.w.__assetMode,'line');
    assert.equal(host.querySelector('[data-asset-mode="line"]').getAttribute('aria-pressed'),'true');
  }finally{f.dom.window.close();}
});
