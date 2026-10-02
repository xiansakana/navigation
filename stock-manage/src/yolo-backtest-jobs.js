import { randomUUID } from 'node:crypto';

// Bounded, user-isolated in-memory jobs. Restarting the service invalidates them.
export function createYoloBacktestJobs(store) {
  const jobs = new Map();
  function view(job) {
    const { userId, ...publicJob } = job;
    return publicJob;
  }
  function start(userId, options) {
    const now = Date.now();
    for (const [id, job] of jobs) {
      if (job.status !== 'running' && now - job.updatedAt > 15 * 60 * 1000) jobs.delete(id);
    }
    const active = [...jobs.values()].find((job) => job.status === 'running');
    if (active?.userId === userId) return view(active);
    if (active) throw Object.assign(new Error('服务正在处理另一项回测，请稍后再试。'), { status: 429 });
    if (jobs.size >= 10) jobs.delete(jobs.keys().next().value);
    const job = { id: randomUUID(), userId, status: 'running', startedAt: now, updatedAt: now,
      progress: { stage: '准备回测', completedDays: 0, totalDays: 0, quoteRows: 0, diagnostics: [] } };
    jobs.set(job.id, job);
    setImmediate(async () => {
      try {
        job.result = await store.backtestAsync(userId, options, (progress) => {
          job.progress = progress;
          job.updatedAt = Date.now();
        });
        job.status = 'completed';
        job.progress.stage = '回测完成';
      } catch (error) {
        job.status = 'failed';
        job.error = error.message || '回测失败';
      }
      job.updatedAt = Date.now();
    });
    return view(job);
  }
  function get(userId, id) {
    const job = jobs.get(id);
    return job?.userId === userId ? view(job) : null;
  }
  return { start, get };
}
