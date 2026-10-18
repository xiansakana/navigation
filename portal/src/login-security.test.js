import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionSecret, cookieOptions, createLoginLimiter } from './login-security.js';
import { createSessionCookie, getSession, parseCookies } from './auth.js';
import { clientAddress, sameOriginWrite } from '../../shared/http.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDatabase, closeDatabase } from '../../shared/db/index.js';
import { createPasswordRecord, loadRbac, saveRbac } from './rbac.js';
import { verifyLogin } from './auth.js';

test('session security rejects defaults, signs secure cookies and ignores malformed cookies', () => {
  assert.throws(() => sessionSecret({ auth: { sessionSecret: 'portal' } }));
  const secret = sessionSecret({ auth: { sessionSecret: 'a'.repeat(40) } });
  const cookie = createSessionCookie('user', secret, cookieOptions({ auth: { secureCookies: true } }));
  assert.match(cookie, /; Secure$/);
  assert.equal(getSession({ headers: { cookie } }, secret).userId, 'user');
  assert.equal(getSession({ headers: { cookie } }, 'wrong'), null);
  assert.deepEqual(parseCookies({ headers: { cookie: 'broken=%E0%A4%A' } }), {});
});

test('throttle survives rotating untrusted forwarded addresses and expires without permanent lockout', () => {
  let now = 1000;
  const limiter = createLoginLimiter({ clock: () => now });
  const req = { headers: { 'x-forwarded-for': '1.2.3.4' }, socket: { remoteAddress: '10.0.0.1' } };
  const config = { auth: {} };
  for (let i = 0; i < 5; i++) limiter.failure(req, 'Admin', config);
  req.headers['x-forwarded-for'] = '8.8.8.8';
  assert.equal(limiter.check(req, 'admin', config), 1);
  now += 1001;
  assert.equal(limiter.check(req, 'admin', config), 0);
  limiter.success(req, 'admin', config);
  assert.equal(clientAddress(req), '10.0.0.1');
  assert.equal(clientAddress(req, ['10.0.0.1']), '8.8.8.8');
  assert.equal(sameOriginWrite({ method: 'POST', headers: { host: 'example.com', origin: 'https://attacker.com' } }), false);
});

test('login uses the database password only, and external revocation invalidates cached RBAC', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'navigation-login-'));
  const previous = process.env.NAVIGATION_DB_PATH;
  process.env.NAVIGATION_DB_PATH = path.join(directory, 'db.sqlite');
  try {
    const db = getDatabase({ rbacJsonPath: path.join(directory, 'missing.json'), portfolioJsonPath: path.join(directory, 'missing-portfolio.json') });
    const config = { services: [], auth: { username: 'admin', password: 'bootstrap-only' } };
    const data = loadRbac(config);
    const admin = data.users.find(user => user.username === 'admin');
    Object.assign(admin, createPasswordRecord('database-only'));
    saveRbac(data);
    assert.equal(verifyLogin('admin', 'bootstrap-only', config), null);
    assert.ok(verifyLogin('admin', 'database-only', config));
    const external = JSON.parse(db.prepare('SELECT payload FROM rbac_snapshot WHERE id=1').get().payload);
    external.users.find(user => user.id === admin.id).enabled = false;
    db.prepare('UPDATE rbac_snapshot SET payload=? WHERE id=1').run(JSON.stringify(external));
    assert.equal(verifyLogin('admin', 'database-only', config), null);
  } finally {
    closeDatabase();
    if (previous === undefined) delete process.env.NAVIGATION_DB_PATH; else process.env.NAVIGATION_DB_PATH = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
