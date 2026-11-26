const SCHEMA_VERSION = '001-initial';

export async function verifyPostgresSchema(db) {
  try {
    const { rows } = await db.query(`SELECT current_database() AS database, version
      FROM navigation.navigation_schema_migrations ORDER BY version DESC LIMIT 1`);
    if (rows[0]?.version === SCHEMA_VERSION) return rows[0];
  } catch {
    // An unavailable or uninitialized target must keep the selected backend offline.
  }
  throw Object.assign(new Error('PostgreSQL 不可用或数据库版本不匹配'), { status: 503, code: 'POSTGRES_NOT_READY' });
}
