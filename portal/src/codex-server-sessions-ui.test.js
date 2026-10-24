import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
const read=n=>fs.readFileSync(new URL('../public/codex-cli/'+n,import.meta.url),'utf8');
async function until(check){for(let i=0;i<100;i++){if(check())return;await new Promise(r=>setTimeout(r,5));}assert.ok(check());}
test('workbench labels module histories, disables mutation and keeps paginated native messages on refresh',async()=>{
  const dom=new JSDOM(read('index.html'),{runScripts:'outside-only',pretendToBeVisual:true,url:'https://qa.invalid/codex-cli/'}),w=dom.window,d=w.document,$=id=>d.getElementById(id);
  const kb={id:'knowledge-doc',title:'Lesson',project:'知识库',source:'knowledge',readOnly:true,archived:false},cli={id:'cli-thread',title:'Terminal',project:'project',source:'cli',readOnly:true,archived:false};
  let mutations=0;
  const job=(id,time)=>({id,prompt:'Question '+id,result:'Answer '+id,state:'succeeded',progress:[],runtime:{},created_at:time});
  w.setInterval=()=>0;
  w.fetch=async(raw,options={})=>{
    if(options.method&&options.method!=='GET')mutations++;
    const url=new URL(raw,w.location.href),id=url.pathname.split('/').pop();let data;
    if(id==='conversations')data={conversations:url.searchParams.has('cursor')?[{...cli,id:'cli-older',title:'Older'}]:[kb,cli],projects:[],enabled:true,nextCursor:url.searchParams.has('cursor')?null:'page2',permissions:{create:false,send:true,manage:true,stop:true,serverHistory:true}};
    else data={conversation:id.startsWith('knowledge')?kb:cli,jobs:[job(url.searchParams.has('cursor')?'older':'newer',url.searchParams.has('cursor')?1:2)],nextCursor:id.startsWith('knowledge')||url.searchParams.has('cursor')?null:'older'};
    return {ok:true,json:async()=>({ok:true,...data})};
  };
  try{
    w.eval(read('chat.js'));await until(()=>$('chat-title').textContent==='Lesson');
    const counts=()=>[...$('session-source').options].map(o=>o.textContent);
    assert.deepEqual(counts(),['全部来源（2+）','网页（0）','QQ（0）','知识库（1）','服务器 CLI（1+）']);
    $('session-search').value='Lesson';$('session-search').dispatchEvent(new w.Event('input'));
    assert.deepEqual(counts(),['全部来源（1+）','网页（0）','QQ（0）','知识库（1）','服务器 CLI（0+）']);
    $('session-search').value='';$('session-search').dispatchEvent(new w.Event('input'));
    d.dispatchEvent(new w.CustomEvent('codex-status',{detail:{models:[],qqDefaults:{model:'test'}}}));
    assert.equal($('send-chat').disabled,true);assert.equal($('rename-chat').hidden,true);assert.equal($('stop-chat').hidden,true);assert.match($('chat-meta').textContent,/知识库/);
    $('session-source').value='cli';$('session-source').dispatchEvent(new w.Event('change'));assert.equal($('sessions').children.length,1);
    $('sessions-more').click();await until(()=>$('sessions').children.length===2);
    assert.equal($('session-source').value,'cli');
    assert.deepEqual(counts(),['全部来源（3）','网页（0）','QQ（0）','知识库（1）','服务器 CLI（2）']);
    [...$('sessions').querySelectorAll('button')].find(b=>b.textContent.includes('Terminal')).click();await until(()=>$('chat-title').textContent==='Terminal');
    $('history-more').click();await until(()=>$('messages').textContent.includes('Answer older'));
    d.dispatchEvent(new w.Event('visibilitychange'));await new Promise(r=>setImmediate(r));await until(()=>$('messages').textContent.includes('Answer newer'));
    assert.match($('messages').textContent,/Answer older/);assert.ok($('messages').textContent.indexOf('Answer older')<$('messages').textContent.indexOf('Answer newer'));assert.equal(mutations,0);
  }finally{w.close();}
});
