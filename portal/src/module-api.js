import { findModuleApi } from './modules.js';
import { forwardTornWorker, TORN_WORKER_MODULES } from './torn-worker-transport.js';
import { handleTornChainApi } from './torn-chain.js';
import { handleFactionApi } from './torn-factions.js';
import { handleBlogApi } from './blog.js';
import { handleResourceApi } from './resources.js';
import { handleBookkeepingApi } from './bookkeeping.js';
import { handleMingliApi } from './mingli.js';
import { handleKnowledgeApi } from './knowledge.js';
import { handleQqCodexApi } from './qq-codex.js';
import { handleCodexCliApi } from './codex-cli.js';

import { handleTornShoppingApi } from './torn-shopping.js';
import { handleTornUsersApi } from './torn-users.js';
const handlers = {
  'torn-users': (req,res,url,session,deps) => handleTornUsersApi(req,res,url,session,deps.json,deps.config),
  'torn-shopping': (req,res,url,session,deps) => handleTornShoppingApi(req,res,url,session,deps.json,deps.config),
  'torn-factions': (req, res, url, session, deps) => handleFactionApi(req, res, url, session, deps.json, deps.config),
  'torn-chain': (req, res, url, session, deps) => handleTornChainApi(req, res, url, session, deps.json, deps.config),
  blog: (req, res, url, session, deps) => handleBlogApi(req, res, url, session, deps.json, deps.config),
  resources: (req, res, url, session, deps) => handleResourceApi(req, res, session, deps.resourceMonitor, deps.json),
  bookkeeping: (req, res, url, session, deps) => handleBookkeepingApi(req, res, url, session, deps.json),
  mingli: (req, res, url, session, deps) => handleMingliApi(req, res, url, session, deps.json),
  knowledge: (req, res, url, session, deps) => handleKnowledgeApi(req, res, url, session, deps.json),
  'qq-codex': (req, res, url, session, deps) => handleQqCodexApi(req, res, url, session, deps.json),
  'codex-cli': (req, res, url, session, deps) => handleCodexCliApi(req, res, url, session, deps.json)
};

export function moduleApiHandler(pathname) {
  const module = findModuleApi(pathname);
  if (module && TORN_WORKER_MODULES.includes(module.id)) return (req, res, url, session, deps) => {
    if (deps.config.runtime?.tornMonitorWorker && process.env.NAVIGATION_PROCESS_ROLE !== 'torn-monitor-worker') return forwardTornWorker(req, res, url, session, deps);
    return handlers[module.id](req, res, url, session, deps);
  };
  return module && handlers[module.id];
}
