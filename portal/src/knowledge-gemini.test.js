import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createKnowledgeStore } from './knowledge-store.js';
import { uploadGeminiFile } from './knowledge-gemini-upload.js';
import { cooldownFor, geminiQuotaHint } from './knowledge-gemini-cooldown.js';
import { generateGeminiVideo, runGeminiJob } from './knowledge-gemini.js';

const origin = 'https://generativelanguage.googleapis.com';
const notes = '# 视频笔记\n\n[00:03] 结合原视频的讲解和画面，记录这一段的核心观点、案例和需要回看核对的细节。';

test('Gemini cooldown honors retry hints and backs off longer for a daily quota', async () => {
  const hint = await geminiQuotaHint(Response.json({ error: { details: [
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '73.4s' },
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel' }] },
  ] } }, { status: 429, headers: { 'Retry-After': '90' } }));
  assert.deepEqual(hint, { retryAfterMs: 90000, dailyQuota: true });
  assert.equal(cooldownFor({ status: 429, ...hint }, 0, 0).retryAt, '1970-01-02T00:00:00.000Z');
  assert.equal(cooldownFor({ status: 429, retryAfterMs: 90000 }, 0, 0).retryAt, '1970-01-01T00:01:30.000Z');
  assert.equal(cooldownFor({ status: 429 }, 2, 0).retryAt, '1970-01-01T00:04:00.000Z');
});

test('Gemini quota during transcription keeps segment evidence and reaches the queue as a circuit error', async () => {
  const state = { remoteName: 'files/video', evidence: {}, captions: {} };
  let saved;
  await assert.rejects(generateGeminiVideo({
    apiKey: 'test-key', model: 'gemini-test', title: '视频', duration: 40, mimeType: 'video/mp4', includeTranscript: true,
    signal: AbortSignal.timeout(5000), progress: async () => {}, checkpoint: { state, save: async () => { saved = structuredClone(state); } },
    async fetcher(url, options) {
      if (options.method === 'GET') return Response.json({ name: 'files/video', uri: url, state: 'ACTIVE' });
      assert.equal(options.method, 'POST');
      const schema = JSON.parse(options.body).generationConfig.responseSchema;
      if (schema.type === 'ARRAY') return Response.json({}, { status: 429, headers: { 'Retry-After': '9' } });
      const text = JSON.stringify({ spokenNotes: '本段讲解', visualNotes: '本段画面', frameTimes: [], charts: [] });
      return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] });
    },
  }), error => error.status === 429 && error.circuit && error.retryAfterMs === 9000);
  assert.equal(saved.evidence[0].spoken, '本段讲解');
  assert.deepEqual(saved.captions, {});
});

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
          assert.equal(Buffer.from(options.body).toString(), 'video sample data');
          return Response.json({ file: { name: 'files/video', state: 'PROCESSING' } });
        }
        assert.equal(options.headers['x-goog-api-key'], 'test-key');
        if (options.method === 'DELETE') return new Response(null, { status: 204 });
        if (target.pathname === '/upload/v1beta/files') return new Response(null, { headers: { 'x-goog-upload-url': origin + '/upload/v1beta/files?upload_id=test' } });
        if (options.method === 'GET') return Response.json({ name: 'files/video', uri: origin + '/v1beta/files/video', state: 'ACTIVE' });
        const input = JSON.parse(options.body), parts = input.contents[0].parts;
        const answer = text => Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] });
        assert.equal(input.tools, undefined);
        if (!parts[0].fileData) {
          assert.match(parts[0].text, /## 时间导航/);
          assert.match(parts[0].text, /## 复习提纲/);
          assert.match(parts[0].text, /第一段讲解.*第一段画面/);
          assert.match(parts[0].text, /第二段讲解.*第二段画面/);
          assert.match(parts[0].text, /字幕校验摘录/);
          return answer(notes);
        }
        assert.equal(parts[0].fileData.fileUri, origin + '/v1beta/files/video');
        const offset = parts[0].videoMetadata;
        assert.ok(['0s', '180s'].includes(offset.startOffset));
        const tail = offset.startOffset === '180s';
        assert.equal(offset.endOffset, tail ? '185s' : '180s');
        if (input.generationConfig.responseSchema.type === 'ARRAY') {
          return answer(JSON.stringify(tail ? [{ start: 1, end: 4, text: '第二段' }] : [{ start: 3, end: 5, text: '第一段' }]));
        }
        return answer(JSON.stringify(tail
          ? { spokenNotes: '第二段讲解', visualNotes: '第二段画面', frameTimes: [1, 10], charts: [] }
          : { spokenNotes: '第一段讲解', visualNotes: '第一段画面', frameTimes: [9, 3, 3, 999, -10], charts: [
            { time: 3, pillars: ['甲申', '癸酉', '甲寅', '丙寅'], marker: '元男', subject: '案例一', position: '左盘', relation: 'comparison' }
          ] }));
      }
    });
    assert.equal(result.notes, notes);
    assert.deepEqual(result.frameTimes, [3, 9, 181]);
    assert.equal(result.charts[0].marker, '元男');
    assert.deepEqual(result.transcript, [{ start: 3, end: 5, text: '第一段' }, { start: 181, end: 184, text: '第二段' }]);
    assert.deepEqual(calls, ['POST /upload/v1beta/files', 'POST /upload/v1beta/files', 'GET /v1beta/files/video', ...Array(5).fill('POST /v1beta/models/gemini-test:generateContent'), 'DELETE /v1beta/files/video']);
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
      async generate({ checkpoint, file, progress, includeTranscript }) {
        assert.equal((await fs.stat(file)).size, 32);
        assert.equal(store.getRow('owner', gemini).status, 'processing');
        assert.equal(await runGeminiJob(db, directoryFor, () => true, options), false);
        await progress('Gemini 正在观看视频并生成笔记', 70);
        assert.equal(includeTranscript, true);
        if (!checkpoint.state.evidence[0]) {
          checkpoint.state.evidence[0] = { spoken: '第一段讲解' };
          await checkpoint.save();
          throw new Error('第一轮未完成');
        }
        assert.equal(checkpoint.state.evidence[0].spoken, '第一段讲解');
        return { notes, frameTimes: [3], transcript: [{ start: 3, end: 4, text: '一句话' }], warnings: [] };
      }
    };
    assert.equal(await runGeminiJob(db, directoryFor, uid => uid === 'owner', options), true);
    assert.equal(store.getRow('owner', gemini).status, 'failed');
    // Reproduce the persisted lease left behind by a process restart.
    db.prepare("UPDATE knowledge_documents SET status='processing', lease='old-lease', heartbeat=? WHERE id=?")
      .run(new Date(Date.now() - 100_000).toISOString(), gemini);
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

