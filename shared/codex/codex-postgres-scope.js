import { AsyncLocalStorage } from 'node:async_hooks';

// One scope per database handle so the queue, conversations, todos and the
// composed store share the same transaction when nested calls are awaited.
const scopes = new WeakMap();

export function postgresCodexScope(db) {
  let scope = scopes.get(db);
  if (!scope) {
    const storage = new AsyncLocalStorage();
    scope = {
      client: () => storage.getStore() || db,
      async run(run) {
        if (storage.getStore()) return run(storage.getStore());
        return db.transaction(client => storage.run(client, () => run(client)));
      },
    };
    scopes.set(db, scope);
  }
  return scope;
}
