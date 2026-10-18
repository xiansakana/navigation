import test from 'node:test';
import assert from 'node:assert/strict';
import { externalSource, createSourcePlayer } from '../public/knowledge/source.js';
import { bindVideoDrop } from '../public/knowledge/drop.js';

test('external links preserve Bilibili video/part and reject executable or same-origin URLs', () => {
  const origin = 'https://saoyu.fun';
  const source = externalSource('https://www.bilibili.com/video/BV1LTpi69Efh/?p=2', origin);
  assert.equal(source.embed, 'https://player.bilibili.com/player.html?bvid=BV1LTpi69Efh&autoplay=0&p=2');
  for (const url of ['javascript:alert(1)', 'data:text/html,x', '/knowledge/', 'https://saoyu.fun/api/test', 'https://user:pass@host.test']) assert.equal(externalSource(url, origin), null);
  assert.equal(externalSource('https://example.com/video', origin).embed, 'https://example.com/video');
  assert.equal(externalSource('https://bilibili.com.evil.test/video/BV1LTpi69Efh', origin).embed, 'https://bilibili.com.evil.test/video/BV1LTpi69Efh');
});

const element = () => ({ hidden: false, value: '', options: [{}, {}], handlers: {},
  addEventListener(name, fn) { this.handlers[name] = fn; },
  setAttribute(name, value) { this[name] = value; },
  removeAttribute(name) { delete this[name]; }, pause() {}, load() {}, play() { return Promise.resolve(); }
});

test('default source loads only on playback tab; switching/seek removes old player and checks permission', () => {
  const originalLocation = globalThis.location;
  globalThis.location = { origin: 'https://saoyu.fun' };
  try {
    const player = element(), frame = element(), select = element(), link = element(), hint = element();
    let allowed = true;
    const control = createSourcePlayer({ player, frame, select, link, hint, allowed: () => allowed });
    control.reset({ id: 'abc', sourceUrl: 'https://example.com/video', status: 'ready', storage: { provider: '115' } });
    assert.equal(select.value, 'original'); assert.equal(frame.src, undefined);
    control.activate(true); assert.equal(frame.src, 'https://example.com/video'); assert.equal(player.src, undefined);
    control.seek(80); assert.equal(frame.src, undefined); assert.equal(player.currentTime, 80); assert.equal(player.src, '/api/knowledge/documents/abc/source');
    control.activate(false); assert.equal(player.src, undefined);
    control.reset({ id: 'def', sourceUrl: '', status: 'uploading' }); control.activate(true);
    assert.equal(select.value, 'archive'); assert.equal(player.src, undefined);
    allowed = false; control.reset({ id: 'abc', sourceUrl: 'https://example.com/video', status: 'ready' }); control.activate(true);
    assert.equal(frame.src, undefined); assert.equal(player.src, undefined); assert.equal(link.hidden, true);
    control.reset(null);
  } finally { if (originalLocation === undefined) delete globalThis.location; else globalThis.location = originalLocation; }
});

test('drop accepts one supported file, rejects invalid batches and leaves selected file intact on errors or while busy', () => {
  const originalTransfer = globalThis.DataTransfer;
  globalThis.DataTransfer = class { files = []; items = { add: file => this.files.push(file) }; };
  try {
    const zone = element(), input = element(), selected = [], errors = [];
    zone.classList = { add() {}, remove() {} }; let busy = false;
    bindVideoDrop({ zone, input, selected: f => selected.push(f), error: e => errors.push(e.message), busy: () => busy, maxBytes: () => 100 });
    const file = { name: 'demo.mp4', size: 80 };
    const drop = files => zone.handlers.drop({ preventDefault() {}, dataTransfer: { types: ['Files'], files } });
    drop([file]); assert.equal(input.files[0], file); assert.equal(selected.length, 1);
    drop([file, file]); drop([{ name: 'bad.exe', size: 1 }]); drop([{ name: 'large.mov', size: 101 }]);
    assert.equal(errors.length, 3); assert.equal(input.files[0], file);
    busy = true; drop([file]); assert.equal(selected.length, 1);
  } finally { if (originalTransfer === undefined) delete globalThis.DataTransfer; else globalThis.DataTransfer = originalTransfer; }
});
