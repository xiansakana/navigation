import { requestDataAccess, scopedSession } from './data-access.js';
import { canTornShopping } from './torn-shopping.js';
import { canTornChain } from './torn-chain.js';

// Entry visibility is authorization, never a health check of the scanning worker.
export function tornToolboxAccess(req, session, config, accessFor = requestDataAccess) {
  const allowed = (module, canView) => {
    try { return canView(scopedSession(session, accessFor(req, session, module, config, 'read'))); }
    catch { return false; }
  };
  return { shopping: allowed('torn-shopping', canTornShopping), chain: allowed('torn-chain', canTornChain) };
}