test('Gemini reuses the uploaded video and completed segments, then assembles the full result', async () => {
  const state = {
    remoteName: 'files/video',
    evidence: { 0: { spoken: '已保存的第一段讲解', visual: '第一段画面', frames: [3], charts: [] } },
    captions: { 0: [{ start: 3, end: 5, text: '第一段' }] },
  };
  const saved = [];
  const requests = [];
  const result = await generateGeminiVideo({
    apiKey: 'test-key', model: 'gemini-test', title: '视频', duration: 185, mimeType: 'video/mp4', includeTranscript: true,
    signal: AbortSignal.timeout(5000), progress: async () => {}, wait: async () => {},
    checkpoint: { state, save: async () => saved.push(structuredClone(state)) },
    async fetcher(url, options) {
      if (options.method === 'GET') {
        assert.equal(url, origin + '/v1beta/files/video');
        requests.push('check');
        return Response.json({ name: 'files/video', uri: url, state: 'ACTIVE' });
      }
      if (options.method === 'DELETE') {
        assert.equal(url, origin + '/v1beta/files/video');
        requests.push('delete');
        return new Response(null, { status: 204 });
      }
      assert.equal(url, origin + '/v1beta/models/gemini-test:generateContent');
      const input = JSON.parse(options.body);
      const part = input.contents[0].parts[0];
      let output;
      if (!part.fileData) {
        requests.push('assemble');
        assert.match(part.text, /已保存的第一段讲解/);
        assert.match(part.text, /第二段讲解/);
        output = notes;
      } else {
        assert.equal(part.videoMetadata.startOffset, '180s');
        if (input.generationConfig.responseSchema.type === 'ARRAY') {
          requests.push('captions');
          output = JSON.stringify([{ start: 1, end: 4, text: '第二段' }]);
        } else {
          requests.push('evidence');
          output = JSON.stringify({ spokenNotes: '第二段讲解', visualNotes: '第二段画面', frameTimes: [1], charts: [] });
        }
      }
      return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: output }] } }] });
    },
  });
  assert.deepEqual(requests, ['check', 'evidence', 'captions', 'assemble', 'delete']);
  assert.equal(saved[0].evidence[1].spoken, '第二段讲解');
  assert.deepEqual(saved[1].captions[1], [{ start: 181, end: 184, text: '第二段' }]);
  assert.deepEqual(saved[2].result, result);
  assert.deepEqual(result.frameTimes, [3, 181]);
  assert.deepEqual(result.transcript, [state.captions[0][0], state.captions[1][0]]);
});

