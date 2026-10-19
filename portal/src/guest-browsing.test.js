import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDatabase, closeDatabase } from '../../shared/db/index.js';
import { ensureGuestAccess, getVisibleMenus, buildMenusFromServices } from './rbac.js';
import { handleCodexCliApi } from './codex-cli.js';
import { handleKnowledgeApi } from './knowledge.js';
import { createKnowledgeStore } from './knowledge-store.js';
import { handleMingliApi } from './mingli.js';

const guest = { userId: 'guest', isGuest: true, permissions: ['*'] };
const request = (url, method = 'GET', input) => ({ url, method, headers: { host: 'localhost', origin: 'http://localhost' },
  async *[Symbol.asyncIterator]() { if (input !== undefined) yield Buffer.from(JSON.stringify(input)); } });
async function call(handler, url, session = guest, method = 'GET', input, dependencies) {
  let result;
  await handler(request(url, method, input), { setHeader() {} }, new URL(url, 'http://localhost'), session,
    (_, status, body) => { result = { status, body }; }, dependencies);
  return result;
}

test('guest default browse grants are narrow, persistent and revocable', () => {
  const data = { users: [], roles: [{ id: 'role_guest', permissions: [] }] };
  ensureGuestAccess(data, { services: [] });
  const permissions = data.roles[0].permissions;
  for (const id of ['codex-cli:view', 'knowledge:view', 'knowledge:notes:view', 'mingli:view', 'mingli:chart:calculate']) assert.ok(permissions.includes(id));
  assert.ok(!permissions.includes('codex-cli:settings:edit'));
  assert.ok(!permissions.includes('knowledge:publish:edit'));
  assert.ok(!permissions.includes('mingli:cases:view'));
  const menus = getVisibleMenus({ menus: buildMenusFromServices([]) }, []);
  for (const serviceId of ['codex-cli', 'knowledge', 'mingli']) assert.ok(menus.some(m => m.serviceId === serviceId));
  data.roles[0].permissions = permissions.filter(id => id !== 'knowledge:view');
  ensureGuestAccess(data, { services: [] });
  assert.ok(!data.roles[0].permissions.includes('knowledge:view'));
});

test('Codex public surface never invokes account, session or configuration readers', async () => {
  const fail = () => { throw new Error('PRIVATE-CREDENTIAL'); };
  const dependencies = { setup: fail, status: fail, usage: fail, store: { settings: fail } };
  const publicView = await call(handleCodexCliApi, '/api/codex-cli/public-status', guest, 'GET', undefined, dependencies);
  assert.equal(publicView.status, 200);
  assert.deepEqual(Object.keys(publicView.body).sort(), ['description', 'mode', 'ok', 'service']);
  for (const route of ['status', 'usage', 'runtime', 'settings', 'conversations', 'todos']) {
    for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
      const result = await call(handleCodexCliApi, '/api/codex-cli/' + route, guest, method, {}, dependencies);
      assert.equal(result.status, 403);
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE-CREDENTIAL/);
    }
  }
  assert.equal((await call(handleCodexCliApi, '/api/codex-cli/public-status', { ...guest, permissions: [] })).status, 403);
});

