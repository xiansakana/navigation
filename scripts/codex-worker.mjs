import { loadConfig } from '../qq-bot/src/config.js';
import { createCodexService } from '../qq-bot/src/codex.js';
import { getDatabase, closeDatabase } from '../shared/db/index.js';
import {createCodexAuthMonitor} from '../qq-bot/src/codex-auth-monitor.js';
import {setTimeout as delay} from 'node:timers/promises';

loadConfig();
const databaseBusy=error=>/^SQLITE_BUSY(?:_|$)/.test(error?.code||'');
const startupDeadline=Date.now()+30000;
let db;
for(;;){
  try{db=getDatabase();break;}
  catch(error){
    if(!databaseBusy(error)||Date.now()>=startupDeadline)throw error;
    closeDatabase();await delay(500);
  }
}
// Execute the durable queue independently of QQ transport; delivery stays in qq-bot.
const service = createCodexService({ getConfig: loadConfig, executeJobs: true, deliverReplies: false });
service.start();
const authController=new AbortController();
const authMonitor=createCodexAuthMonitor({db,getConfig:loadConfig,signal:authController.signal});
void authMonitor.tick();
const authTimer=setInterval(()=>void authMonitor.tick(),60000);
const timer = setInterval(() => {
  try{db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('codex_worker_heartbeat',?)").run(String(Date.now()));}
  catch(error){if(!databaseBusy(error))throw error;console.warn('[codex] 工作进程心跳遇到 SQLite 写锁，下次重试');}
}, 10000);
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  service.stop(); clearInterval(timer);clearInterval(authTimer);authController.abort();
  const drain = setInterval(() => {
    if (!service.status().running) { clearInterval(drain); closeDatabase(); process.exit(0); }
  }, 100);
});