test('Gemini requeues quota failures, skips a cooling account/model, and resumes saved evidence', async () => {
  const db = new Database(':memory:');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-cooldown-'));
  const store = createKnowledgeStore(db), directoryFor = id => path.join(root, id);
  const add = async (uid, model) => {
    store.saveSettings(uid, { geminiModel: model });
    const doc = store.create(uid, { backend: 'gemini', title: '视频', originalName: 'source.mp4', mimeType: 'video/mp4', bytes: 32 });
    await fs.mkdir(directoryFor(doc.id));
    await fs.writeFile(path.join(directoryFor(doc.id), 'source'), Buffer.alloc(32));
    store.enqueue(uid, doc.id);
    return doc.id;
  };
  try {
    const first = await add('owner', 'gemini-primary');
    const second = await add('owner', 'gemini-primary');
    const alternate = await add('owner', 'gemini-alternate');
    const other = await add('other', 'gemini-primary');
    [first, second, alternate, other].forEach((id, i) =>
      db.prepare("UPDATE knowledge_documents SET created_at=? WHERE id=?").run('2026-01-01T00:00:0' + i + '.000Z', id));
    let limited = false;
    const accounts = new Map([['owner', { apiKey: 'key-one', fallbackModels: [] }], ['other', { apiKey: 'key-two' }]]);
    const options = { accounts, probe: async () => '60', async generate({ model, apiKey, checkpoint }) {
      if (apiKey === 'key-one' && model === 'gemini-primary') {
        if (!limited) {
          limited = true;
          checkpoint.state.evidence[0] = { spoken: '保留证据' };
          await checkpoint.save();
          throw Object.assign(new Error('429'), { status: 429, circuit: true, dailyQuota: true });
        }
        assert.equal(checkpoint.state.evidence[0]?.spoken, '保留证据');
      }
      return { notes, frameTimes: [], transcript: [], warnings: [] };
    } };
    const next = () => runGeminiJob(db, directoryFor, () => true, options);
    assert.equal(await next(), true);
    assert.equal(store.get('owner', first).status, 'queued');
    assert.match(store.get('owner', first).stage, /HTTP 429.*自动续跑/);
    assert.equal(await next(), true);
    assert.equal(store.get('owner', alternate).status, 'ready');
    assert.equal(await next(), true);
    assert.equal(store.get('other', other).status, 'ready');
    assert.equal(await next(), false);
    assert.equal(store.get('owner', second).status, 'queued');
    db.prepare("UPDATE knowledge_gemini_cooldowns SET retry_at='2020-01-01T00:00:00.000Z'").run();
    assert.equal(await next(), true);
    assert.equal(store.get('owner', first).status, 'ready');
    assert.equal(db.prepare('SELECT count(*) AS count FROM knowledge_gemini_cooldowns').get().count, 0);
  } finally { db.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('Gemini falls back in order without replacing the primary model or starting over', async () => {
  const db = new Database(':memory:');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-fallback-'));
  const store = createKnowledgeStore(db), directoryFor = id => path.join(root, id);
  try {
    store.saveSettings('owner', { geminiModel: 'gemini-primary' });
    const doc = store.create('owner', { backend: 'gemini', title: '视频', originalName: 'source.mp4', mimeType: 'video/mp4', bytes: 32 });
    await fs.mkdir(directoryFor(doc.id));
    await fs.writeFile(path.join(directoryFor(doc.id), 'source'), Buffer.alloc(32));
    store.enqueue('owner', doc.id);
    const calls = [];
    const options = {
      accounts: new Map([['owner', { apiKey: 'key', fallbackModels: ['gemini-first-backup', 'gemini-second-backup'] }]]),
      probe: async () => '365',
      async generate({ checkpoint, model, progress }) {
        calls.push(model);
        if (model === 'gemini-primary') {
          checkpoint.state.evidence[0] = { spoken: '保留证据' };
          checkpoint.state.captions[0] = [{ start: 0, end: 1, text: '保留字幕' }];
          await checkpoint.save();
          throw Object.assign(new Error('429'), { status: 429, circuit: true });
        }
        assert.equal(checkpoint.state.evidence[0].spoken, '保留证据');
        assert.equal(checkpoint.state.captions[0][0].text, '保留字幕');
        if (model === 'gemini-first-backup') throw Object.assign(new Error('404'), { status: 404, circuit: true });
        await progress('整理分段', 70);
        assert.match(store.get('owner', doc.id).stage, /^gemini-second-backup/);
        return { notes, frameTimes: [], transcript: checkpoint.state.captions[0], warnings: [], model };
      },
    };
    const next = () => runGeminiJob(db, directoryFor, () => true, options);
    assert.equal(await next(), true);
    assert.match(store.get('owner', doc.id).stage, /等待备用模型接单/);
    assert.equal(await next(), true);
    assert.equal(await next(), true);
    assert.deepEqual(calls, ['gemini-primary', 'gemini-first-backup', 'gemini-second-backup']);
    const result = store.get('owner', doc.id);
    assert.equal(result.status, 'ready');
    assert.equal(result.modelSettings.geminiModel, 'gemini-primary');
    assert.equal(result.provenance.model, 'gemini-second-backup');
    assert.equal(result.provenance.asrModel, 'gemini-primary');
    assert.match(result.provenance.warnings[0], /gemini-primary.*gemini-second-backup/);
  } finally { db.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('Gemini resumes from Google-confirmed bytes after a lost chunk response', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-resume-'));
  const file = path.join(directory, 'video');
  await fs.writeFile(file, 'abcdefghijklmn');
  const calls = [];
  try {
    const result = await uploadGeminiFile({
      apiKey: 'test-key', file, size: 14, mimeType: 'video/mp4', signal: AbortSignal.timeout(5000),
      progress: async () => {}, wait: async () => {}, chunkBytes: 8,
      async send(url, _stage, { headers, body }) {
        const command = headers['X-Goog-Upload-Command'];
        const offset = headers['X-Goog-Upload-Offset'];
        calls.push([command, offset, Buffer.isBuffer(body) ? body.toString() : '']);
        if (command === 'start') return new Response(null, { headers: {
          'x-goog-upload-url': origin + '/upload/v1beta/files?upload_id=unit-test', 'x-goog-upload-chunk-granularity': '4'
        } });
        assert.equal(headers['x-goog-api-key'], undefined);
        assert.equal(headers['Content-Length'], undefined);
        if (command === 'query') return new Response(null, { headers: { 'x-goog-upload-status': 'active', 'x-goog-upload-size-received': '4' } });
        if (offset === '0') throw Object.assign(new Error('lost chunk response'), { code: 'GEMINI_TRANSPORT' });
        if (command === 'upload') return new Response(null, { headers: { 'x-goog-upload-status': 'active' } });
        return Response.json({ file: { name: 'files/resumed' } });
      }
    });
    assert.deepEqual(result, { name: 'files/resumed' });
    assert.deepEqual(calls, [
      ['start', undefined, ''], ['upload', '0', 'abcdefgh'], ['query', undefined, ''],
      ['upload', '4', 'efghijkl'], ['upload, finalize', '12', 'mn']
    ]);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
