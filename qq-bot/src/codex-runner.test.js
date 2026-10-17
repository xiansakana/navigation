import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runCommand, syncProject, executeCodex } from './codex-runner.js';
import { prepareCodexMedia } from './codex-media.js';

async function fixture(fn) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'qq-codex-git-')),remote=path.join(root,'remote.git'),local=path.join(root,'local'),directory=path.join(root,'worker');
  const run=(cwd,args)=>runCommand('git',args,{cwd});
  try {
    await run(root,['init','--bare',remote]);await run(root,['clone',remote,local]);
    await run(local,['config','user.email','test@example.com']);await run(local,['config','user.name','Codex test']);
    await run(local,['checkout','-b','main']);await fs.writeFile(path.join(local,'AGENTS.md'),'Read all instructions.\n');await run(local,['add','AGENTS.md']);await run(local,['commit','-m','initial']);await run(local,['push','-u','origin','main']);
    await fn({root,remote,local,directory,p:{directory,remote,branch:'main'},run});
  }finally {await fs.rm(root,{recursive:true,force:true});}
}
test('Git synchronization transfers original code and AGENTS, and never overwrites dirty work',async()=>fixture(async({p,local,directory,run})=>{
  await syncProject(p);assert.equal((await fs.readFile(path.join(directory,'AGENTS.md'),'utf8')).replaceAll('\r\n','\n'),'Read all instructions.\n');
  await fs.writeFile(path.join(local,'AGENTS.md'),'Updated instructions.\n');await run(local,['commit','-am','instructions']);await run(local,['push','origin','main']);
  await syncProject(p);assert.equal((await fs.readFile(path.join(directory,'AGENTS.md'),'utf8')).replaceAll('\r\n','\n'),'Updated instructions.\n');
  await fs.writeFile(path.join(directory,'keep.txt'),'unfinished');await assert.rejects(syncProject(p),/未提交修改/);
  await syncProject(p,undefined,{continuing:true});assert.equal(await fs.readFile(path.join(directory,'keep.txt'),'utf8'),'unfinished');
}));
test('divergent history is preserved; a resumed agent can inspect it without forced reset',async()=>fixture(async({p,local,directory,run})=>{
  await syncProject(p);await run(directory,['config','user.email','test@example.com']);await run(directory,['config','user.name','test']);
  await fs.writeFile(path.join(directory,'server.txt'),'server');await run(directory,['add','.']);await run(directory,['commit','-m','server']);const head=await run(directory,['rev-parse','HEAD']);
  await fs.writeFile(path.join(local,'local.txt'),'local');await run(local,['add','.']);await run(local,['commit','-m','local']);await run(local,['push','origin','main']);
  await assert.rejects(syncProject(p));assert.equal(await run(directory,['rev-parse','HEAD']),head);
  await syncProject(p,undefined,{continuing:true});assert.equal(await run(directory,['rev-parse','HEAD']),head);
}));
test('cancellation terminates the runner and no shell interprets user arguments',async()=>{
  const controller=new AbortController();const promise=runCommand(process.execPath,['-e','setInterval(()=>{},1000)'],{signal:controller.signal});controller.abort();await assert.rejects(promise,/停止/);
  const text=await runCommand(process.execPath,['-e','process.stdout.write(process.argv[1])','$(echo unsafe); test']);assert.equal(text,'$(echo unsafe); test');
});
test('Git-only command does not invoke Codex and rejects missing tracked AGENTS',async()=>fixture(async({p,local,run})=>{
  const result=await executeCodex({projects:{navigation:p}},{project:'navigation',prompt:'__sync__'});assert.match(result.result,/AGENTS.md/);assert.ok(result.commit);
  await run(local,['rm','AGENTS.md']);await run(local,['commit','-m','remove instructions']);await run(local,['push','origin','main']);await assert.rejects(syncProject(p));
}));

