import { Readable } from 'node:stream';
import { TORN_WORKER_MODULES } from './torn-worker-transport.js';

export function tickTornWorker(runtime, db, report = console.error) {
  try {
    runtime.reconcile();
    db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('torn_monitor_worker_heartbeat',?)").run(String(Date.now()));
    return true;
  } catch (error) {
    // Other services share SQLite. A delayed heartbeat must not terminate five scans.
    if (!['SQLITE_BUSY', 'SQLITE_LOCKED'].includes(error.code)) report('Torn worker heartbeat failed; retrying next tick');
    return false;
  }
}

// Intent is durable; live counters remain in the worker. Shutdown never clears intent.
export function createTornWorkerRuntime({ runs, dispatch, sessionFor, jobs, config }) {
  let closing = false;
  const queues = new Map();
  async function execute(message) {
    if (closing) return { status: 503, body: { ok: false, error: '监控进程正在重启' } };
    const url = new URL(message.path, 'http://127.0.0.1');
    const module = TORN_WORKER_MODULES.find(id => url.pathname.startsWith('/api/' + id + '/'));
    if (!module || !['GET', 'POST', 'PUT', 'DELETE'].includes(message.method) || !message.session?.userId) return { status: 403, body: { ok: false, error: '无权执行此操作' } };
    const req = Readable.from(message.body === null ? [] : [Buffer.from(JSON.stringify(message.body))]);
    req.method = message.method; req.url = message.path; req.headers = message.headers || {};
    let result;
    await dispatch(req, { setHeader() {} }, url, message.session, { config, json: (_res, status, body) => { result = { status, body }; } });
    if (!result) throw new Error('Missing worker result');
    if (message.method === 'GET' && result.body.state && !result.body.state.running && !result.body.state.error) {
      const saved = runs.list().find(row => row.module === module && row.user_id === message.session.userId);
      if (saved?.error) result.body.state.error = saved.error;
    }
    if (result.status < 300 && result.body.ok && message.method === 'POST') {
      const action = url.pathname.split('/').at(-1);
      if (['start', 'stop', 'config', 'reset'].includes(action)) runs.set(module, message.session.userId, action === 'start');
    }
    return result;
  }
  return {
    dispatch(message) {
      // Serialize controls/configuration with reads so late completions cannot undo a stop.
      const key = message.session?.userId + ':' + message.path.split('/')[2];
      const previous = queues.get(key) || Promise.resolve();
      const job = previous.catch(() => {}).then(() => execute(message));
      queues.set(key, job);
      job.finally(() => { if (queues.get(key) === job) queues.delete(key); }).catch(() => {});
      return job;
    },
    async resume() {
      for (const row of runs.list().filter(row => row.desired && TORN_WORKER_MODULES.includes(row.module))) {
        const session = sessionFor(row.user_id);
        if (!session || session.isGuest) { runs.set(row.module, row.user_id, false, '账号不可用'); continue; }
        try {
          const result = await this.dispatch({ method: 'POST', path: '/api/' + row.module + '/start', session, headers: { host: '127.0.0.1' }, body: {} });
          if (result.status >= 300 || !result.body.ok) runs.set(row.module, row.user_id, false, result.body.error || '恢复失败');
        } catch { runs.set(row.module, row.user_id, false, '恢复失败，请检查权限或配置后重新启动'); }
      }
    },
    reconcile() {
      if (closing) return;
      for (const [module, map] of Object.entries(jobs())) for (const [uid, job] of map) {
        const state = job.status();
        if (!state.running && !state.busy && runs.list().some(row => row.module === module && row.user_id === uid && row.desired)) runs.set(module, uid, false, state.error || '任务已停止');
      }
    },
    async close() {
      closing = true;
      await Promise.allSettled([...queues.values()]);
      const all = Object.values(jobs()).flatMap(map => [...map.values()]);
      all.forEach(job => job.stop());
      await Promise.allSettled(all.map(job => job.promise));
    }
  };
}
