import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createKnowledgeStore } from './knowledge-store.js';
import { generateGeminiVideo, runGeminiJob } from './knowledge-gemini.js';

const origin = 'https://generativelanguage.googleapis.com';
const notes = '# 视频笔记\n\n[00:03] 结合原视频的讲解和画面，记录这一段的核心观点、案例和需要回看核对的细节。';

test('Gemini uploads original bytes, waits for ACTIVE, summarizes audio and video, then removes the remote file', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-api-'));
  const file = path.join(directory, 'source');
  await fs.writeFile(file, 'video sample data');
  const calls = [];
  try {
    const result = await generateGeminiVideo({
      apiKey: 'test-key', model: 'gemini-test', file, size: 17, mimeType: 'video/mp4', title: '视频', duration: 185, includeTranscript: true,
      signal: AbortSignal.timeout(5000), progress: async () => {}, wait: async () => {},
      async fetcher(url, options) {
        const target = new URL(url);
        assert.equal(target.origin, origin);
        assert.equal(options.redirect, 'error');
        calls.push(options.method + ' ' + target.pathname);
        if (target.search) {
          assert.equal(options.headers['x-goog-api-key'], undefined);
          assert.equal(options.headers['X-Goog-Upload-Command'], 'upload, finalize');
          const chunks = [];
          for await (const bytes of options.body) chunks.push(bytes);
          assert.equal(Buffer.concat(chunks).toString(), 'video sample data');
          return Response.json({ file: { name: 'files/video', state: 'PROCESSING' } });
        }
        assert.equal(options.headers['x-goog-api-key'], 'test-key');
        if (options.method === 'DELETE') return new Response(null, { status: 204 });
        if (target.pathname === '/upload/v1beta/files') return new Response(null, { headers: { 'x-goog-upload-url': origin + '/upload/v1beta/files?upload_id=test' } });
        if (options.method === 'GET') return Response.json({ name: 'files/video', uri: origin + '/v1beta/files/video', state: 'ACTIVE' });
        const input = JSON.parse(options.body);
        assert.equal(input.contents[0].parts[0].fileData.fileUri, origin + '/v1beta/files/video');
        assert.equal(input.tools, undefined);
        if (input.generationConfig.responseMimeType) {
          const offset = input.contents[0].parts[0].videoMetadata;
          assert.ok(['0s', '180s'].includes(offset.startOffset));
          if (offset.startOffset === '180s') {
            assert.equal(offset.endOffset, '185s');
            return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '[{"start":1,"end":4,"text":"第二段"}]' }] } }] });
          }
          return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '[{"start":3,"end":5,"text":"第一段"}]' }] } }] });
        }
        return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: notes + '\nKEYFRAME_SECONDS: 9, 3, 3, 999, -10' }] } }] });
      }
    });
    assert.equal(result.notes, notes);
    assert.deepEqual(result.frameTimes, [3, 9]);
    assert.deepEqual(result.transcript, [{ start: 3, end: 5, text: '第一段' }, { start: 181, end: 184, text: '第二段' }]);
    assert.deepEqual(calls, ['POST /upload/v1beta/files', 'POST /upload/v1beta/files', 'GET /v1beta/files/video', 'POST /v1beta/models/gemini-test:generateContent', 'POST /v1beta/models/gemini-test:generateContent', 'POST /v1beta/models/gemini-test:generateContent', 'DELETE /v1beta/files/video']);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('Portal completes a Gemini job without a GPU and leaves other accounts and backends queued', async () => {
  const db = new Database(':memory:');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-queue-'));
  const store = createKnowledgeStore(db), directoryFor = id => path.join(root, id);
  const add = async (uid, backend) => {
    const doc = store.create(uid, { backend, title: '视频', originalName: 'source.mp4', mimeType: 'video/mp4', bytes: 32 });
    await fs.mkdir(directoryFor(doc.id));
    await fs.writeFile(path.join(directoryFor(doc.id), 'source'), Buffer.alloc(32));
    store.enqueue(uid, doc.id);
    return doc.id;
  };
  try {
    store.saveSettings('owner', { geminiTranscript: true });
    const other = await add('other', 'gemini'), codex = await add('owner', 'codex'), gemini = await add('owner', 'gemini');
    const options = { accounts: new Map([['owner', { apiKey: 'test-key', model: 'gemini-test' }]]),
      probe: async (_, args) => {
        assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'file');
        assert.equal(args[args.indexOf('-f') + 1], 'mov');
        return '60';
      },
      async capture(_, args) {
        assert.equal(args[args.indexOf('-ss') + 1], '3.000');
        assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'file');
        const jpeg = Buffer.alloc(40); jpeg.set([255, 216, 255]);
        await fs.writeFile(args.at(-1), jpeg);
      },
      async generate({ file, progress, includeTranscript }) {
        assert.equal((await fs.stat(file)).size, 32);
        assert.equal(store.getRow('owner', gemini).status, 'processing');
        assert.equal(await runGeminiJob(db, directoryFor, () => true, options), false);
        await progress('Gemini 正在观看视频并生成笔记', 70);
        assert.equal(includeTranscript, true);
        return { notes, frameTimes: [3], transcript: [{ start: 3, end: 4, text: '一句话' }], warnings: [] };
      }
    };
    assert.equal(await runGeminiJob(db, directoryFor, uid => uid === 'owner', options), true);
    assert.equal(store.get('owner', gemini).notes, notes);
    assert.equal(store.get('owner', gemini).provenance.backend, 'gemini');
    const result = store.get('owner', gemini);
    assert.equal(result.transcript[0].text, '一句话');
    assert.equal(result.frames[0].time, 3);
    assert.equal((await fs.readFile(path.join(directoryFor(gemini), result.frames[0].name))).length, 40);
    assert.deepEqual((await fs.readdir(directoryFor(gemini))).sort(), [result.frames[0].name, 'source']);
    assert.equal(store.getRow('other', other).status, 'queued');
    assert.equal(store.getRow('owner', codex).status, 'queued');
    const denied = await add('owner', 'gemini');
    await runGeminiJob(db, directoryFor, () => false, { ...options, generate: () => assert.fail('permission required') });
    assert.equal(store.getRow('owner', denied).status, 'failed');
  } finally { db.close(); await fs.rm(root, { recursive: true, force: true }); }
});
