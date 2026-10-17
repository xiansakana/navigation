import test from 'node:test';
import assert from 'node:assert/strict';
import { uploadParts } from '../public/knowledge/upload.js';

test('three upload lanes skip acknowledged chunks and report exact resumed byte totals', async () => {
  const file = new Blob(['abcdefghijklmn']);
  let active = 0, maximum = 0;
  const sent = [], reports = [];
  await uploadParts({ file, chunkBytes: 3, parts: [{ part: 2, bytes: 3 }], url: '/parts/', onProgress: p => reports.push(p),
    async send(url, blob, { onProgress }) {
      active++; maximum = Math.max(maximum, active); sent.push(Number(url.split('/').pop()));
      onProgress(blob.size);
      await new Promise(resolve => setTimeout(resolve, 10)); active--;
    }
  });
  assert.equal(maximum, 3);
  assert.deepEqual(sent.sort(), [1, 3, 4, 5]);
  assert.equal(reports[0].loaded, 3);
  assert.equal(reports.at(-1).completed, 14);
  assert.ok(reports.every(p => p.loaded <= p.total && p.remaining >= 0 && Number.isFinite(p.speed)));
});

test('a transient chunk failure retries without double-counting committed bytes', async () => {
  let attempts = 0, final;
  await uploadParts({ file: new Blob(['abc']), chunkBytes: 3, parts: [], url: '/parts/', retryDelay: 0, onProgress: p => { final = p; },
    async send(url, blob, { onProgress }) {
      onProgress(blob.size);
      if (++attempts === 1) throw Object.assign(new Error('network'), { retryable: true });
    }
  });
  assert.equal(attempts, 2); assert.equal(final.completed, 3); assert.equal(final.loaded, 3);
});

test('terminal errors cancel other lanes and settle them before a resume can start', async () => {
  let active = 0, calls = 0;
  await assert.rejects(uploadParts({ file: new Blob(['abcdefghijk']), chunkBytes: 2, parts: [], url: '/parts/', retryDelay: 0,
    async send(url, blob, { signal }) {
      calls++; active++;
      try {
        if (url.endsWith('/1')) { await new Promise(resolve => setTimeout(resolve, 5)); throw Object.assign(new Error('permission denied'), { retryable: false }); }
        await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      } finally { active--; }
    }
  }), /permission denied/);
  assert.equal(active, 0); assert.equal(calls, 3);
});

test('a fully acknowledged upload sends no chunks', async () => {
  await uploadParts({ file: new Blob(['abc']), chunkBytes: 3, parts: [{ part: 1 }], url: '/parts/', send: () => assert.fail('already uploaded') });
});
