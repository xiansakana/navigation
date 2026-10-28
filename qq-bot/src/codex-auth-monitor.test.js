import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createCodexAuthMonitor} from './codex-auth-monitor.js';
const Database=createRequire(new URL('../../portal/package.json',import.meta.url))('better-sqlite3');
test('auth email survives restart, suppresses duplicates, recovers and retries failed delivery without leaking diagnostics',async()=>{
  const db=new Database(':memory:');db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT)');
  let time=1e12,auth=false,network=false,fail=false,sent=0,reads=0;const errors=[];
  const config={codex:{enabled:true},channels:{email:{enabled:true,to:'owner@example.test',smtp:{host:'smtp.test'}}}};
  const make=()=>createCodexAuthMonitor({db,getConfig:()=>config,now:()=>time,log:{error:m=>errors.push(m)},
    readUsage:async()=>{reads++;if(network)throw new Error('SECRET');if(!auth)throw Object.assign(new Error('SECRET'),{code:'CODEX_AUTH_REQUIRED'});return {};},
    send:async(channel,message,options)=>{assert.equal(channel.to,'owner@example.test');assert.match(options.subject,/登录失效/);assert.doesNotMatch(message,/SECRET/);if(fail)throw new Error('SMTP SECRET');sent++;}});
  try{
    await make().tick();assert.equal(sent,1);await make().tick();assert.equal(reads,1);
    time+=300000;await make().tick();assert.equal(sent,1);
    auth=true;time+=300000;await make().tick();auth=false;fail=true;time+=300000;await make().tick();assert.equal(sent,1);
    fail=false;time+=300000;await make().tick();assert.equal(sent,2);
    auth=true;time+=300000;await make().tick();auth=false;network=true;time+=300000;await make().tick();assert.equal(sent,2);
    network=false;config.channels.email.enabled=false;time+=300000;await make().tick();assert.equal(sent,2);
    config.channels.email.enabled=true;time+=300000;await make().tick();assert.equal(sent,3);assert.doesNotMatch(errors.join(' '),/SECRET/);
  }finally{db.close();}
});
