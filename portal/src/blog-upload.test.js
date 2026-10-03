import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('bounded parallel uploads retain selected order and settle running uploads before reporting partial failure', async () => {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(new URL('../public/blog-upload.js', import.meta.url), 'utf8'), context);
  const upload = context.window.runBlogUploads;
  let active = 0, maximum = 0;
  const results = await upload([0, 1, 2, 3], async value => {
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, value === 0 ? 20 : 1));
    active--; return { value };
  }, 2);
  assert.equal(maximum, 2); assert.deepEqual(Array.from(results, r => r.value), [0, 1, 2, 3]);
  let finished = false;
  await assert.rejects(upload([0, 1, 2], async value => {
    if (value === 0) throw new Error('上传失败');
    await new Promise(resolve => setTimeout(resolve, 10)); finished = true; return { value };
  }, 2), error => {
    assert.equal(finished, true);
    assert.deepEqual(Array.from(error.uploaded, r => r.value), [1]);
    return true;
  });
});
