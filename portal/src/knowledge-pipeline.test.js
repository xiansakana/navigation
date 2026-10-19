import test from 'node:test';
import assert from 'node:assert/strict';
import { createStageGate, workerPortalRequest } from './knowledge-model.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { getDatabase, closeDatabase } from '../../shared/db/index.js';
import { createKnowledgeStore } from './knowledge-store.js';
import { handleKnowledgeWorkerApi } from './knowledge.js';

test('worker retries explicit storage busy responses using identical payload, but never blindly repeats claims', async () => {
  const options = { method: 'POST', body: '{"backends":["codex"]}' }, delays = [], requests = [];
  const r = await workerPortalRequest('https://test/api/knowledge/worker/claim', options, { wait: async ms => delays.push(ms), fetch: async (url, input) => {
    requests.push(input.body);
    return requests.length < 3 ? new Response(JSON.stringify({ code: 'KNOWLEDGE_BUSY' }), { status: 503 }) : new Response('{"ok":true}');
  } });
  assert.equal(r.status, 200); assert.deepEqual(delays, [1000, 2000]); assert.equal(new Set(requests).size, 1);
  let calls = 0;
  await assert.rejects(workerPortalRequest('https://test/claim', options, { fetch: async () => { calls++; return new Response('{"error":"bad input"}', { status: 400 }); } }), /400：bad input/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(workerPortalRequest('https://test/claim', options, { fetch: async () => { calls++; throw new Error('network'); } }), /network/);
  assert.equal(calls, 1);
  await assert.rejects(workerPortalRequest('https://test/phase', options, { retries: 1, wait: async () => {}, fetch: async () => new Response('{"code":"KNOWLEDGE_BUSY"}', { status: 503 }) }), /503/);
});

test('summary slots are FIFO, cancelled waiters do not block others and lower limits drain safely', async () => {
  const gate = createStageGate(2), first = await gate.acquire(), second = await gate.acquire();
  let thirdStarted = false, fourthStarted = false;
  const aborted = new AbortController();
  const third = gate.acquire(aborted.signal).then(() => { thirdStarted = true; });
  const thirdRejected = assert.rejects(third, /cancelled/);
  const fourth = gate.acquire().then(release => { fourthStarted = true; return release; });
  gate.setLimit(1); first(); first(); await Promise.resolve(); assert.equal(fourthStarted, false);
  aborted.abort(new Error('cancelled')); await thirdRejected;
  second(); const releaseFourth = await fourth;
  assert.equal(thirdStarted, false); assert.equal(fourthStarted, true);
  const alreadyAborted = new AbortController(); alreadyAborted.abort(new Error('cancelled'));
  await assert.rejects(gate.acquire(alreadyAborted.signal), /cancelled/);
  let fifthStarted = false;
  const fifth = gate.acquire().then(release => { fifthStarted = true; return release; });
  await Promise.resolve(); assert.equal(fifthStarted, false);
  gate.setLimit(2); const releaseFifth = await fifth; assert.equal(fifthStarted, true);
  releaseFourth(); releaseFifth();
});

test('real worker loop overlaps next video media with two summaries and isolates a failed summary', { timeout: 30000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-pipeline-'));
  const previous = { db: process.env.NAVIGATION_DB_PATH, media: process.env.KNOWLEDGE_DATA_DIR };
  process.env.NAVIGATION_DB_PATH = path.join(root, 'db.sqlite'); process.env.KNOWLEDGE_DATA_DIR = path.join(root, 'media');
  const media = [], summaries = [], errors = [];
  let failFirstComplete = true;
  const store = createKnowledgeStore(getDatabase()), token = store.rotateToken('a');
  const ids = [];
  for (let i = 0; i < 3; i++) { const d = store.create('a', { title: 'lesson ' + i, bytes: 24, mimeType: 'video/mp4', originalName: 'lesson.mp4' }); store.enqueue('a', d.id); ids.push(d.id); }
  const server = http.createServer(async (req, res) => {
    if (req.url.startsWith('/test/media')) { media.push(res); return; }
    if (req.url.startsWith('/test/summary')) { summaries.push(res); return; }
    if (req.url === '/api/knowledge/worker/jobs/' + ids[0] + '/complete' && failFirstComplete) {
      failFirstComplete = false;
      for await (const chunk of req) { /* Consume the failed submission. */ }
      res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":"injected submission failure"}'); return;
    }
    const json = (r, status, data) => { r.writeHead(status, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(data)); };
    try { await handleKnowledgeWorkerApi(req, res, new URL(req.url, 'http://' + req.headers.host), json, () => true); }
    catch (e) { errors.push(e.message); json(res, 500, { error: e.message }); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  let child, output = '';
  const waitFor = async predicate => {
    const until = Date.now() + 18000;
    while (!predicate()) {
      if (Date.now() > until || child?.exitCode != null) throw new Error('Pipeline did not reach expected state: ' + output.slice(-2000));
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  try {
    await fs.mkdir(path.join(root, 'scripts'), { recursive: true }); await fs.mkdir(path.join(root, 'portal/src'), { recursive: true });
    await fs.copyFile(new URL('../../scripts/knowledge-worker.mjs', import.meta.url), path.join(root, 'scripts/knowledge-worker.mjs'));
    await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}');
    // Only external media/model work is stubbed; run the real worker loop, lease API,
    // database slot admission, phase handoff, result validation and failure path.
    const gateSource = createStageGate.toString();
    await fs.writeFile(path.join(root, 'portal/src/knowledge-model.js'), `
import fs from 'node:fs/promises'; import path from 'node:path';
export const createStageGate = ${gateSource};
export const workerPortalRequest = ${workerPortalRequest.toString()};
export const resolveCodexBinary = () => 'stub';
export const modelConfiguration = () => { throw new Error('No API'); };
export async function runProcess(binary, args, options = {}) {
  if (String(args[0]).endsWith('video_runtime.py')) return 'cuda';
  if (String(args[0]).endsWith('video_evidence.py')) {
    await fetch(process.env.PIPELINE_TEST_ORIGIN + '/test/media');
    const directory = args[args.indexOf('--output') + 1];
    await fs.writeFile(path.join(directory, 'evidence.json'), JSON.stringify({duration:30, language:'zh', transcript:[], frames:[]}));
    options.onLine(JSON.stringify({stage:'素材提取完成',progress:65}));
  }
  return '--ignore-user-config --ignore-rules';
}
export async function summarizeVideo(config, job) {
  const response = await fetch(process.env.PIPELINE_TEST_ORIGIN + '/test/summary?id=' + job.id);
  if (!response.ok) throw new Error('injected summary failure');
  return {notes:'# Pipeline test notes\\nThis is a complete note generated by the controlled test model.',provenance:{backend:'codex',model:'stub',vision:false}};
}`);
    await fs.writeFile(path.join(root, 'portal/src/knowledge-download.js'), "export async function downloadVideo(job,target){return target;}");
    await fs.writeFile(path.join(root, 'portal/src/knowledge-local-input.js'), 'export const startLocalInputServer=()=>{},localDocuments=()=>[],verifyLocalInput=()=>true,pruneLocalInputs=()=>{};');
    const config = path.join(root, 'config.json'); await fs.writeFile(config, JSON.stringify({ portalUrl: origin, token, localUpload: false, workDir: path.join(root, 'work') }));
    child = spawn(process.execPath, [path.join(root, 'scripts/knowledge-worker.mjs'), config], { windowsHide: true, env: { ...process.env, PIPELINE_TEST_ORIGIN: origin } });
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    await waitFor(() => media.length === 1); assert.equal(summaries.length, 0);
    media[0].end('ok'); await waitFor(() => summaries.length === 1 && media.length === 2);
    assert.equal(store.get('a', ids[0]).processingPhase, 'summary');
    media[1].end('ok'); await waitFor(() => summaries.length === 2 && media.length === 3);
    assert.equal(store.get('a', ids[1]).processingPhase, 'summary');
    media[2].end('ok'); await waitFor(() => store.get('a', ids[2]).processingPhase === 'summary_wait');
    assert.equal(summaries.length, 2, 'third summary waits for its own slot');
    summaries[1].writeHead(500); summaries[1].end('injected failure');
    await waitFor(() => summaries.length === 3 && store.get('a', ids[1]).status === 'failed');
    assert.equal(store.get('a', ids[0]).status, 'processing');
    summaries[0].end('ok'); summaries[2].end('ok');
    await waitFor(() => store.get('a', ids[0]).status === 'failed' && store.get('a', ids[2]).status === 'ready');
    assert.ok(store.retry('a', ids[0], 'codex'));
    await waitFor(() => store.get('a', ids[0]).status === 'ready');
    assert.equal(media.length, 3, 'completed media is reused');
    assert.equal(summaries.length, 3, 'completed summary is resubmitted without another model call');
    assert.deepEqual(errors, []);
  } finally {
    if (child && child.exitCode == null) { const exit = once(child, 'exit'); child.kill(); await exit; }
    for (const res of [...media, ...summaries]) if (!res.writableEnded) res.end();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); closeDatabase();
    if (previous.db === undefined) delete process.env.NAVIGATION_DB_PATH; else process.env.NAVIGATION_DB_PATH = previous.db;
    if (previous.media === undefined) delete process.env.KNOWLEDGE_DATA_DIR; else process.env.KNOWLEDGE_DATA_DIR = previous.media;
    assert.equal(path.dirname(root), os.tmpdir()); await fs.rm(root, { recursive: true, force: true });
  }
});
