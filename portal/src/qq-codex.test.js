import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { getDatabase, closeDatabase } from '../../shared/db/index.js';
import { handleQqCodexApi } from './qq-codex.js';
import { createCodexStore } from '../../qq-bot/src/codex-store.js';
import { resolveRoute } from './router.js';
import { SYSTEM_PERMISSIONS } from './rbac.js';

const permissions=['qq-codex:execute','qq-codex:settings:view','qq-codex:settings:edit'];
test('QQ Codex own group settings enforce permissions, provisioning, CSRF and persistence',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-codex-api-')),previous=process.env.NAVIGATION_DB_PATH;
  process.env.NAVIGATION_DB_PATH=path.join(root,'db.sqlite');
  const server=http.createServer((req,res)=>{
    const session=JSON.parse(req.headers['x-test-session']||JSON.stringify({userId:'owner',permissions}));
    handleQqCodexApi(req,res,new URL(req.url,'http://localhost'),session,(r,status,data)=>{r.writeHead(status,{'Content-Type':'application/json'});r.end(JSON.stringify(data));},uid=>({enabled:true,configured:uid==='owner',projects:['navigation']}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const request=async({session,method='GET',data,origin,route='/api/qq-codex/settings'}={})=>{
    const r=await fetch('http://127.0.0.1:'+server.address().port+route,{method,headers:{...(session?{'X-Test-Session':JSON.stringify(session)}:{}),...(origin?{Origin:origin}:{})},body:data===undefined?undefined:JSON.stringify(data)});
    return {status:r.status,data:await r.json()};
  };
  try {
    for(const session of [{},{userId:'owner',permissions:[]},{userId:'owner',isGuest:true,permissions:['*']}])assert.equal((await request({session})).status,403);
    const readOnly={userId:'owner',permissions:permissions.slice(0,2)};
    assert.equal((await request({session:readOnly})).status,200);
    assert.equal((await request({session:readOnly,method:'PUT',data:{groups:[],groupReply:'private'}})).status,403);
    assert.equal((await request({method:'PUT',origin:'https://evil.example',data:{groups:[],groupReply:'private'}})).status,403);
    assert.equal((await request({session:{userId:'other',permissions},method:'PUT',data:{groups:['33333333'],groupReply:'group'}})).status,403);
    assert.equal((await request({method:'PUT',data:{groups:['bad'],groupReply:'group'}})).status,400);
    const saved=await request({method:'PUT',data:{groups:['33333333','33333333'],groupReply:'group',userId:'other',binary:'malicious'}});
    assert.equal(saved.status,200);assert.deepEqual(saved.data.groups,['33333333']);
    const store=createCodexStore(getDatabase());assert.deepEqual(store.settings('owner'),{groups:['33333333'],groupReply:'group'});assert.deepEqual(store.settings('other').groups,[]);
    assert.equal((await request()).data.groupReply,'group');assert.equal((await request({route:'/api/qq-codex/unknown'})).status,404);
    const exposed=JSON.stringify(saved.data);assert.ok(!exposed.includes('binary'));assert.ok(!exposed.includes('token'));
    for(const permission of permissions)assert.deepEqual(SYSTEM_PERMISSIONS.find(p=>p.id===permission).permissionPath.slice(0,3),['首页','通知管理','QQ Codex']);
    assert.equal(resolveRoute([], '/api/qq-codex/settings','GET','',{referer:'https://site/napcat/'}).kind,'portal-api');
  }finally{
    server.closeAllConnections();await new Promise(r=>server.close(r));closeDatabase();
    if(previous===undefined)delete process.env.NAVIGATION_DB_PATH;else process.env.NAVIGATION_DB_PATH=previous;
    fs.rmSync(root,{recursive:true,force:true});
  }
});
