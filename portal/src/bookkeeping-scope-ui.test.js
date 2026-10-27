import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { analyticsScope, SOCIAL_ACCOUNT_GROUP } from './bookkeeping-scope.js';

test('unified scope is off by default and individual selections survive tab changes and rehydration',async()=>{
  const dom=new JSDOM(fs.readFileSync(new URL('../public/bookkeeping/index.html',import.meta.url),'utf8'),{runScripts:'outside-only'}),w=dom.window,$=id=>w.document.getElementById(id);
  const accounts=[{id:'p',name:'公积金',group:SOCIAL_ACCOUNT_GROUP},{id:'m',name:'医保',group:SOCIAL_ACCOUNT_GROUP},{id:'c',name:'现金',group:'资金账户'}],writes=[];
  let preferences={},controller;
  const settle=async()=>{const deadline=performance.now()+2000;while($('analysis-scope').getAttribute('aria-busy')==='true'){if(performance.now()>deadline)throw new Error('Scope save timed out');await new Promise(r=>setTimeout(r,5));}};
  const change=input=>input.dispatchEvent(new w.Event('change',{bubbles:true}));
  try {
    w.eval(fs.readFileSync(new URL('../public/bookkeeping/scope.js',import.meta.url),'utf8'));
    controller=w.createBookkeepingScope({$,esc:String,can:()=>true,write:async(route,value,method)=>{assert.equal(route,'/analysis-scope');assert.equal(method,'PUT');writes.push(value);preferences=value;},load:async()=>controller.render(analyticsScope(accounts,preferences)),capturePosition:()=>null});
    controller.render(analyticsScope(accounts));controller.setTab('stats');
    assert.equal($('exclude-social-accounts').checked,false);assert.equal($('analysis-scope').classList.contains('hidden'),false);
    assert.equal($('analysis-scope').querySelectorAll('[data-scope-account]:disabled').length,2);
    $('exclude-social-accounts').checked=true;change($('exclude-social-accounts'));await settle();
    assert.equal(writes[0].accountIds,null);assert.equal($('exclude-social-accounts').checked,true);
    $('analysis-scope').querySelector('details').open=true;
    const p=$('analysis-scope').querySelector('[data-scope-account="p"]');p.checked=false;change(p);await settle();
    assert.deepEqual([...writes.at(-1).accountIds],['m']);assert.equal($('analysis-scope').querySelector('details').open,true);
    controller.setTab('accounts');controller.render(analyticsScope(accounts,preferences));
    assert.equal($('analysis-scope').querySelector('[data-scope-account="p"]').checked,false);
    assert.equal($('analysis-scope').querySelector('[data-scope-account="m"]').checked,true);
    controller.setTab('entries');assert.equal($('analysis-scope').classList.contains('hidden'),true);
    controller.setTab('accounts');$('exclude-social-accounts').checked=false;change($('exclude-social-accounts'));await settle();
    assert.equal(preferences.enabled,false);assert.deepEqual([...preferences.accountIds],['m']);
  } finally {w.close();}
});
