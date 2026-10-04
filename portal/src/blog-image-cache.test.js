import test from 'node:test';
import assert from 'node:assert/strict';
import { imageCacheHeaders, respondImageNotModified } from './blog-image-cache.js';

test('image cache revalidates private content and returns bodyless responses for matching versions', () => {
  const headers = imageCacheHeaders('image-url-a');
  assert.equal(headers['Cache-Control'], 'private, no-cache, must-revalidate');
  assert.equal(headers.Vary, 'Cookie');
  assert.notEqual(headers.ETag, imageCacheHeaders('image-url-b').ETag);
  let status, ended = false;
  const res = { writeHead(code, output) { status = code; assert.deepEqual(output, headers); }, end() { ended = true; } };
  assert.equal(respondImageNotModified({ headers: { 'if-none-match': '"old", W/' + headers.ETag } }, res, headers), true);
  assert.equal(status, 304); assert.equal(ended, true);
  for (const requestHeaders of [{}, { 'if-none-match': '"wrong"' }, { 'if-none-match': headers.ETag, range: 'bytes=0-99' }]) {
    assert.equal(respondImageNotModified({ headers: requestHeaders }, res, headers), false);
  }
});
