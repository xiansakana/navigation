import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

function setup() {
  const dom=new JSDOM('<input><span></span><button></button>',{runScripts:'outside-only'}),w=dom.window;let ok,fail,requests=0,active=true;
  Object.defineProperty(w,'isSecureContext',{value:true,configurable:true});
  Object.defineProperty(w.navigator,'geolocation',{value:{getCurrentPosition:(success,error)=>{requests++;ok=success;fail=error;}}});
  w.AbortSignal=AbortSignal;w.fetch=async()=>({ok:true,json:async()=>({ok:true,label:'上海测试地址'})});
  w.eval(fs.readFileSync(new URL('../public/bookkeeping/location.js',import.meta.url),'utf8'));
  const input=w.document.querySelector('input'),status=w.document.querySelector('span'),retry=w.document.querySelector('button');
  const widget=w.createBookkeepingLocation({input,status,retry,active:()=>active,enabled:true});
  return {dom,w,input,status,widget,ok:async()=>ok({coords:{latitude:31.2,longitude:121.5}}),fail:()=>fail({code:1}),requests:()=>requests,close:()=>{active=false;widget.cancel();dom.window.close();}};
}
test('new bill geolocation fills resolved address, and manual edits are never overwritten',async()=>{
  const t=setup();try{t.widget.start();assert.equal(t.requests(),1);await t.ok();await t.widget.wait();assert.equal(t.input.value,'上海测试地址');
    t.widget.start();t.input.value='手填地址';t.input.dispatchEvent(new t.w.Event('input'));await t.ok();await t.widget.wait();assert.equal(t.input.value,'手填地址');
  }finally{t.close();}
});
test('permission denial and HTTP explain failure without blocking bill save',async()=>{
  const t=setup();try{t.widget.start();t.fail();await t.widget.wait();assert.equal(t.input.value,'');assert.match(t.status.textContent,/未授权/);
    Object.defineProperty(t.w,'isSecureContext',{value:false});await t.widget.start();assert.match(t.status.textContent,/HTTPS/);assert.equal(t.requests(),1);
  }finally{t.close();}
});
test('late location response after closing cannot alter bill; address failure retains coordinates',async()=>{
  const t=setup();try{t.widget.start();t.widget.cancel();await t.ok();await t.widget.wait();assert.equal(t.input.value,'');
    t.w.fetch=async()=>{throw new Error('offline');};t.widget.start();await t.ok();await t.widget.wait();assert.match(t.input.value,/纬度 31\.200000/);
  }finally{t.close();}
});
test('unanswered browser permission has a bounded wait and ignores success after timeout',async()=>{
  const t=setup();let timeout;try{
    t.w.setTimeout=fn=>{timeout=fn;return 1;};t.w.clearTimeout=()=>{};
    t.widget.start();timeout();await t.widget.wait();assert.match(t.status.textContent,/超时/);
    await t.ok();assert.equal(t.input.value,'');
  }finally{t.close();}
});
