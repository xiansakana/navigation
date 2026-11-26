export function createPostgresPool(Pool, connectionString, applicationName) {
  const pool = new Pool({
    connectionString,
    application_name: applicationName,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
    max: 4,
  });
  pool.on('error', error => console.error('[postgres idle client]', error.code || error.name));
  return {
    query: (sql, values) => pool.query(sql, values),
    close: () => pool.end(),
    async transaction(run, { readOnly = false } = {}) {
      const client = await pool.connect();
      let rollbackError;
      try {
        await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
        const result = await run(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch (cause) { rollbackError = cause; }
        throw error;
      } finally {
        client.release(rollbackError);
      }
    },
  };
}
