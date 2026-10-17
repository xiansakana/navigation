import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { summarize } from './bookkeeping-store.js';
import { analyzeBookkeeping } from './bookkeeping-analysis.js';

async function fixture(extra={},permissions=['*']) {
  const html=fs.readFileSync(new URL('../public/bookkeeping/index.html',import.meta.url),'utf8');
  const dom=new JSDOM(html,{url:'http://localhost/bookkeeping/',runScripts:'outside-only'}),w=dom.window;
  const $=id=>w.document.getElementById(id),writes=[];
  let entry={id:'a'.repeat(32),date:'2026-10-17T12:00:00',type:'支出',amount:10,currency:'CNY',category:'餐饮',subcategory:'',accountId:'cash',toAccountId:null,toAmount:null,
    accountName:'现金',note:'<img src=x onerror=alert(1)>',tags:'午餐',location:'天津',book:'个人账本',fee:1.23,refund:0,discount:2,historical:false,cnyAmount:10,cnyFee:1.23,historicalRate:1,rateDate:'2026-10-17',...extra};
  const accounts=[{id:'cash',name:'现金',currency:'CNY',balance:100,included:true,group:'资金账户'}, {id:'usd',name:'美元卡',currency:'USD',balance:7,included:true,group:'资金账户'}];
  const state=()=>{
    const entries=entry?[entry]:[],settings={budgets:{},rates:{CNY:1,USD:7}},analysis=analyzeBookkeeping(entries,entries,accounts,settings,{},'2026-10-17');
    return {ok:true,entries,accounts,summary:summarize(entries),equivalentSummary:analysis.equivalentSummary,analysis,settings,fx:{rates:settings.rates,quotes:{}},books:['个人账本'],categories:['餐饮'],categoryTree:[{id:'cat',name:'餐饮',kind:'expense',parentId:null,icon:'◈',count:1}],accountGroups:[{id:'group',name:'资金账户',count:2}],count:entries.length};
  };
  w.HTMLElement.prototype.scrollIntoView=function(){};
  w.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
  w.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');this.dispatchEvent(new w.Event('close'));};
  w.initQqBookkeeping=()=>{};
  w.createBookkeepingLocation=()=>({cancel(){},wait:async()=>{},start:async()=>{}});
  w.confirm=()=>true;
  w.fetch=async(url,options={})=>{
    let data;
    if(url==='/api/me')data={ok:true,username:'test',userId:'test',permissions};
    else if(url.includes('/preferences'))data={ok:true,period:null};
    else if(url.includes('/state'))data=state();
    else if(url.endsWith('/fx'))data={ok:true,fx:state().fx};
    else if(url.includes('/entries/')) {
      if(options.method==='PUT') {
        const payload=JSON.parse(options.body);writes.push(payload);
        entry={...entry,...payload};for(const key of ['amount','fee','refund','discount','toAmount'])if(entry[key]!=null)entry[key]=Number(entry[key]);
        entry.cnyAmount=entry.amount;data={ok:true,id:entry.id};
      } else if(options.method==='DELETE'){entry=null;data={ok:true};}
      else data={ok:true,entry};
    } else throw new Error('Unexpected request '+url);
    return {ok:true,json:async()=>JSON.parse(JSON.stringify(data))};
  };
  for(const name of ['periods','analysis','management','details','app'])w.eval(fs.readFileSync(new URL('../public/bookkeeping/'+name+'.js',import.meta.url),'utf8'));
  const wait=async condition=>{for(let i=0;i<50;i++){if(condition())return;await new Promise(resolve=>setImmediate(resolve));}throw new Error('UI did not settle');};
  await wait(()=>$('entry-list').querySelector('[data-entry]'));
  $('entry-list').querySelector('[data-entry]').click();
  const edit=key=>$('entry-detail-view').querySelector('[data-detail-field="'+key+'"]:not(.btn)').click();
  const submit=async()=>{$('editor-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await wait(()=>!$('editor').open);};
  return {dom,w,$,writes,edit,submit,wait};
}

test('entry click opens details; amount popup is compact and preserves every other financial field',async()=>{
  const f=await fixture();
  try {
    assert.equal(f.$('entry-detail-view').classList.contains('hidden'),false);
    assert.equal(f.$('editor').open,false);
    assert.equal(f.$('entry-detail-view').querySelector('img'),null);
    assert.match(f.$('entry-detail-view').textContent,/<img src=x/);
    f.edit('amount');
    assert.equal(f.w.document.activeElement.name,'amount');
    const visible=[...f.$('editor-fields').querySelectorAll(':scope > label')].filter(e=>!e.classList.contains('hidden'));
    assert.equal(visible.length,1);assert.equal(visible[0].querySelector('[name]').name,'amount');
    f.$('editor-form').elements.amount.value='12.34';await f.submit();
    const payload=f.writes[0];
    assert.equal(payload.amount,'12.34');assert.equal(payload.fee,'1.23');assert.equal(payload.discount,'2');
    assert.equal(payload.category,'餐饮');assert.equal(payload.location,'天津');assert.equal(payload.tags,'午餐');
    assert.match(f.$('entry-detail-view').textContent,/12\.34/);
    assert.equal(f.$('entry-detail-view').classList.contains('hidden'),false);
  } finally {f.dom.window.close();}
});

test('compact transfer editor preserves actual foreign receipt and both owned accounts',async()=>{
  const f=await fixture({type:'转账',category:'转账',toAccountId:'usd',toAccountName:'美元卡',toAmount:7});
  try {
    f.edit('fee');f.$('editor-form').elements.fee.value='2.50';await f.submit();
    assert.equal(f.writes[0].toAmount,'7');assert.equal(f.writes[0].amount,'10');
    assert.equal(f.writes[0].accountId,'cash');assert.equal(f.writes[0].toAccountId,'usd');
  } finally {f.dom.window.close();}
});

test('read-only entry details provide no edit or delete action',async()=>{
  const f=await fixture({},['bookkeeping:view','bookkeeping:accounts:view','bookkeeping:analysis:view']);
  try {
    assert.equal(f.$('entry-detail-view').querySelector('[data-detail-action="delete"]'),null);
    assert.ok([...f.$('entry-detail-view').querySelectorAll('[data-detail-field]')].every(e=>e.disabled));
    f.edit('amount');assert.equal(f.$('editor').open,false);
  } finally {f.dom.window.close();}
});
