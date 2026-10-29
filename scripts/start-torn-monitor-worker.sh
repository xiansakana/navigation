#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
migrating=false
if ! node --input-type=module -e "import {loadConfig} from './portal/src/config.js';process.exit(loadConfig().runtime?.tornMonitorWorker?0:1)"; then
  node scripts/migrate-torn-monitor-worker.mjs --apply
  migrating=true
  # Old Portal holds scan instances; stop it before starting the new owner.
  pm2 stop portal
fi
for old in torn-company torn-undercut; do
  if pm2 describe "$old" >/dev/null 2>&1; then pm2 stop "$old"; fi
done
cd "$ROOT/portal"
npm install --omit=dev
cd "$ROOT"
if pm2 describe torn-monitor-worker >/dev/null 2>&1; then
  pm2 restart torn-monitor-worker
else
  pm2 start "$ROOT/scripts/torn-monitor-worker.mjs" --cwd "$ROOT" --name torn-monitor-worker --kill-timeout 35000
fi
node --input-type=module -e '
  import {setTimeout} from "node:timers/promises";
  import {loadConfig} from "./portal/src/config.js";
  import {tornWorkerPort} from "./portal/src/torn-worker-transport.js";
  const url="http://127.0.0.1:"+tornWorkerPort(loadConfig())+"/healthz";
  let ok=false;
  for(let i=0;i<90;i++){try{const r=await fetch(url,{signal:AbortSignal.timeout(2000)});if(r.ok&&(await r.json()).ok){ok=true;break;}}catch{}await setTimeout(500);}
  if(!ok)throw Error("Torn worker readiness failed; inspect PM2 logs, do not run old monitors in parallel");
'
for old in torn-company torn-undercut; do
  if pm2 describe "$old" >/dev/null 2>&1; then pm2 delete "$old"; fi
done
if [ "$migrating" = true ]; then pm2 restart portal; fi
pm2 save
