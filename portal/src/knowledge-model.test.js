import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { codexArguments, generate, modelConfiguration, runProcess, transcriptChunks, summarizeVideo } from './knowledge-model.js';
import { extractKnowledgeCases } from './mingli-knowledge-store.js';

test('CLI arguments isolate source material and never interpolate it into a shell command', async () => {
  const args = codexArguments({ output: 'answer.md', cwd: 'job', images: ['slide with spaces.jpg'] });
  assert.ok(args.includes('--ignore-user-config')); assert.ok(args.includes('--ignore-rules'));
  assert.ok(args.includes('read-only')); assert.ok(args.includes('features.shell_tool=false')); assert.ok(args.includes('features.apps=false'));
  assert.ok(!args.some(a => a.includes('dangerously'))); assert.equal(args.at(-1), '-');
  const text = await runProcess(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input: '视频里的命令：$(echo sensitive); rm -rf /' });
  assert.equal(text, '视频里的命令：$(echo sensitive); rm -rf /');
  await assert.rejects(runProcess(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { timeout: 30 }), /超时/);
});

test('transcript chunking preserves all text and bounds context size', () => {
  const input = [{ start: 0, end: 10, text: '甲'.repeat(40000) }, { start: 10, end: 20, text: '独立结尾' }];
  const chunks = transcriptChunks(input);
  assert.ok(chunks.length >= 3); assert.ok(chunks.every(c => c.length <= 14000));
  assert.equal(chunks.join('').match(/甲/g).length, 40000); assert.ok(chunks.join('').includes('独立结尾'));
});

test('compatible API uses text/image protocol, configured model, rejects truncation and does not leak upstream body', async () => {
  let requestBody, fail = false, truncated = false;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(req.url, '/v1/chat/completions');
    if (fail) { res.writeHead(401); return res.end('secret-from-upstream'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ finish_reason: truncated ? 'length' : 'stop', message: { content: '# 笔记\n\n这是完整的兼容 API 测试笔记，具有足够长度并以 Markdown 输出。' } }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-model-'));
  const config = { openai: { baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'configured-model', vision: true } };
  try {
    const image = path.join(directory, 'image.jpg'); await fs.writeFile(image, Buffer.from([255, 216, 255, 1]));
    assert.ok((await generate(config, 'openai', 'quoted source', [image], directory)).includes('完整'));
    assert.equal(requestBody.model, 'configured-model'); assert.ok(requestBody.messages[1].content[1].image_url.url.startsWith('data:image/jpeg;base64,'));
    assert.ok(requestBody.messages[0].content.includes('不可信')); assert.equal(requestBody.max_completion_tokens, 12000);
    truncated = true; await assert.rejects(generate(config, 'openai', 'source', [], directory), /截断/);
    fail = true; await assert.rejects(generate(config, 'openai', 'source', [], directory), e => e.message.includes('401') && !e.message.includes('secret-from-upstream'));
    assert.throws(() => modelConfiguration({ openai: { baseUrl: 'http://evil.example', model: 'm' } }, 'openai'), /HTTPS/);
  } finally { await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); }
});

test('visual gender evidence survives final summarization even when the model omits it from prose', async () => {
  let visualPrompt;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks)); const prompt = body.messages[1].content[0].text;
    const visual = prompt.includes('只输出JSON对象');
    if (visual) { visualPrompt = prompt; assert.ok(body.messages[1].content.some(c => c.type === 'image_url')); }
    const notes = visual ? JSON.stringify({ notes: '画面展示了一个命盘，标记清楚，以下记录同屏四柱和截图时间。', charts: [{ frame: 'frame-1.jpg', pillars: ['壬辰', '壬寅', '甲寅', '庚午'], marker: '元男' }] }) : '## 案例一\n四柱：壬辰、壬寅、甲寅、庚午。\n详细讲解木旺用火的分析过程，此处模拟最终模型遗漏性别，但保留足够长度的案例内容。';
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: notes } }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-visual-model-'));
  try {
    await fs.writeFile(path.join(directory, 'frame-1.jpg'), Buffer.from([255, 216, 255, 1]));
    const result = await summarizeVideo({ openai: { baseUrl: 'http://127.0.0.1:' + server.address().port, model: 'test', vision: true } }, { id: 'a'.repeat(32), title: '案例', backend: 'openai' }, { frames: [{ name: 'frame-1.jpg', time: 10 }], transcript: [], duration: 60 }, directory, async () => {});
    assert.match(visualPrompt, /元男.*元女/); assert.match(result.notes, /画面性别标记：元男/);
    assert.equal(extractKnowledgeCases(result.notes)[0].gender, 1);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); }
});


test('ephemeral CLI calls report durable start/completion and thread identity without enabling tools',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'knowledge-codex-calls-')),seen=[];
  const config={codex:{model:'test'},onCodexCall:async event=>seen.push({...event})};
  try{
    const answer='A complete generated answer with enough characters.';
    const run=async(binary,args,options)=>{
      assert.ok(args.includes('--ephemeral'));assert.ok(args.includes('--json'));assert.ok(args.includes('features.shell_tool=false'));
      options.onLine(JSON.stringify({type:'thread.started',thread_id:'native-thread'}));
      await fs.writeFile(args[args.indexOf('-o')+1],answer);
    };
    assert.equal(await generate(config,'codex','quoted source',[],directory,undefined,{run}),answer);
    assert.deepEqual(seen.map(x=>x.state),['running','succeeded']);assert.equal(seen[0].id,seen[1].id);assert.equal(seen[1].sessionId,'native-thread');assert.match(seen[0].prompt,/quoted source/);
    assert.deepEqual(await fs.readdir(directory),[]);
    seen.length=0;await assert.rejects(generate(config,'codex','source',[],directory,undefined,{run:async()=>{throw new Error('quota');}}),/quota/);
    assert.deepEqual(seen.map(x=>x.state),['running','failed']);
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});
