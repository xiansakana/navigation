import { postgresProductionTarget } from './config.js';

const SCHEMA_VERSIONS = ['001-initial', '002-qqq-dip-state', '003-runtime-state'];
const APPLICATION_SCHEMA_VERSION = SCHEMA_VERSIONS.at(-1);

export async function verifyPostgresSchema(db, { expectedDatabase, expectedVersion } = {}) {
  try {
    const { rows } = await db.query(`SELECT current_database() AS database, version
      FROM navigation.navigation_schema_migrations ORDER BY version DESC LIMIT 1`);
    const current = rows[0];
    if (SCHEMA_VERSIONS.includes(current?.version) && (!expectedVersion || current.version === expectedVersion) &&
        (!expectedDatabase || current.database === expectedDatabase)) return current;
  } catch {
    // An unavailable or uninitialized target must keep the selected backend offline.
  }
  throw Object.assign(new Error('PostgreSQL 不可用或数据库版本不匹配'), { status: 503, code: 'POSTGRES_NOT_READY' });
}

export async function verifyPostgresApplicationTarget(db, database) {
  const schema = await verifyPostgresSchema(db, { expectedDatabase: database, expectedVersion: APPLICATION_SCHEMA_VERSION });
  try {
    const { rows: [role] } = await db.query(`SELECT current_setting('transaction_read_only') = 'off'
      AND NOT pg_is_in_recovery()
      AND to_regclass('navigation.qqq_dip_state') IS NOT NULL
      AND to_regclass('navigation.torn_company_monitor_state') IS NOT NULL
      AND to_regclass('navigation.qq_bot_state') IS NOT NULL
      AND has_schema_privilege('navigation', 'USAGE')
      AND NOT EXISTS (
        SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='navigation' AND (
          (c.relkind IN ('r','p') AND (NOT has_table_privilege(c.oid,'SELECT') OR
            (c.relname<>'navigation_schema_migrations' AND
              (NOT has_table_privilege(c.oid,'INSERT') OR NOT has_table_privilege(c.oid,'UPDATE')
                OR NOT has_table_privilege(c.oid,'DELETE')))))
          OR (c.relkind='S' AND NOT has_sequence_privilege(c.oid,'USAGE'))
        )
      ) AS writable`);
    if (role?.writable) return schema;
  } catch {
    // Keep services out of readiness when the target cannot accept business writes.
  }
  throw Object.assign(new Error('PostgreSQL 生产数据库权限不足或处于只读状态'), { status: 503, code: 'POSTGRES_NOT_WRITABLE' });
}
export function verifyConfiguredPostgres(db) {
  const target = postgresProductionTarget();
  return target ? verifyPostgresApplicationTarget(db, target.database) : verifyPostgresSchema(db);
}
