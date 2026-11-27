import assert from 'node:assert/strict';
import test from 'node:test';
import { postgresProductionTarget, postgresUrlFor } from './config.js';

test('production uses one PostgreSQL URL for every migrated service and rejects split targets', () => {
  const url = 'postgresql://navigation@127.0.0.1/navigation_live';
  const env = { NAVIGATION_DATABASE_ENGINE: 'postgres', NAVIGATION_POSTGRES_URL: url, NAVIGATION_POSTGRES_DATABASE: 'navigation_live' };
  for (const scope of ['identity', 'mingli', 'blog', 'resources', 'torn', 'tornUsers', 'qqMonitoring', 'quant',
    'bookkeeping', 'portfolio', 'qqqDip']) {
    assert.equal(postgresUrlFor(scope, env), url);
  }
  assert.throws(() => postgresProductionTarget({ ...env, NAVIGATION_POSTGRES_DATABASE: 'navigation_snapshot' }), { code: 'POSTGRES_CONFIG_INVALID' });
  assert.throws(() => postgresProductionTarget({ ...env, NAVIGATION_POSTGRES_URL: '' }), { code: 'POSTGRES_CONFIG_INVALID' });
  assert.throws(() => postgresProductionTarget({ ...env, NAVIGATION_TORN_USERS_POSTGRES_URL: url + '_old' }), { code: 'POSTGRES_CONFIG_INVALID' });
});

test('isolated rehearsal still supports the original per-module opt-ins', () => {
  const url = 'postgresql://navigation@127.0.0.1/navigation_rehearsal';
  const env = { NAVIGATION_TORN_USERS_POSTGRES_URL: url };
  assert.equal(postgresProductionTarget(env), null);
  assert.equal(postgresUrlFor('tornUsers', env), url);
  assert.equal(postgresUrlFor('torn', env), undefined);
});
