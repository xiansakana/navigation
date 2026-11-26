import { loadConfig } from '../qq-bot/src/config.js';
import { createCodexService } from '../qq-bot/src/codex.js';
import { getDatabase, closeDatabase } from '../shared/db/index.js';
import {createCodexAuthMonitor} from '../qq-bot/src/codex-auth-monitor.js';
import {setTimeout as delay} from 'node:timers/promises';
import { getPostgresMonitoring } from '../qq-bot/src/postgres.js';

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
const monitoringDb = await getPostgresMonitoring();
const authMonitor=createCodexAuthMonitor({db: monitoringDb || db,getConfig:loadConfig,signal:authController.signal});
void authMonitor.tick();
const authTimer=setInterval(()=>void authMonitor.tick(),60000);
let heartbeatBusy = false;
const timer = setInterval(async () => {
  if (heartbeatBusy) return;
  heartbeatBusy = true;
  try {
    const at = String(Date.now());
    if (monitoringDb) await monitoringDb.query("INSERT INTO navigation.meta(key,value) VALUES('codex_worker_heartbeat',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [at]);
    else db.prepare("INSERT INTO meta(key,value) VALUES('codex_worker_heartbeat',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(at);
  } catch (error) {
    console.warn('[codex] 工作进程心跳未保存，下次重试', error.code || error.name);
  } finally { heartbeatBusy = false; }
}, 10000);
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  service.stop(); clearInterval(timer);clearInterval(authTimer);authController.abort();
  const drain = setInterval(() => {
    if (!service.status().running && !heartbeatBusy) { clearInterval(drain); closeDatabase(); process.exit(0); }
  }, 100);
});
