import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
const settings=()=>({qq:{enabled:true},slack:{enabled:false},targets:[{type:'group',groupId:'123456',userId:'',atUserId:''}]});
for (const kind of ['salary','training','stock']) test('notification management company ' + kind + ' card saves targets and tests saved configuration through Portal', async () => {
  const dom = new JSDOM('<div id="shopping-notifications" hidden></div><button id="business-refresh"></button>', { runScripts: 'outside-only', url: 'https://test/notifications/' });
  dom.window.document.body.innerHTML = ['salary','training','stock'].map(k => '<div id="company-'+k+'-notifications" hidden></div>').join('') + '<button id="business-refresh"></button>';
  const w = dom.window, host = w.document.getElementById('company-'+kind+'-notifications'), calls = [];
  const until = async check => { for (let i = 0; i < 50 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(check()); };
  let writable = true;
  w.toast = () => {};
  w.fetch = async (url, options) => {
    calls.push({ url, ...options }); return { ok: true, json: async () => ({ ok: true, settings: options.body ? JSON.parse(options.body) : settings(), permissions: { save: writable, test: writable } }) };
  };
  try {
    w.eval(fs.readFileSync(new URL('../../qq-bot/public/qq-targets.js', import.meta.url), 'utf8'));
    w.eval(fs.readFileSync(new URL('../../qq-bot/public/company-alerts-notifications.js', import.meta.url), 'utf8'));
    await until(() => !host.hidden);
    host.querySelector('[data-action="add-target"]').click(); assert.equal(host.querySelectorAll('.biz-target').length, 2);
    host.querySelectorAll('[data-action="remove-target"]')[1].click();
    host.querySelector('[data-field="groupId"]').value = '987654';
    host.querySelector('[data-action="company-'+kind+'-save"]').click(); await until(() => calls.some(row => row.method === 'PUT' && row.url.includes('/'+kind+'/notifications')));
    assert.equal(JSON.parse(calls.find(row => row.method === 'PUT' && row.url.includes('/'+kind+'/notifications')).body).targets[0].groupId, '987654');
    await until(() => !host.querySelector('[data-action="company-'+kind+'-save"]').disabled);
    host.querySelector('[data-action="company-'+kind+'-test"]').click(); await until(() => calls.some(row => row.method === 'POST'));
    assert.equal(calls.find(row => row.method === 'POST').body, undefined);
    writable = false; w.document.getElementById('business-refresh').click(); await until(() => host.querySelector('input').disabled);
    assert.equal(host.querySelector('[data-action="company-'+kind+'-test"]').disabled, true);
  } finally { w.close(); }
});

for(const kind of ['salary','training','stock']) test('company '+kind+' lists every account, saves independent drafts and tests the chosen account',async()=>{
 const dom=new JSDOM(['salary','training','stock'].map(k=>'<div id="company-'+k+'-notifications"></div>').join('')+'<button id="business-refresh"></button>',{runScripts:'outside-only',url:'https://test/notifications/'}),w=dom.window,calls=[];
 const config=()=>({ok:true,settings:settings(),watchers:[{id:'a',label:'Director A',settings:settings()},{id:'b',label:'Director B',settings:{...settings(),targets:[{type:'private',userId:'654321',groupId:'',atUserId:''}]}}],permissions:{save:true,test:true}});
 w.toast=()=>{};w.fetch=async(url,options)=>{calls.push({url,...options});return{ok:true,json:async()=>config()};};
 const until=async f=>{const end=Date.now()+1000;while(!f()&&Date.now()<end)await new Promise(r=>setTimeout(r,5));assert.ok(f());};
 try{
  w.eval(fs.readFileSync(new URL('../../qq-bot/public/qq-targets.js',import.meta.url),'utf8'));w.eval(fs.readFileSync(new URL('../../qq-bot/public/company-alerts-notifications.js',import.meta.url),'utf8'));
  const h=w.document.getElementById('company-'+kind+'-notifications');await until(()=>h.querySelectorAll('[data-account-index]').length===2);
  assert.equal(h.querySelector('[data-account]'),null);
  h.querySelector('[data-account-index="0"] [data-field="groupId"]').value='999999';
  h.querySelector('[data-account-index="1"] [data-field="userId"]').value='888888';
  h.querySelector('[data-account-index="1"] [data-action="add-target"]').click();
  assert.equal(h.querySelector('[data-account-index="0"] [data-field="groupId"]').value,'999999');
  h.querySelectorAll('[data-account-index="1"] [data-action="remove-target"]')[1].click();
  h.querySelector('[data-action="company-'+kind+'-save"]').click();
  await until(()=>calls.filter(c=>c.method==='PUT').length===2);
  const bodies=calls.filter(c=>c.method==='PUT').map(c=>JSON.parse(c.body));
  assert.equal(bodies[0].watcherId,'a');assert.equal(bodies[0].settings.targets[0].groupId,'999999');assert.equal(bodies[1].watcherId,'b');assert.equal(bodies[1].settings.targets[0].userId,'888888');
  await until(()=>!h.querySelector('[data-action="company-'+kind+'-save"]').disabled);
  h.querySelector('[data-account-index="1"] [data-action="company-'+kind+'-test"]').click();await until(()=>calls.some(c=>c.method==='POST'));
  assert.equal(JSON.parse(calls.find(c=>c.method==='POST').body).watcherId,'b');
 }finally{w.close();}
});
