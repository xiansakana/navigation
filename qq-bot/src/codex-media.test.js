import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { createCodexStore } from './codex-store.js';
import { createCodexService, codexEvent } from './codex.js';
import { normalizeConfig } from './config.js';
import { callNapCat } from './napcat.js';
import { attachmentSegments, validateAttachments, publicAddress, downloadAttachment, prepareCodexMedia, collectCodexArtifacts, sendCodexArtifact, MAX_FILE_BYTES } from './codex-media.js';

const Database = createRequire(new URL('../../portal/package.json',import.meta.url))('better-sqlite3');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lx8AAAAASUVORK5CYII=','base64');
const image = {kind:'image',id:'qq-image-id',name:'screen.png',size:png.length,url:''};
const file = {kind:'file',id:'qq-file-id',name:'report.csv',size:12,url:''};
const job = {id:'0123456789abcdef',user_id:'owner',group_id:'',attachments_json:JSON.stringify([image,file])};
const event = (text = '',segments = [],id = 42,group = '') => ({post_type:'message',message_type:group?'group':'private',self_id:'22222222',user_id:'12345678',group_id:group,message_id:id,message:[...(group && text?[{type:'at',data:{qq:'22222222'}}]:[]),...(text?[{type:'text',data:{text}}]:[]),...segments]});
const imageSegment = {type:'image',data:{file:'qq-image-id',file_size:png.length}};

async function mediaFixture(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'qq-codex-media-'));
  const config = {mediaDirectory:root};
  try {
    const calls = [];
    const options = {
      api:async(base,token,action,params)=>{calls.push({action,params});return {data:{url:'https://files.qq.com/' + (action==='get_image'?'image':'file')}};},
      download:async url=>url.endsWith('image')?png:Buffer.from('a,b\n1,2\n')
    };
    const media = await prepareCodexMedia(config,job,{},options);
    await fn({root,config,media,calls,options});
  } finally { assert.ok(root.startsWith(os.tmpdir()));await fs.rm(root,{recursive:true,force:true}); }
}

test('inbound files are downloaded using fresh authenticated QQ API URLs and isolated from the Git checkout',async()=>mediaFixture(async({config,media,calls,options})=>{
  assert.deepEqual(calls.map(c=>c.action),['get_image','get_private_file_url']);
  assert.equal(media.files[0].kind,'image');assert.equal(media.files[1].kind,'file');
  assert.deepEqual(await fs.readFile(media.files[0].path),png);
  const grouped = await prepareCodexMedia(config,{...job,id:'1123456789abcdef',group_id:'33333333'}, {},options);
  assert.notEqual(grouped.root,media.root);assert.equal(calls.at(-1).action,'get_group_file_url');
  assert.equal(calls.at(-1).params.group_id,'33333333');
  assert.match(media.files[1].path,/input/);
}));

test('attachment metadata, sizes, names and unsupported image content are checked',async()=>mediaFixture(async({config,options})=>{
  assert.throws(()=>validateAttachments(Array(7).fill(image)),/6个/);
  assert.throws(()=>validateAttachments([{...file,size:MAX_FILE_BYTES+1}]),/25MB/);
  assert.throws(()=>validateAttachments([{...file,id:'file:///etc/passwd'}]),/无效/);
  assert.throws(()=>validateAttachments([{...file,size:NaN}]),/25MB/);
  assert.equal(attachmentSegments([{type:'file',data:{file_id:'id',name:'../../secret.txt'}}])[0].name,'secret.txt');
  await assert.rejects(prepareCodexMedia(config,{...job,id:'2123456789abcdef',attachments_json:JSON.stringify([image])},{},{...options,download:async()=>Buffer.from('not an image')}),/图片格式/);
  await assert.rejects(prepareCodexMedia(config,{...job,id:'3123456789abcdef',attachments_json:JSON.stringify([file])},{},{...options,download:async()=>Buffer.alloc(MAX_FILE_BYTES+1)}),/实际大小/);
}));

test('get_file base64 fallback works when file direct-link APIs are unavailable',async()=>mediaFixture(async({config})=>{
  const calls=[];
  const media=await prepareCodexMedia(config,{...job,id:'4123456789abcdef',attachments_json:JSON.stringify([file])},{},{api:async(base,token,action)=>{
    calls.push(action);if(action!=='get_file')throw new Error('packet unavailable');return {data:{base64:Buffer.from('fallback').toString('base64')}};
  }});
  assert.deepEqual(calls,['get_private_file_url','get_file']);assert.equal((await fs.readFile(media.files[0].path)).toString(),'fallback');
}));

