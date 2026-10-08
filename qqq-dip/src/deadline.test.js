import test from 'node:test';
import assert from 'node:assert/strict';
import { withDeadline } from './deadline.js';

test('a hung operation times out even when cancellation does not settle it', async () => {
  let aborted = false;
  await assert.rejects(
    withDeadline(() => new Promise(() => {}), 15, '行情', () => { aborted = true; }),
    { name: 'TimeoutError' }
  );
  assert.equal(aborted, true);
});

test('late rejection after timeout is consumed', async () => {
  let rejectLate;
  const pending = new Promise((_, reject) => { rejectLate = reject; });
  await assert.rejects(withDeadline(() => pending, 15, '行情'), /超时/);
  rejectLate(new Error('late network error'));
  await new Promise((resolve) => setImmediate(resolve));
});
