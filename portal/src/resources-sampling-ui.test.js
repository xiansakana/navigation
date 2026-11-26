import assert from 'node:assert/strict';
import test from 'node:test';
import { createSampling } from '../public/resources/sampling.js';

test('sampling coalesces a manual refresh and aborts on page disposal', async () => {
  const document = Object.assign(new EventTarget(), { hidden: false });
  const busy = [];
  let pending;
  let requests = 0;
  const schedule = createSampling({
    document,
    sample(signal) {
      pending = signal;
      requests++;
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
    onSample() { assert.fail('disposed page must not render'); },
    onError() { assert.fail('disposed page must not show an error'); },
    onBusy(value) { busy.push(value); }
  });
  try {
    const request = schedule.refresh();
    await schedule.refresh();
    assert.equal(requests, 1);
    schedule.dispose();
    await request;
    assert.equal(pending.aborted, true);
    assert.deepEqual(busy, [true]);
  } finally {
    schedule.dispose();
  }
});
