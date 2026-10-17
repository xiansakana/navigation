import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {createCodexStore} from '../../qq-bot/src/codex-store.js';
import {handleCodexCliApi,canCodexCli} from './codex-cli.js';
import {resolveRoute,canonicalPortalPagePath} from './router.js';
import {buildMenusFromServices,getVisibleMenus,SYSTEM_PERMISSIONS} from './rbac.js';

const Database=createRequire(import.meta.url)('better-sqlite3');
const permissions=['codex-cli:view','codex-cli:usage:view','codex-cli:settings:edit','codex-cli:runtime:edit','qq-codex:execute'];
const catalog={models:[{id:'model-a',name:'A',efforts:['low','high'],defaultEffort:'low',isDefault:true,inputModalities:['text','image']},{id:'model-b',name:'B',efforts:['medium','max'],defaultEffort:'medium',inputModalities:['text']}],defaults:{model:'model-a',effort:'high'},version:'v1',safety:{sandbox:'workspace-write',approval:'never'}};

test('Codex management APIs enforce read/write permissions, CSRF, own scopes and secret redaction',async()=>{
 const db=new Database(':memory:'),store=createCodexStore(db);let writes=0;
 store.saveSettings('owner',{groups:['33333333'],groupReply:'private'});
 const dependencies={store,setup:uid=>({config:{},configured:uid==='owner',enabled:true,projects:['navigation']}),catalog:async()=>catalog,
   status:async()=>({...catalog,cliVersion:'test-cli',account:{type:'chatgpt',planType:'plus',loggedIn:true},qqOverrides:{model:'',effort:'',sandbox:'workspace-write',approval:'never'}}),
   usage:async()=>({accountId:'SECRET_ACCOUNT_ID',rateLimits:{primary:{usedPercent:25,windowDurationMins:300,resetsAt:1792254024}}}),
   write:async(config,body)=>{writes++;return body;}};
 const server=http.createServer((req,res)=>{
  const session=JSON.parse(req.headers['x-test-session']||JSON.stringify({userId:'owner',permissions}));
  void handleCodexCliApi(req,res,new URL(req.url,'http://localhost'),session,(r,status,data)=>{r.writeHead(status,{'Content-Type':'application/json'});r.end(JSON.stringify(data));},dependencies);
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const request=async(route='status',{session,method='GET',body,origin}={})=>{const r=await fetch('http://127.0.0.1:'+server.address().port+'/api/codex-cli/'+route,{method,headers:{...(session?{'X-Test-Session':JSON.stringify(session)}:{}),...(origin?{Origin:origin}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json(),cache:r.headers.get('cache-control')};};
 try{
  for(const session of [{},{userId:'owner',permissions:[]},{userId:'owner',isGuest:true,permissions:['*']}])assert.equal((await request('status',{session})).status,403);
  const readOnly={userId:'owner',permissions:['codex-cli:view','qq-codex:execute']};
  const read=await request('status',{session:readOnly});assert.equal(read.status,200);assert.equal(read.body.permissions.editServer,false);assert.equal(read.cache,'no-store');
  assert.equal((await request('usage',{session:readOnly})).status,403);
  assert.doesNotMatch(JSON.stringify((await request('usage')).body),/SECRET_ACCOUNT_ID/);
  for(const route of ['settings','runtime'])assert.equal((await request(route,{session:readOnly,method:'PUT',body:{}})).status,403);
  assert.equal((await request('settings',{method:'PUT',origin:'https://evil.test',body:{}})).status,403);assert.equal(writes,0);
  assert.equal((await request('settings',{method:'PUT',body:{model:'model-a',effort:'high',version:'v1'}})).status,200);assert.equal(writes,1);
  assert.equal((await request('runtime',{method:'PUT',body:{groupId:'33333333',model:'model-b',effort:'max'}})).status,200);
  assert.deepEqual(store.runtime('owner','33333333'),{model:'model-b',effort:'max'});assert.deepEqual(store.runtime('owner'),{model:'',effort:''});
  assert.equal((await request('runtime',{method:'PUT',body:{groupId:'44444444',model:'model-b',effort:'max'}})).status,403);
  assert.equal((await request('runtime',{method:'PUT',body:{groupId:'33333333',model:'model-b',effort:'high'}})).status,400);
  assert.equal((await request('runtime',{method:'PUT',body:{userId:'other',model:'model-b',effort:'max'}})).status,400);
  assert.equal((await request('runtime',{session:{userId:'other',permissions}})).status,403);
  const scope=await request('runtime?groupId=33333333');assert.equal(scope.body.effective.effort,'max');
  assert.equal((await request('unknown')).status,404);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));db.close();}
});

test('Codex CLI has an independent permissioned menu and reserved page/API routing',()=>{
 const menus=buildMenusFromServices([],[]),menu=menus.find(m=>m.serviceId==='codex-cli');
 assert.equal(menu.path,'/codex-cli/');assert.equal(menu.permission,'codex-cli:view');
 assert.ok(!getVisibleMenus({menus},[]).some(m=>m.serviceId==='codex-cli'));
 assert.ok(getVisibleMenus({menus},['codex-cli:view']).some(m=>m.serviceId==='codex-cli'));
 assert.equal(canCodexCli({userId:'owner',permissions:['codex-cli:view']}),true);
 assert.equal(canCodexCli({userId:'guest',isGuest:true,permissions:['*']}),false);
 for(const p of SYSTEM_PERMISSIONS.filter(p=>p.id.startsWith('codex-cli:')))assert.deepEqual(p.permissionPath.slice(0,2),['首页','Codex CLI']);
 assert.equal(canonicalPortalPagePath('/codex-cli/index.html'),'/codex-cli/');
 const services=[{id:'napcat',path:'/napcat/',type:'proxy'}];
 assert.equal(resolveRoute(services,'/api/codex-cli/status','GET','',{referer:'https://site/napcat/'}).kind,'portal-api');
});
