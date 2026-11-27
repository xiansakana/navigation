import { postgresUrlFor } from '../../shared/db/postgres/config.js';
import { createCodexStoreRuntime } from '../../shared/codex/codex-store-runtime.js';
import { portalPostgresDatabase } from './postgres.js';

let runtime;
export function portalCodexStore() {
  runtime ||= createCodexStoreRuntime({
    getPostgresDatabase: async () => {
      const url = postgresUrlFor('qqMonitoring');
      return url ? portalPostgresDatabase(url) : null;
    },
  });
  return runtime;
}
