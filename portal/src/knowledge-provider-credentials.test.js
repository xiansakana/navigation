import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { knowledgeProviderCredentials, providerModels } from './knowledge-provider-credentials.js';
import { createKnowledgeStore } from './knowledge-store.js';

test('provider keys are encrypted per account/provider, preserved by settings saves and omitted from job snapshots', async () => {
  const db = new Database(':memory:');
  try {
    const store = createKnowledgeStore(db);
    const credentials = knowledgeProviderCredentials(db, () => Buffer.alloc(32, 42));
    await credentials.save('one', 'gemini', 'gemini-private-123');
    await credentials.save('one', 'openai', 'openai-private-123');
    store.saveSettings('one', { backend: 'openai', apiModel: 'chat-model' });
    assert.deepEqual(await credentials.status('one'), { gemini: true, openai: true });
    assert.equal(await credentials.read('one', 'gemini'), 'gemini-private-123');
    assert.equal(await credentials.read('two', 'openai'), '');
    const raw = db.prepare('SELECT model_settings_json FROM knowledge_settings WHERE user_id=?').get('one').model_settings_json;
    assert.doesNotMatch(raw, /private-123/);
    assert.equal(store.settings('one').providerCredentials, undefined);
    const doc = store.create('one', { backend: 'openai', title: 'Video', bytes: 20, mimeType: 'video/mp4', originalName: 'video.mp4' });
    assert.equal(doc.modelSettings.providerCredentials, undefined);
    await credentials.save('one', 'openai', null);
    assert.equal(await credentials.read('one', 'openai'), '');
    assert.deepEqual(await credentials.geminiOwners(), ['one']);
    db.prepare('INSERT INTO knowledge_settings(user_id,model_settings_json) VALUES (?,?)').run('two', raw);
    await assert.rejects(credentials.read('two', 'gemini'), /凭据无法读取/);
  } finally { db.close(); }
});

test('model catalogs use only the selected provider credential and omit non-summary models', async () => {
  const gemini = await providerModels('gemini', 'key-gemini', { async fetcher(url, { headers, redirect }) {
    assert.equal(new URL(url).host, 'generativelanguage.googleapis.com');
    assert.deepEqual(headers, { 'x-goog-api-key': 'key-gemini' });
    assert.equal(redirect, 'error');
    return Response.json({ models: [
      { name: 'models/gemini-test', displayName: 'Gemini Test', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-embedding', supportedGenerationMethods: ['embedContent'] }
    ] });
  } });
  assert.deepEqual(gemini, [{ id: 'gemini-test', name: 'Gemini Test' }]);
  const compatible = await providerModels('openai', 'key-openai', { baseUrl: () => 'https://provider.invalid/v1', async fetcher(url, { headers }) {
    assert.equal(url, 'https://provider.invalid/v1/models');
    assert.equal(headers.Authorization, 'Bearer key-openai');
    return Response.json({ data: [{ id: 'chat' }, { id: 'gpt-image-1' }, { id: 'not-chat', capabilities: { chat: false } }] });
  } });
  assert.deepEqual(compatible, [{ id: 'chat', name: 'chat' }]);
  await assert.rejects(providerModels('openai', 'key-openai', { fetcher: async () => new Response('key-openai', { status: 401 }) }),
    error => error.message.includes('401') && !error.message.includes('key-openai'));
});
