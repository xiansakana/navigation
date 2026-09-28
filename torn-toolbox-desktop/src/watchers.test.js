import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeWatcherConfig, maskWatcherForClient } from './watchers.js';

test('legacy watcher saves preserve centralized Slack choice', function() {
    var previous = {
        id: 'w1', label: '账号', apiKey: 'secret',
        notify: { desktop: true, slack: { enabled: true }, qq: { enabled: true, targets: [] } }
    };
    var updated = mergeWatcherConfig({ id: 'w1', notify: { qq: { enabled: false } } }, previous);
    assert.equal(updated.notify.slack.enabled, true);
    assert.equal(updated.notify.qq.enabled, false);
    assert.equal(maskWatcherForClient(updated).notify.slack.enabled, true);
});
