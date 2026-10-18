import { loadConfig } from '../qq-bot/src/config.js';
import { createCodexService } from '../qq-bot/src/codex.js';
import { getDatabase, closeDatabase } from '../shared/db/index.js';

loadConfig();
// Execute the durable queue independently of QQ transport; delivery stays in qq-bot.
const service = createCodexService({ getConfig: loadConfig, executeJobs: true, deliverReplies: false });
service.start();
const timer = setInterval(() => {
  getDatabase().prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('codex_worker_heartbeat',?)").run(String(Date.now()));
}, 10000);
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  service.stop(); clearInterval(timer);
  const drain = setInterval(() => {
    if (!service.status().running) { clearInterval(drain); closeDatabase(); process.exit(0); }
  }, 100);
});
