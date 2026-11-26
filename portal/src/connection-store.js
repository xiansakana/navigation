export function connectionStore(initialize) {
  const stores = new WeakMap();
  return db => {
    const existing = stores.get(db);
    if (existing) return existing;
    // A caller's transaction may still roll back the schema initialization.
    if (db.inTransaction) return initialize(db);
    const store = db.transaction(() => initialize(db)).immediate();
    stores.set(db, store);
    return store;
  };
}
