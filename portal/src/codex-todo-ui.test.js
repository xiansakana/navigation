import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {JSDOM} from 'jsdom';
const read=name=>fs.readFileSync(new URL('../public/codex-cli/'+name,import.meta.url),'utf8');
const until=async check=>{for(let i=0;i<100;i++){if(check())return;await new Promise(r=>setTimeout(r,5));}assert.ok(check());};
test('Todo form saves Beijing time independently of local timezone, restores edits and clears schedule',async()=>{
  const dom=new JSDOM(read('index.html'),{runScripts:'outside-only',url:'https://qa.invalid/codex-cli/'}),w=dom.window,d=w.document,$=id=>d.getElementById(id);let saved,rows=[];
  w.setInterval=()=>0;Object.defineProperty(w.crypto,'randomUUID',{value:crypto.randomUUID});
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};
  w.fetch=async(url,options={})=>{
    if(options.body){saved=JSON.parse(options.body);rows=[{...saved,id:'test',state:'pending',jobId:'',jobState:'',runtime:{},scheduledAt:saved.scheduledAt}];}
    return {ok:true,json:async()=>({ok:true,todos:rows,projects:['navigation'],conversations:[],enabled:true,permissions:{edit:true,run:true}})};
  };
  try{
    w.eval(read('todos.js'));await until(()=>!$('todo-new').hidden);$('todo-new').click();
    $('todo-title').value='scheduled';$('todo-prompt').value='do it';$('todo-scheduled').value='2099-10-18T18:30';
    $('todo-form').dispatchEvent(new w.Event('submit',{cancelable:true}));await until(()=>!$('todo-dialog').open);
    assert.equal(saved.scheduledAt,Date.parse('2099-10-18T10:30:00Z'));assert.match($('todo-list').textContent,/2099/);
    const edit=[...$('todo-list').querySelectorAll('button')].find(b=>b.textContent==='编辑');edit.click();assert.equal($('todo-scheduled').value,'2099-10-18T18:30');
    $('todo-scheduled').value='';$('todo-form').dispatchEvent(new w.Event('submit',{cancelable:true}));await until(()=>!$('todo-dialog').open);assert.equal(saved.scheduledAt,0);
  }finally{w.close();}
});
