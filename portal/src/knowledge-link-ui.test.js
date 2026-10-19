import test from 'node:test';
import assert from 'node:assert/strict';
import { bindLinkImport } from '../public/knowledge/link-import.js';

test('link mode falls back to local upload without import permission and resets required controls', () => {
  const elements = new Map(), element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', addEventListener() {} });
    return elements.get(id);
  };
  let allowed = false;
  element('upload-mode').value = 'link';
  const panel = bindLinkImport({ element, can: () => allowed, busy: () => false });
  panel.mode(); assert.equal(element('upload-mode').value, 'file'); assert.equal(element('video-file').required, true);
  allowed = true; element('upload-mode').value = 'link'; panel.reset();
  assert.equal(element('video-file').required, false); assert.equal(element('video-link').required, true);
  assert.equal(element('video-link-controls').hidden, false);
});

test('link preview avoids duplicate blur/click calls and stale metadata cannot overwrite changed input', async () => {
  const elements = new Map(), $ = id => {
    if (!elements.has(id)) elements.set(id, { value: '', hidden: false, addEventListener(event, fn) { this[event] = fn; } });
    return elements.get(id);
  };
  $('upload-mode').value = 'link'; $('video-link').value = 'first';
  let calls = 0, resolve;
  const panel = bindLinkImport({ element: $, can: () => true, busy: () => false, onError: e => { throw e; },
    send() { calls++; return new Promise(r => { resolve = r; }); } });
  panel.mode(); assert.equal($('video-file').disabled, true); assert.equal($('video-file').required, false);
  const pending = panel.preview(); await panel.preview(); assert.equal(calls, 1);
  $('video-link').value = 'changed'; $('video-link').input();
  resolve({ metadata: { title: 'stale', topic: 'old', tags: [], sourceUrl: 'old', duration: 30, uploader: '', warnings: [] } }); await pending;
  assert.equal($('upload-title').value, '');
  const next = panel.preview(); resolve({ metadata: { title: 'new', topic: '命理', tags: ['八字'], sourceUrl: 'source', duration: 30, uploader: '', warnings: [] } }); await next;
  assert.equal($('upload-title').value, 'new'); assert.equal($('upload-tags').value, '八字');
  $('upload-mode').value = 'file'; panel.mode(); assert.equal($('video-file').required, true); assert.equal($('video-link-controls').hidden, true);
});
