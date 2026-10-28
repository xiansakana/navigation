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
  w.eval(fs.readFileSync(new URL('../public/bookkeeping/analysis.js',import.meta.url),'utf8'));
  const money=(amount,currency)=>currency+' '+amount.toFixed(2);
  const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  const controller=w.createBookkeepingAnalysis({$,esc,money,m:(a,c)=>'<span data-money>'+money(a,c)+'</span>',can:()=>true,load(){},tab:name=>drills.push(name),getState:()=>state,periods:{focusDate:data=>drills.push(data),restore(){}}});
  controller.render();
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

test('asset return tab is accessible, retains selection across reloads, masks amounts and handles unavailable history',()=>{
  const f=fixture();
  try {
    assert.equal(f.$('asset-tab-returns').hidden,true);
    f.state.analysis.investmentReturns={points:[{date:'2026-10-26',currency:'CNY',profit:0},{date:'2026-10-28',currency:'CNY',profit:30,source:'current'}],note:'真实估值观测',period:{openingAsOf:'2026-10-26',closingAsOf:'2026-10-28',assetChange:100,netFlow:60,adjustments:10,profit:30,provisional:true,partial:true}};
    f.controller.render();f.$('asset-tab-returns').click();
    assert.equal(f.$('asset-tab-returns').getAttribute('aria-selected'),'true');
    assert.equal(f.$('asset-overview-charts').getAttribute('aria-labelledby'),'asset-tab-returns');
    assert.equal(f.$('asset-overview-charts').querySelectorAll('.bk-metric [data-money]').length,4);
    assert.match(f.$('asset-overview-charts').textContent,/今日暂估/);
    f.controller.render();assert.equal(f.$('asset-tab-returns').getAttribute('aria-selected'),'true');
    f.state.analysis.investmentReturns={points:[],period:null,note:'缺少可比快照'};f.controller.render();
    assert.match(f.$('asset-overview-note').textContent,/缺少可比快照/);assert.equal(f.$('asset-overview-charts').querySelector('polyline'),null);
    f.$('asset-tab-returns').dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));
    assert.equal(f.$('asset-tab-balance').getAttribute('aria-selected'),'true');
    f.state.analysis.investmentReturns=null;f.controller.render();assert.equal(f.$('asset-tab-returns').hidden,true);
  } finally {f.dom.window.close();}
});

test('historical trading curves leave missing prices as real gaps and keep zero profits visible',()=>{
  const f=fixture();
  try{
    f.state.analysis.investmentReturns={note:'snapshot',points:[],period:null,trading:{note:'historical',issues:[],missingSymbols:['AAPL'],pending:1,points:[
      {date:'2026-10-25',currency:'CNY',realized:0,unrealized:0,total:0},
      {date:'2026-10-26',currency:'CNY',realized:1,unrealized:null,total:null},
      {date:'2026-10-27',currency:'CNY',realized:2,unrealized:3,total:5},
      {date:'2026-10-28',currency:'CNY',realized:2,unrealized:null,total:null}
    ]}};
    f.controller.render();f.$('accounts-view').classList.remove('hidden');f.$('asset-tab-returns').click();
    assert.equal(f.$('asset-overview-charts').querySelector('[data-chart-series=total]').querySelectorAll('polyline').length,2);
    assert.match(f.$('asset-overview-charts').textContent,/后台正在补齐/);
    assert.doesNotMatch(f.$('asset-overview-charts').innerHTML,/NaN|Infinity/);
    assert.equal(f.controller.query().investmentHistory,'1');
    f.$('asset-tab-balance').click();assert.equal(f.controller.query().investmentHistory,undefined);
  }finally{f.dom.window.close();}
});

test('securities legends toggle independently, retain choices on data reload and never change billing or snapshot charts',()=>{
  const f=fixture();
  try{
    f.state.analysis.investmentReturns={note:'snapshot',points:[{date:'2026-10-25',currency:'CNY',profit:0},{date:'2026-10-28',currency:'CNY',profit:9}],period:null,trading:{note:'history',issues:[],points:[
      {date:'2026-10-25',currency:'CNY',realized:1000,unrealized:0,total:1000},
      {date:'2026-10-26',currency:'CNY',realized:1000,unrealized:null,total:null},
      {date:'2026-10-28',currency:'CNY',realized:1000,unrealized:30,total:1030}
    ]}};
    f.controller.render();f.$('asset-tab-returns').click();
    const host=f.$('asset-overview-charts'),button=key=>host.querySelector('[data-trading-series="'+key+'"]');
    const billing=f.$('billing-charts').innerHTML,snapshot=host.querySelector('[data-chart-series=profit]').outerHTML;
    const totals=host.querySelector('.bk-trading-history .bk-chart-legend').textContent;
    const originalAxis=[...host.querySelectorAll('[data-chart-series=unrealized] polyline')].at(-1).getAttribute('points');
    host.querySelector('.bk-trading-history details').open=true;
    button('realized').click();button('total').click();
    assert.equal(host.querySelectorAll('.bk-trading-history [data-chart-series]').length,1);
    assert.equal(button('realized').getAttribute('aria-pressed'),'false');
    assert.equal(button('unrealized').getAttribute('aria-pressed'),'true');
    assert.notEqual([...host.querySelectorAll('[data-chart-series=unrealized] polyline')].at(-1).getAttribute('points'),originalAxis);
    assert.equal(host.querySelector('.bk-trading-history details').open,true);
    assert.equal(f.w.document.activeElement,button('total'));
    button('unrealized').click();assert.match(host.querySelector('.bk-trading-history').textContent,/所有折线已隐藏/);
    assert.equal(host.querySelectorAll('.bk-trading-history polyline').length,0);
    button('total').click();assert.equal(host.querySelectorAll('.bk-trading-history [data-chart-series]').length,1);
    assert.equal(host.querySelector('[data-chart-series=total]').querySelectorAll('polyline').length,2);
    assert.equal(host.querySelector('.bk-trading-history .bk-chart-legend').textContent,totals);
    assert.equal(f.$('billing-charts').innerHTML,billing);assert.equal(host.querySelector('[data-chart-series=profit]').outerHTML,snapshot);
    f.state.analysis.investmentReturns.trading.points=[];f.controller.render();
    f.state.analysis.investmentReturns.trading.points=[{date:'2026-11-01',currency:'CNY',realized:10,unrealized:null,total:null}];f.controller.render();
    assert.equal(button('realized').getAttribute('aria-pressed'),'false');assert.equal(button('unrealized').getAttribute('aria-pressed'),'false');assert.equal(button('total').getAttribute('aria-pressed'),'true');
    assert.match(button('total').textContent,/待补齐/);assert.doesNotMatch(host.innerHTML,/NaN|Infinity/);
  }finally{f.dom.window.close();}
});
