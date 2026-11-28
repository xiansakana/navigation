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
  w.__chartCalls=[];
  // ECharts cannot render in jsdom; record the wiring instead of the pixels.
  w.createBookkeepingTrendChart=()=>({
    render:payload=>w.__chartCalls.push({
      count:payload.points.length,
      unit:payload.unit,
      mode:payload.mode,
      series:payload.series.map(item=>item.key)
    }),
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

test('legend toggles drive the shared chart payload', () => {
  const f = fixture();
  try {
    assert.equal(f.w.__chartCalls.at(-1).series.join(','), 'income,expense,cumulative');
    f.toggle('income');
    assert.equal(f.button('income').getAttribute('aria-pressed'), 'false');
    assert.equal(f.w.__chartCalls.at(-1).series.join(','), 'expense,cumulative');
    assert.equal(f.$('billing-charts').querySelector('.bk-chart-legend').textContent, f.$('billing-charts').querySelector('.bk-chart-legend').textContent.trim());
  } finally { f.dom.window.close(); }
});

test('the billing card switches mode and period through the same chart', () => {
  const f = fixture();
  try {
    const host = f.$('billing-charts');
    host.querySelector('[data-chart-mode="line"]').click();
    assert.equal(f.w.__chartCalls.at(-1).mode, 'line');
    assert.equal(host.querySelector('[data-chart-mode="line"]').getAttribute('aria-pressed'), 'true');
    host.querySelector('[data-candle-unit="month"]').click();
    assert.equal(f.w.__chartCalls.at(-1).unit, 'month');
    assert.match(host.textContent, /每根 K 线按「月」聚合|折线为逐日观测值/);
  } finally { f.dom.window.close(); }
});

test('the accounts tab renders one balance chart with mode and period controls', () => {
  const f = fixture();
  try {
    const host = f.$('asset-overview-charts');
    assert.ok(host.querySelector('.bk-chart-card'));
    assert.equal(host.querySelectorAll('[data-asset-mode]').length, 2);
    assert.equal(host.querySelectorAll('[data-asset-unit]').length, 5);
    assert.equal(host.querySelector('[data-asset-mode="candle"]').getAttribute('aria-pressed'), 'true');
    assert.equal(host.querySelector('[data-asset-unit="day"]').getAttribute('aria-pressed'), 'true');
    const assetCall = f.w.__chartCalls.filter(call => call.series.includes('balance')).at(-1);
    assert.equal(assetCall.unit, 'day');
    host.querySelector('[data-asset-unit="month"]').click();
    assert.equal(f.w.__chartCalls.filter(call => call.series.includes('balance')).at(-1).unit, 'month');
    host.querySelector('[data-asset-mode="line"]').click();
    assert.equal(f.w.__chartCalls.filter(call => call.series.includes('balance')).at(-1).mode, 'line');
  } finally { f.dom.window.close(); }
});

test('no-data and missing-FX states keep their messages', () => {
  const f = fixture();
  try {
    f.state.analysis.billing.points = [];
    f.controller.render();
    assert.match(f.$('billing-charts').textContent, /暂无记录/);
    f.state.analysis.billing.missingCurrencies = ['USD'];
    f.controller.render();
    assert.match(f.$('billing-charts').textContent, /缺少 USD 汇率/);
    assert.doesNotMatch(f.$('asset-overview-charts').innerHTML, /NaN|Infinity/);
  } finally { f.dom.window.close(); }
});
