import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { codexArguments, generate, modelConfiguration, runProcess, transcriptChunks } from './knowledge-model.js';

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
