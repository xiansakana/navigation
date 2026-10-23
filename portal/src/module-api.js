import { findModuleApi } from './modules.js';
import { handleTornChainApi } from './torn-chain.js';
import { handleBlogApi } from './blog.js';
import { handleResourceApi } from './resources.js';
import { handleBookkeepingApi } from './bookkeeping.js';
import { handleMingliApi } from './mingli.js';
import { handleKnowledgeApi } from './knowledge.js';
import { handleQqCodexApi } from './qq-codex.js';
import { handleCodexCliApi } from './codex-cli.js';

const handlers = {
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
  return module && handlers[module.id];
}
