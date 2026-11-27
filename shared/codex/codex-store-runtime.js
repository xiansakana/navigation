import { getDatabase } from '../db/index.js';
import { createCodexStore } from './codex-store.js';
import { createPostgresCodexStore } from './codex-postgres-store.js';

// Codex queue, conversations, todos and attachment state use PostgreSQL when a
// monitoring/queue connection is configured; SQLite remains the test/rollback path.
export function createCodexStoreRuntime({ getPostgresDatabase, formatReply } = {}) {
  let pending;
  const sqlite = () => createCodexStore(getDatabase(), { formatReply });
  return {
    async get() {
      if (!getPostgresDatabase) return sqlite();
      pending ||= (async () => {
        const database = await getPostgresDatabase();
        return database ? createPostgresCodexStore(database, { formatReply }) : null;
      })().then(store => store || sqlite()).catch(error => {
        pending = undefined;
        throw error;
      });
      return pending;
    },
  };
}
