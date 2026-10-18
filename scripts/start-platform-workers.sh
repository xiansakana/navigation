#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if node --input-type=module -e "import {loadConfig} from './portal/src/config.js';process.exit(loadConfig().runtime?.externalWorkers?0:1)"; then
  if pm2 describe portal-background >/dev/null 2>&1; then
    pm2 restart portal-background
  else
    pm2 start "$ROOT/portal/src/background.js" --cwd "$ROOT/portal" --name portal-background --kill-timeout 3600000
  fi
fi
if node --input-type=module -e "import {codexConfig} from './shared/runtime-config.js';process.exit(codexConfig()?.externalExecutor?0:1)"; then
  if pm2 describe codex-worker >/dev/null 2>&1; then
    pm2 restart codex-worker
  else
    pm2 start "$ROOT/scripts/codex-worker.mjs" --cwd "$ROOT/qq-bot" --name codex-worker --kill-timeout 30000
  fi
fi
