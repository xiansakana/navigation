import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWatcherQqConfigs } from './notify.js';

test('global and watcher QQ switches both gate delivery', function() {
    var watcher = { qq: { enabled: true, targets: [{ id: 't1', type: 'private', userId: '123' }] } };
    assert.equal(buildWatcherQqConfigs({ qq: { enabled: false, url: 'http://127.0.0.1:8787/notify' } }, watcher).length, 0);
    assert.equal(buildWatcherQqConfigs({ qq: { enabled: true, url: 'http://127.0.0.1:8787/notify' } }, watcher).length, 1);
    assert.equal(buildWatcherQqConfigs({ qq: { enabled: true, url: 'http://127.0.0.1:8787/notify' } }, { qq: { ...watcher.qq, enabled: false } }).length, 0);
});
