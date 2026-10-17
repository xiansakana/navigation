import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readCodexCatalog,readCodexStatus,validateRuntime,resolveRuntime,writeCodexDefaults} from './codex-control.js';
import {withCodexClient} from './codex-client.js';

const models=[{id:'model-a',name:'A',efforts:['low','high'],defaultEffort:'low',isDefault:true,inputModalities:['text','image']},{id:'model-b',name:'B',efforts:['medium','max'],defaultEffort:'medium',isDefault:false,inputModalities:['text']}];
const catalog={models,defaults:{model:'model-a',effort:'high'},version:'v1'};
const configResponse={config:{model:'model-a',model_reasoning_effort:'high',mcp_servers:{secret:{env:{TOKEN:'NEVER_EXPOSE'}}}},layers:[{name:{type:'user',file:'/private/config.toml'},version:'v1'}]};

test('model catalog paginates and redacts provider, file paths, auth, and hidden models',async()=>{
  const seen=[];
  const client=async(c,work)=>work({call:async(method,params)=>{
    seen.push({method,params});if(method==='config/read')return configResponse;
    return params.cursor?{data:[{model:'model-b',displayName:'B',supportedReasoningEfforts:[{reasoningEffort:'medium'}],defaultReasoningEffort:'medium'}]}:{data:[{model:'model-a',supportedReasoningEfforts:[{reasoningEffort:'high'}],defaultReasoningEffort:'high',isDefault:true},{model:'hidden',hidden:true}],nextCursor:'page2'};
  }});
  const result=await readCodexCatalog({}, {client});
  assert.deepEqual(result.models.map(m=>m.id),['model-a','model-b']);assert.equal(result.version,'v1');
  assert.equal(seen[2].params.cursor,'page2');assert.doesNotMatch(JSON.stringify(result),/NEVER_EXPOSE|private|mcp_servers/);
  assert.deepEqual(result.models[1].inputModalities,['text','image']);
});

test('runtime resolution enforces model-specific effort support, defaults and QQ precedence',()=>{
  assert.deepEqual(resolveRuntime({}, {model:'',effort:''},catalog),{model:'model-a',effort:'high'});
  assert.deepEqual(resolveRuntime({}, {model:'model-b',effort:''},catalog),{model:'model-b',effort:'medium'});
  assert.deepEqual(resolveRuntime({model:'model-b'}, {model:'',effort:'max'},catalog),{model:'model-b',effort:'max'});
  assert.throws(()=>validateRuntime({model:'model-b',effort:'high'},catalog,{partial:true}),/不支持/);
  assert.throws(()=>validateRuntime({model:'--evil',effort:'high'},catalog),/可用模型/);
  assert.throws(()=>validateRuntime({model:'model-a',effort:'high',binary:'evil'},catalog),/只允许/);
  assert.throws(()=>resolveRuntime({}, {model:'gone',effort:''},catalog),/已不可用/);
});

test('server writes use atomic allowlisted edits and optimistic version, never arbitrary file paths',async()=>{
  let writes=0;
  const result=await writeCodexDefaults({}, {model:'model-b',effort:'max',version:'v1'}, {catalog,client:async(c,work)=>work({call:async(method,params)=>{
    writes++;assert.equal(method,'config/batchWrite');assert.equal(params.expectedVersion,'v1');assert.equal(params.filePath,undefined);
    assert.deepEqual(params.edits,[{keyPath:'model',value:'model-b',mergeStrategy:'replace'},{keyPath:'model_reasoning_effort',value:'max',mergeStrategy:'replace'}]);return {version:'v2'};
  }})});
  assert.equal(writes,1);assert.equal(result.version,'v2');
  await assert.rejects(writeCodexDefaults({}, {model:'model-a',effort:'high',version:'stale'}, {catalog}),/已变化/);
  await assert.rejects(writeCodexDefaults({}, {model:'model-a',effort:'high',version:'v1',filePath:'/etc/passwd'}, {catalog}),/版本无效/);
});

test('status exposes account type and plan, without account email, tokens or IDs',async()=>{
  const client=async(c,work)=>work({call:async(method)=>{
    if(method==='config/read')return configResponse;
    if(method==='account/read')return {account:{type:'chatgpt',planType:'plus',email:'PRIVATE_EMAIL',accessToken:'PRIVATE_TOKEN',accountId:'PRIVATE_ID'}};
    return {data:[{model:'model-a',supportedReasoningEfforts:[{reasoningEffort:'high'}],defaultReasoningEffort:'high'}]};
  }});
  const result=await readCodexStatus({binary:'nonexistent-test-codex'}, {client});
  assert.deepEqual(result.account,{loggedIn:true,type:'chatgpt',planType:'plus'});assert.doesNotMatch(JSON.stringify(result),/PRIVATE_|NEVER_EXPOSE|private/);
});

test('private RPC client completes handshake, sequential calls, error redaction and timeout cleanup',async()=>{
  let child;
  const spawnProcess=(binary,args,options)=>{
    assert.equal(binary,'configured-codex');assert.deepEqual(args,['app-server']);assert.equal(options.env.HTTPS_PROXY,'http://proxy');
    return child=spawn(process.execPath,['--input-type=module','-e',`import readline from 'node:readline';let ready=false;readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialized'){ready=true;return;}if(m.method!=='initialize'&&!ready)process.exit(2);process.stdout.write(JSON.stringify(m.method==='failure'?{id:m.id,error:{code:-1,message:'SECRET_TOKEN'}}:{id:m.id,result:{method:m.method}})+'\\n');});`],options);
  };
  const config={binary:'configured-codex',proxyUrl:'http://proxy'};
  await withCodexClient(config,async({call})=>{assert.equal((await call('config/read')).method,'config/read');assert.equal((await call('model/list')).method,'model/list');await assert.rejects(call('failure'),e=>{assert.doesNotMatch(e.message,/SECRET_TOKEN/);return true;});},{spawnProcess});
  assert.equal(child.killed,true);
  await assert.rejects(withCodexClient({},({call})=>call('hang'),{timeout:50,spawnProcess:(b,a,o)=>child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],o)}),/超时/);
  assert.equal(child.killed,true);
});
