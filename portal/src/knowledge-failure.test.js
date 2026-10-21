import test from 'node:test';
import assert from 'node:assert/strict';
import { failureMessage, interruptedTransfer } from '../public/knowledge/failure.js';

test('interrupted transfer errors explain uncertainty and stage while other diagnostics remain unchanged', () => {
  assert.match(failureMessage('terminated'), /网络连接在传输完成前中断/);
  assert.match(failureMessage('terminated', '下载视频'), /下载视频/);
  assert.match(failureMessage('terminated'), /无法确定具体原因/);
  assert.equal(failureMessage('CUDA out of memory'), 'CUDA out of memory');
  assert.equal(interruptedTransfer(Object.assign(new Error('fetch failed'), { cause: { code: 'UND_ERR_SOCKET' } })), true);
  assert.equal(interruptedTransfer(new Error('模型输出格式错误')), false);
});
