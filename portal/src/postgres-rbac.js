import { copyRbac, revisionKey } from '../../shared/db/rbac-store.js';
import { createPostgresRbacStore } from '../../shared/db/postgres/rbac-store.js';
import { verifyPostgresSchema } from '../../shared/db/postgres/readiness.js';
import { configServicesKey, loadRbac, saveRbac, syncRbacPermissions } from './rbac.js';
import { createPostgresDatabase } from './postgres.js';

export function createPortalPostgresRbac(db) {
  const rbac = createPostgresRbacStore(db);
  let cache;

  async function load(config) {
    const configKey = configServicesKey(config);
    if (cache?.configKey === configKey && cache.data[revisionKey] === await rbac.revision()) {
      return copyRbac(cache.data);
    }
    // Concurrent normalization must preserve changes saved by another request.
    for (let attempt = 0; attempt < 3; attempt++) {
      const data = await rbac.load();
      if (!data) throw Object.assign(new Error('权限数据库未初始化'), { status: 503 });
      const before = JSON.stringify(data);
      syncRbacPermissions(data, config, { persist: false });
      if (before !== JSON.stringify(data)) {
        try { await rbac.save(data); }
        catch (error) {
          if (error.code === 'RBAC_CONFLICT' && attempt < 2) continue;
          throw error;
        }
      }
      cache = { configKey, data };
      return copyRbac(data);
    }
  }

  async function save(data) {
    await rbac.save(data);
    cache = undefined;
  }

  return { load, save };
}

export function createPortalIdentityRepository(connectionString) {
  if (!connectionString) return { load: loadRbac, save: saveRbac, ready: () => undefined };
  const db = createPostgresDatabase(connectionString);
  const repository = createPortalPostgresRbac(db);
  async function ready() {
    await verifyPostgresSchema(db);
    let rows;
    try { ({ rows } = await db.query('SELECT id FROM navigation.rbac_snapshot WHERE id = 1')); }
    catch { throw Object.assign(new Error('权限数据库暂不可用'), { status: 503, code: 'RBAC_DB_UNAVAILABLE' }); }
    if (!rows.length) throw Object.assign(new Error('权限数据库未初始化'), { status: 503 });
  }
  let initial;
  return {
    ready,
    writeAudit(values) {
      return db.query(`INSERT INTO navigation.data_access_audit
        (actor_id,owner_id,module_id,scope,method,path,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, values);
    },
    async load(config) {
      initial ||= ready().catch(error => { initial = undefined; throw error; });
      await initial;
      try { return await repository.load(config); }
      catch (error) {
        if (error.status) throw error;
        throw Object.assign(new Error('权限数据库暂不可用'), { status: 503, code: 'RBAC_DB_UNAVAILABLE' });
      }
    },
    async save(data) {
      try { await repository.save(data); }
      catch (error) {
        if (error.status) throw error;
        throw Object.assign(new Error('权限数据库暂不可用'), { status: 503, code: 'RBAC_DB_UNAVAILABLE' });
      }
    },
  };
}

export const portalIdentity = createPortalIdentityRepository(process.env.NAVIGATION_RBAC_POSTGRES_URL);