test('NapCat calls authenticate only to the configured API and bound file response sizes',async()=>{
  const server=http.createServer((request,response)=>{
    assert.equal(request.headers.authorization,'Bearer api-secret');
    response.setHeader('Content-Type','application/json');
    response.end(JSON.stringify({status:'ok',retcode:0,data:{base64:'x'.repeat(512)}}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base='http://127.0.0.1:'+server.address().port;
  try {
    await assert.rejects(callNapCat(base,'api-secret','get_file',{file_id:'id'},{maxResponseBytes:64}),/大小限制/);
    assert.equal((await callNapCat(base,'api-secret','get_file',{file_id:'id'},{maxResponseBytes:1024})).data.base64.length,512);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('output snapshots are immutable; images and documents use separate NapCat APIs with base64 transport',async()=>mediaFixture(async({config,media})=>{
  await fs.writeFile(path.join(media.output,'report.csv'),'a,b\n1,2');
  await fs.writeFile(path.join(media.output,'chart.png'),png);
  const artifacts = await collectCodexArtifacts(config,job,media);
  assert.equal(artifacts.length,2);
  await fs.writeFile(path.join(media.output,'report.csv'),'changed after completion');
  const calls=[];
  const api=async(base,token,action,params)=>{calls.push({action,params});};
  const current={codex:config,napcat:{baseUrl:'http://127.0.0.1:3000',accessToken:'private'}};
  const report=artifacts.find(a=>a.name==='report.csv'),chart=artifacts.find(a=>a.kind==='image');
  await sendCodexArtifact(current,{type:'private',userId:'12345678'},report,{userId:job.user_id,api});
  assert.equal(calls[0].action,'upload_private_file');assert.equal(calls[0].params.name,'report.csv');
  assert.equal(Buffer.from(calls[0].params.file.slice(9),'base64').toString(),'a,b\n1,2');
  await sendCodexArtifact(current,{type:'group',groupId:'33333333',atUserId:'12345678'},chart,{userId:job.user_id,api});
  assert.equal(calls[1].action,'send_group_msg');assert.equal(calls[1].params.message[1].type,'image');
  assert.ok(calls[1].params.message[1].data.file.startsWith('base64://'));
  await assert.rejects(sendCodexArtifact(current,{type:'private',userId:'12345678'},report,{userId:'other-user',api}));
  await assert.rejects(sendCodexArtifact(current,{type:'private',userId:'12345678'},{...report,file:'../../secret'},{userId:job.user_id,api}),/无效/);
}));

test('symbolic links, hard links, directories and oversized files are never exported',async()=>mediaFixture(async({config,media,root})=>{
  const secret=path.join(root,'secret.txt');await fs.writeFile(secret,'private');
  const output=path.join(media.output,'linked.txt');
  await fs.link(secret,output);await assert.rejects(collectCodexArtifacts(config,job,media),/普通文件/);await fs.unlink(output);
  await fs.symlink(root,path.join(media.output,'escape'),'junction');await assert.rejects(collectCodexArtifacts(config,job,media),/普通文件/);await fs.unlink(path.join(media.output,'escape'));
  await fs.writeFile(output,'');await fs.truncate(output,MAX_FILE_BYTES+1);await assert.rejects(collectCodexArtifacts(config,job,media),/25MB/);
}));

test('downloads block arbitrary URLs, private DNS, credentials, rebinding and private redirects',async()=>{
  for(const address of ['127.0.0.1','10.0.0.1','169.254.169.254','172.17.0.1','192.168.1.1','100.64.1.1','::1','::ffff:127.0.0.1','fc00::1'])assert.equal(publicAddress(address),false,address);
  const lookup=async()=>[{address:'1.1.1.1',family:4}];
  await assert.rejects(downloadAttachment('https://evil.test/file',{lookup}),/仅接收QQ/);
  await assert.rejects(downloadAttachment('https://secret@files.qq.com/file',{lookup}),/地址无效/);
  await assert.rejects(downloadAttachment('https://files.qq.com/file',{lookup:async()=>[{address:'127.0.0.1',family:4}]}),/内网/);
  let checks=0;
  const request=(url,options,callback)=>{
    assert.deepEqual(options.headers,{'Accept-Encoding':'identity'});
    options.lookup('files.qq.com',{all:true},(error,addresses)=>{assert.equal(addresses[0].address,'1.1.1.1');checks++;});
    const req=new EventEmitter();
    queueMicrotask(()=>{const response=Readable.from([Buffer.from('ok')]);response.statusCode=200;response.headers={};callback(response);});
    return req;
  };
  assert.equal((await downloadAttachment('https://files.qq.com/file',{lookup,request})).toString(),'ok');assert.equal(checks,1);
  const redirect=(url,options,callback)=>{const req=new EventEmitter();queueMicrotask(()=>{const response=Readable.from([]);response.statusCode=302;response.headers={location:'http://127.0.0.1/private'};callback(response);});return req;};
  await assert.rejects(downloadAttachment('https://files.qq.com/file',{trusted:true,request:redirect,lookup:async host=>[{address:host==='127.0.0.1'?'127.0.0.1':'1.1.1.1',family:4}]}),/内网/);
  await assert.rejects(downloadAttachment('https://files.qq.com/file',{lookup,request,maxBytes:1}),/超|limit/i);
});

test('staged attachments are durable, scoped, expire, deduplicate, and survive quota commands',async()=>{
  const db=new Database(':memory:'),store=createCodexStore(db),seen=[];
  const config=normalizeConfig({codex:{enabled:true,defaultProject:'navigation',projects:{navigation:{directory:path.resolve(os.tmpdir(),'media-project'),remote:'git@example.com:repo'}}}});
  const service=createCodexService({getConfig:()=>config,store,authorize:qq=>qq==='12345678'?{userId:'owner',projects:['navigation']}:null,send:async()=>{},prepareMedia:async(c,j)=>{seen.push(JSON.parse(j.attachments_json));},execute:async()=>({result:'done'})});
  try {
    await service.receive(event('',[imageSegment]));await service.receive(event('',[imageSegment]));
    assert.equal(store.attachments('owner').length,1);assert.equal(createCodexStore(db).attachments('owner').length,1);
    assert.equal(store.attachments('other').length,0);assert.equal(store.attachments('owner','33333333').length,0);
    await service.receive(event('codex 额度',[],43));assert.equal(store.attachments('owner').length,1);
    await service.receive(event('codex 分析图片',[],44));assert.equal(store.attachments('owner').length,0);
    service.start();await service.tick();await service.tick();assert.equal(seen.length,1);assert.equal(seen[0][0].id,'qq-image-id');
    store.stageAttachments('owner','',[file]);db.prepare('UPDATE qq_codex_pending_files SET created_at=0').run();assert.equal(store.attachments('owner').length,0);
    await service.receive(event('codex 处理这张图片',[imageSegment],45));await service.tick();assert.equal(seen.at(-1).length,1);
    await service.receive({...event('',[imageSegment],46),user_id:'87654321'});assert.equal(store.attachments('owner').length,0);
  }finally{service.stop();db.close();}
});

test('group file notices only stage authorized owner data; exports honor privacy changes and revocation',async()=>{
  const db=new Database(':memory:'),store=createCodexStore(db),sent=[];
  const config=normalizeConfig({codex:{enabled:true,defaultProject:'navigation',projects:{navigation:{directory:path.resolve(os.tmpdir(),'media-project'),remote:'git@example.com:repo'}}}});
  let allowed=true,fail=true;
  const service=createCodexService({getConfig:()=>config,store,authorize:qq=>allowed&&qq==='12345678'?{userId:'owner',projects:['navigation']}:null,send:async()=>{},prepareMedia:async()=>undefined,
    execute:async()=>({result:'done',artifacts:[{jobId:'0123456789abcdef',name:'output.txt'}]}),
    sendArtifact:async(c,target,artifact)=>{if(fail)throw new Error('offline');sent.push({target,artifact});},log:{error(){}}});
  try {
    store.saveSettings('owner',{groups:['33333333'],groupReply:'group'});
    const notice={post_type:'notice',notice_type:'group_upload',self_id:'22222222',group_id:'33333333',user_id:'12345678',file:{id:'file-id',name:'input.csv',size:10}};
    assert.ok(codexEvent(notice));await service.receive(notice);await service.receive(notice);
    assert.equal(store.attachments('owner','33333333').length,1);assert.equal(store.active('owner','33333333').length,0);
    await service.receive(event('codex 处理文件',[],43,'33333333'));service.start();await service.tick();
    store.saveSettings('owner',{groups:['33333333'],groupReply:'private'});
    while(store.pendingReply())await service.deliver();
    assert.equal(db.prepare("SELECT count(*) AS n FROM qq_codex_outbox WHERE artifact_json<>''").get().n,1);
    fail=false;db.prepare('UPDATE qq_codex_outbox SET next_attempt=0').run();await service.deliver();assert.equal(sent[0].target.type,'private');
    await service.receive(event('codex 结果',[],44,'33333333'));
    store.saveSettings('owner',{groups:[],groupReply:'private'});
    while(store.pendingReply())await service.deliver();assert.equal(sent.length,1);
    store.replyArtifact('owner','12345678',{name:'blocked'});allowed=false;await service.deliver();assert.equal(sent.length,1);
  }finally{service.stop();db.close();}
});