test('completed Codex changes and AGENTS are pushed through Git, with independent QQ resume',async()=>fixture(async({p,directory,local,run})=>{
  const result=await executeCodex({projects:{navigation:p},proxyUrl:'http://127.0.0.1:17890'}, {project:'navigation',prompt:'实现任务 $(not-a-shell)'},'qq-session', {command:async(binary,args,options)=>{
    assert.ok(args.includes('resume'));assert.ok(args.includes('qq-session'));assert.ok(!args.includes('--ignore-rules'));assert.ok(!args.includes('--ignore-user-config'));
    assert.match(options.input,/AGENTS.md/);assert.match(options.input,/\$\(not-a-shell\)/);assert.equal(options.env.HTTPS_PROXY,'http://127.0.0.1:17890');
    await run(directory,['config','user.email','test@example.com']);await run(directory,['config','user.name','test']);
    await fs.writeFile(path.join(directory,'implemented.txt'),'implemented');await run(directory,['add','implemented.txt']);await run(directory,['commit','-m','implement']);
    options.onEvent({type:'thread.started',thread_id:'qq-session'});options.onEvent({type:'item.completed',item:{type:'agent_message',text:'实现并验证完成'}});options.onEvent({type:'turn.completed'});
  }});
  assert.equal(result.sessionId,'qq-session');assert.equal(result.result,'实现并验证完成');
  await run(local,['pull','--ff-only']);assert.equal(await fs.readFile(path.join(local,'implemented.txt'),'utf8'),'implemented');assert.equal(await run(local,['rev-parse','HEAD']),result.commit);
}));

test('incomplete model output never reports success or discards uncommitted edits',async()=>fixture(async({p,directory,run})=>{
  await assert.rejects(executeCodex({projects:{navigation:p}},{project:'navigation',prompt:'change'},undefined,{command:async(binary,args,options)=>{
    await fs.writeFile(path.join(directory,'unfinished.txt'),'preserve');options.onEvent({type:'thread.started',thread_id:'resume-this'});
  }}),e=>{assert.equal(e.sessionId,'resume-this');return /完整结果/.test(e.message);});
  assert.equal(await fs.readFile(path.join(directory,'unfinished.txt'),'utf8'),'preserve');
  assert.ok(await run(directory,['status','--porcelain']));
}));

test('new and resumed image tasks receive CLI vision input and export files outside Git',async()=>fixture(async({p,root,run,directory})=>{
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lx8AAAAASUVORK5CYII=','base64');
  const config={projects:{navigation:p},mediaDirectory:path.join(root,'media')};
  for(const [index,session] of [undefined,'previous-session'].entries()){
    const job={id:(index?'1':'0')+'123456789abcdef',user_id:'owner',project:'navigation',prompt:'分析图片并返回CSV',attachments_json:JSON.stringify([{kind:'image',id:'qq-image',name:'screen.png',size:png.length}])};
    const media=await prepareCodexMedia(config,job,{}, {api:async()=>({data:{url:'https://files.qq.com/image'}}),download:async()=>png});
    const result=await executeCodex(config,job,session,{media,command:async(binary,args,options)=>{
      assert.equal(args.includes('resume'),!!session);
      assert.equal(args[args.indexOf('--image')+1],media.files[0].path);
      assert.equal(args[args.indexOf('--add-dir')+1],media.root);
      if(session)assert.ok(args.indexOf('--image')>args.indexOf('resume'));
      assert.match(options.input,/输入附件/);assert.ok(options.input.includes(media.output));
      await fs.writeFile(path.join(media.output,'analysis.csv'),'item,value\nresult,1\n');
      options.onEvent({type:'thread.started',thread_id:session || 'new-session'});
      options.onEvent({type:'item.completed',item:{type:'agent_message',text:'已生成CSV'}});options.onEvent({type:'turn.completed'});
    }});
    assert.equal(result.artifacts.length,1);assert.equal(result.artifacts[0].name,'analysis.csv');
    assert.equal(await run(directory,['status','--porcelain']),'');
    assert.equal(result.sessionId,session || 'new-session');
  }
}));