test('knowledge sharing defaults to private and public routes enforce ownership and safe fields', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guest-knowledge-'));
  const previous = process.env.NAVIGATION_DB_PATH;
  process.env.NAVIGATION_DB_PATH = path.join(directory, 'test.db');
  try {
    const db = getDatabase(), store = createKnowledgeStore(db);
    const item = store.create('author', { title: 'PRIVATE-TITLE', topic: 'course', tags: ['tag'], bytes: 24,
      mimeType: 'video/mp4', originalName: 'PRIVATE-FILENAME', backend: 'codex', sourceUrl: 'https://private.test/SECRET' });
    assert.equal(item.visibility, 'private');
    db.prepare("UPDATE knowledge_documents SET status='ready',notes='# Public body',transcript_json=?,provenance_json=? WHERE id=?")
      .run(JSON.stringify([{ text: 'SECRET-TRANSCRIPT' }]), JSON.stringify({ model: 'SECRET-MODEL' }), item.id);
    const list = '/api/knowledge/public/documents', detail = list + '/' + item.id;
    assert.equal((await call(handleKnowledgeApi, list)).body.total, 0);
    assert.equal((await call(handleKnowledgeApi, detail)).status, 404);
    const author = { userId: 'author', isGuest: false, permissions: ['knowledge:view', 'knowledge:notes:view', 'knowledge:publish:edit'] };
    const visibility = '/api/knowledge/documents/' + item.id + '/visibility';
    assert.equal((await call(handleKnowledgeApi, visibility, { ...author, userId: 'other' }, 'PUT', { visibility: 'public', revision: 0 })).status, 404);
    assert.equal((await call(handleKnowledgeApi, visibility, { ...author, permissions: ['knowledge:view', 'knowledge:notes:edit'] }, 'PUT', { visibility: 'public', revision: 0 })).status, 403);
    const crossSite = request(visibility, 'PUT', { visibility: 'public', revision: 0 });
    crossSite.headers.origin = 'https://evil.test';
    let crossSiteStatus;
    await handleKnowledgeApi(crossSite, { setHeader() {} }, new URL(visibility, 'http://localhost'), author, (_, status) => { crossSiteStatus = status; });
    assert.equal(crossSiteStatus, 403);
    db.prepare('UPDATE knowledge_documents SET title=? WHERE id=?').run('Public title', item.id);
    assert.equal((await call(handleKnowledgeApi, visibility, author, 'PUT', { visibility: 'public', revision: 0 })).status, 200);
    assert.equal((await call(handleKnowledgeApi, list)).body.total, 1);
    const opened = await call(handleKnowledgeApi, detail);
    assert.equal(opened.status, 200);
    assert.deepEqual(Object.keys(opened.body.document).sort(), ['createdAt', 'id', 'notes', 'tags', 'title', 'topic', 'updatedAt']);
    assert.doesNotMatch(JSON.stringify(opened), /PRIVATE|SECRET|sourceUrl|originalName|worker|model|storage|userId/);
    assert.equal((await call(handleKnowledgeApi, list + '?search=SECRET-TRANSCRIPT')).body.total, 0);
    db.prepare("UPDATE knowledge_documents SET status='failed' WHERE id=?").run(item.id);
    assert.equal((await call(handleKnowledgeApi, detail)).status, 404);
    assert.equal((await call(handleKnowledgeApi, list)).body.total, 0);
    db.prepare("UPDATE knowledge_documents SET status='ready' WHERE id=?").run(item.id);
    for (const suffix of ['', '/source', '/frames/image.jpg', '/export', '/visibility']) {
      assert.equal((await call(handleKnowledgeApi, '/api/knowledge/documents/' + item.id + suffix)).status, 403);
    }
    for (const endpoint of ['settings', 'documents', 'devices', 'worker-token', 'bilibili', 'imports']) {
      for (const method of ['GET', 'POST', 'PUT', 'DELETE']) assert.equal((await call(handleKnowledgeApi, '/api/knowledge/' + endpoint, guest, method, {})).status, 403);
    }
    assert.equal((await call(handleKnowledgeApi, list, guest, 'POST', {})).status, 405);
    assert.equal((await call(handleKnowledgeApi, visibility, author, 'PUT', { visibility: 'private', revision: 0 })).status, 409);
    assert.equal((await call(handleKnowledgeApi, visibility, author, 'PUT', { visibility: 'private', revision: 1 })).status, 200);
    assert.equal((await call(handleKnowledgeApi, detail)).status, 404);
    assert.equal((await call(handleKnowledgeApi, list)).body.total, 0);
  } finally {
    closeDatabase();
    if (previous === undefined) delete process.env.NAVIGATION_DB_PATH; else process.env.NAVIGATION_DB_PATH = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('guest chart calculation is stateless and private case APIs remain forbidden', async () => {
  const calculated = await call(handleMingliApi, '/api/mingli/chart', guest, 'POST',
    { calendar: 'solar', gender: 1, year: 1990, month: 1, day: 1, hour: 12, minute: 0, sect: 2 });
  assert.equal(calculated.status, 200);
  assert.ok(calculated.body.chart);
  for (const endpoint of ['cases', 'categories', 'knowledge-cases', 'import/preview', 'import/confirm']) {
    for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
      assert.equal((await call(handleMingliApi, '/api/mingli/' + endpoint, guest, method, {})).status, 403);
    }
  }
});
