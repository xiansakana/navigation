import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bilibiliUrl, inspectBilibili, selectStreams, mediaUrl, downloadBilibili, IMPORT_LIMIT } from './knowledge-bilibili.js';

const url = 'https://www.bilibili.com/video/BV1LTpi69Efh/';
const view = { bvid: 'BV1LTpi69Efh', title: '八字课程', duration: 90, owner: { name: '作者' }, pages: [{ page: 1, cid: 12, duration: 90 }, { page: 2, cid: 13, duration: 30, part: '第二节' }] };
const streams = { dash: { video: [{ height: 1080, codecid: 7, bandwidth: 9, baseUrl: 'https://test.bilivideo.com/video' }], audio: [{ bandwidth: 4, baseUrl: 'https://test.bilivideo.com/audio' }] } };
const json = data => new Response(JSON.stringify({ code: 0, data }));
function fetcher(target) {
  if (target.includes('/view?')) return json(view);
  if (target.includes('/tags?')) return json([{ tag_name: '四柱' }, { tag_name: '学习' }]);
  if (target.includes('/playurl?')) return json(streams);
  if (target.includes('test.bilivideo.com')) return new Response('mock media');
  throw new Error('unexpected URL ' + target);
}
test('canonical Bilibili links accept share text, AV/BV and selected part; reject arbitrary targets', () => {
  assert.equal(bilibiliUrl('分享标题 ' + url + '?spm_id_from=123'), url);
  assert.equal(bilibiliUrl('https://m.bilibili.com/video/av123?p=02'), 'https://www.bilibili.com/video/av123/?p=2');
  for (const value of ['http://127.0.0.1/video/BV1LTpi69Efh/', 'https://www.bilibili.com.evil/video/BV1LTpi69Efh/', 'https://user@www.bilibili.com/video/BV1LTpi69Efh/', url + '?p=0', url + '?p=abc', 'file:///etc/passwd']) assert.throws(() => bilibiliUrl(value));
  assert.throws(() => mediaUrl('http://test.bilivideo.com/a'));
  assert.throws(() => mediaUrl('https://127.0.0.1/a'));
});
test('metadata preserves UTF8, derives topic/tags, and binds the selected part rather than whole playlist', async () => {
  const m = await inspectBilibili(url + '?p=2', { fetcher });
  assert.equal(m.title, '八字课程 · P2 第二节'); assert.equal(m.cid, 13); assert.equal(m.duration, 30);
  assert.equal(m.topic, '命理'); assert.deepEqual(m.tags, ['四柱', '学习']); assert.equal(m.sourceUrl, url + '?p=2');
  const missingTags = await inspectBilibili(url, { fetcher: u => u.includes('/tags?') ? Promise.reject(new Error('offline')) : fetcher(u) });
  assert.deepEqual(missingTags.tags, []); assert.equal(missingTags.warnings.length, 1);
});
test('shortlink redirects are checked before fetching their destination, and errors cannot become metadata', async () => {
  const seen = [];
  await assert.rejects(inspectBilibili('https://b23.tv/abcd', { fetcher: u => { seen.push(u); return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }); } }));
  assert.deepEqual(seen, ['https://b23.tv/abcd']);
  await assert.rejects(inspectBilibili(url, { fetcher: () => new Response(JSON.stringify({ code: -403 })) }), /访问权限/);
  assert.throws(() => selectStreams({ ...streams, is_preview: 1 }), /试看/);
  assert.throws(() => selectStreams({ dash: {} }), /音视频流/);
});
test('stream downloads enforce aggregate size and CDN redirects, mux audio/video without passing remote URLs to ffmpeg', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bili-import-'));
  try {
    let args;
    const result = await downloadBilibili(url, directory, { fetcher, async run(binary, input) {
      args = input; await fs.writeFile(input.at(-1), Buffer.alloc(32));
    } });
    assert.equal(result.bytes, 32); assert.ok(args.includes('1:a:0')); assert.ok(!args.some(a => a.startsWith('https://')));
    await result.cleanup();
    await assert.rejects(downloadBilibili(url, directory, { fetcher: u => u.includes('test.bilivideo.com') ? new Response('small', { headers: { 'content-length': String(IMPORT_LIMIT + 1) } }) : fetcher(u) }), /1GB/);
    await assert.rejects(downloadBilibili(url, directory, { fetcher: u => u.includes('test.bilivideo.com') ? new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/' } }) : fetcher(u) }), /域名/);
    assert.deepEqual(await fs.readdir(directory), []);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
