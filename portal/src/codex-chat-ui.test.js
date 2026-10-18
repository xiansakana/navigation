import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { JSDOM } from 'jsdom';

const read=name=>fs.readFileSync(new URL('../public/'+name,import.meta.url),'utf8');
async function until(check){for(let i=0;i<100;i++){if(check())return;await new Promise(r=>setTimeout(r,5));}assert.ok(check(),'UI did not reach expected state');}
test('chat UI creates, sends, resumes, stops, renames and archives with safe markdown and scoped controls',async()=>{
  const dom=new JSDOM(read('codex-cli/index.html'),{runScripts:'outside-only',pretendToBeVisual:true,url:'https://qa.invalid/codex-cli/'}),w=dom.window,d=w.document,$=id=>d.getElementById(id);
  const c={id:'owned',title:'历史会话',project:'navigation',source:'qq',archived:false},conversations=[c];let records=[],counter=0,lastSent,failSend=false;
  const calls=[];
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};
  w.setInterval=()=>0;Object.defineProperty(w.crypto,'randomUUID',{value:crypto.randomUUID});
  w.fetch=async(url,options={})=>{
    const method=options.method || 'GET',path=url.replace('/api/codex-cli/conversations','').split('?')[0],body=options.body?JSON.parse(options.body):undefined;calls.push({path,method,body});
    if(!path&&method==='POST'){const value={...c,id:'new-'+(++counter),title:'新会话',source:'web'};conversations.push(value);return response({conversation:value});}
    if(!path)return response({conversations,projects:['navigation'],enabled:true,permissions:{create:true,send:true,manage:true,stop:true}});
    const conversation=conversations.find(item=>item.id===path.split('/')[1]);
    if(path.endsWith('/messages')){lastSent=body;if(failSend){failSend=false;throw new Error('network lost');}records.push({id:'job',prompt:body.prompt,state:'running',result:'',progress:[{kind:'activity',text:'执行命令 · 进行中'}],runtime:{model:body.model,effort:body.effort},created_at:Date.now()});return response({jobId:'job'});}
    if(path.endsWith('/stop')){records.at(-1).state='cancelled';records.at(-1).result='已停止';return response({count:1});}
    if(method==='PATCH'){Object.assign(conversation,body);return response({conversation});}
    return response({conversation,jobs:records});
  };
  function response(value){return {ok:true,status:200,json:async()=>({ok:true,...structuredClone(value)})};}
  try {
    w.eval(read('vendor/marked.js'));w.eval(read('vendor/purify.js'));w.eval(read('codex-cli/chat.js'));
    d.dispatchEvent(new w.CustomEvent('codex-status',{detail:{models:[{id:'test',efforts:['low','high']}],qqDefaults:{model:'test'}}}));
    await until(()=>$('chat-title').textContent==='历史会话');assert.equal($('chat-prompt').disabled,false);
    $('new-chat').click();assert.equal($('new-dialog').open,true);$('new-form').dispatchEvent(new w.Event('submit',{cancelable:true}));await until(()=>$('chat-title').textContent==='新会话');
    $('chat-model').value='test';$('chat-model').dispatchEvent(new w.Event('change'));$('chat-effort').value='high';
    $('chat-prompt').value='任务一';failSend=true;$('chat-form').dispatchEvent(new w.Event('submit',{cancelable:true}));await until(()=>$('chat-notice').textContent.includes('network lost'));const failedId=lastSent.requestId;
    $('chat-form').dispatchEvent(new w.Event('submit',{cancelable:true}));await until(()=>$('task-state').textContent==='执行中');assert.equal(lastSent.requestId,failedId);assert.equal(lastSent.effort,'high');
    assert.equal($('send-chat').disabled,true);assert.equal($('stop-chat').hidden,false);assert.match($('messages').textContent,/执行命令/);
    $('stop-chat').click();await until(()=>$('messages').textContent.includes('已停止'));await until(()=>!$('chat-prompt').disabled);
    records.at(-1).result='**正常内容** <img src=x onerror=alert(1)><script>alert(1)</script> [bad](javascript:alert(1))';
    d.dispatchEvent(new w.Event('visibilitychange'));await until(()=>$('messages').textContent.includes('正常内容'));assert.equal($('messages').querySelectorAll('img,script,[onerror],a[href^="javascript:"]').length,0);
    $('rename-chat').click();$('new-title').value='我的工作';$('rename-form').dispatchEvent(new w.Event('submit',{cancelable:true}));await until(()=>$('chat-title').textContent==='我的工作');
    $('archive-chat').click();await until(()=>$('archive-chat').textContent==='恢复会话');assert.equal($('send-chat').disabled,true);
    $('show-archived').checked=true;$('show-archived').dispatchEvent(new w.Event('change'));assert.match($('sessions').textContent,/我的工作/);
    $('archive-chat').click();await until(()=>$('archive-chat').textContent==='归档');
    $('settings-tab').click();assert.equal($('settings-view').hidden,false);$('workspace-tab').click();assert.equal($('workspace').hidden,false);
    assert.ok($('workspace').hasAttribute('data-layout-container'));assert.ok(calls.some(call=>call.path==='/new-1/messages'));
  } finally {w.close();}
});
