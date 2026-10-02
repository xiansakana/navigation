import test from 'node:test';
import assert from 'node:assert/strict';
import { createYoloBacktestJobs } from './yolo-backtest-jobs.js';

test('jobs return immediately, expose progress, reuse active job and isolate users', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const jobs = createYoloBacktestJobs({ async backtestAsync(user, options, progress) {
    progress({ stage: 'reading', completedDays: 0, totalDays: 1 });
    await pending;
    return { trades: [], user };
  } });
  const job = jobs.start('a', {});
  assert.equal(job.status, 'running');
  assert.equal(job.userId, undefined);
  assert.equal(jobs.start('a', {}).id, job.id);
  assert.equal(jobs.get('b', job.id), null);
  assert.throws(() => jobs.start('b', {}), /另一项/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(jobs.get('a', job.id).progress.stage, 'reading');
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(jobs.get('a', job.id).status, 'completed');
});

test('job failures surface an error instead of hanging', async () => {
  const jobs = createYoloBacktestJobs({ async backtestAsync() { throw new Error('test failure'); } });
  const job = jobs.start('a', {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(jobs.get('a', job.id).status, 'failed');
  assert.equal(jobs.get('a', job.id).error, 'test failure');
});
