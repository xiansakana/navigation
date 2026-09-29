import test from 'node:test';
import assert from 'node:assert/strict';
import { CompanyMonitor } from './company-monitor.js';

function makeMonitor(fetchApplications, publishEvent = async function() {}) {
    var config = {
        company: {
            watchers: [{ id: 'watcher-1', label: '测试公司', apiKey: 'test-key', enabled: true }]
        },
        notify: { qq: { url: 'http://127.0.0.1:8787/notify', token: 'test-token' } }
    };
    return new CompanyMonitor(function() { return config; }, { fetchApplications, publishEvent });
}

test('first successful empty poll initializes watcher so first later application is notified', async function() {
    var responses = [{}, { '123': { name: '申请人', userID: 123, level: 10 } }];
    var published = [];
    var monitor = makeMonitor(async function() { return responses.shift(); }, async function(config, event) {
        published.push(event);
    });

    await monitor.runOnce();
    assert.equal(monitor.getState().apps, 0);
    assert.equal(published.length, 0);

    await monitor.runOnce();
    assert.equal(monitor.getState().apps, 1);
    assert.equal(published.length, 1);
    assert.match(published[0].message, /发现 1 个新申请/);
});

test('existing applications on the first successful poll remain a silent baseline', async function() {
    var published = [];
    var monitor = makeMonitor(async function() {
        return { '123': { name: '已有申请', userID: 123, level: 10 } };
    }, async function(config, event) { published.push(event); });

    await monitor.runOnce();
    await monitor.runOnce();

    assert.equal(monitor.getState().apps, 0);
    assert.equal(published.length, 0);
});

test('failed notification does not mark an application seen and the next poll retries it', async function() {
    var shouldFail = true;
    var published = 0;
    var responses = [
        {},
        { '123': { name: '新申请', userID: 123, level: 10 } },
        { '123': { name: '新申请', userID: 123, level: 10 } },
        { '123': { name: '新申请', userID: 123, level: 10 } }
    ];
    var monitor = makeMonitor(async function() {
        return responses.shift();
    }, async function() {
        published++;
        if (shouldFail) throw new Error('暂时无法推送');
    });
    monitor.on('error', function() {});

    await monitor.runOnce();
    await monitor.runOnce();
    assert.equal(published, 1);
    assert.equal(monitor.getState().apps, 0);

    shouldFail = false;
    await monitor.runOnce();
    assert.equal(published, 2);
    assert.equal(monitor.getState().apps, 1);
    await monitor.runOnce();
    assert.equal(published, 2);
});

test('overlapping poll attempts are skipped instead of publishing duplicates', async function() {
    var finishFetch;
    var fetchCount = 0;
    var publishCount = 0;
    var monitor = makeMonitor(async function() {
        fetchCount++;
        if (fetchCount === 1) return {};
        await new Promise(function(resolve) { finishFetch = resolve; });
        return { '123': { name: '新申请', userID: 123, level: 10 } };
    }, async function() { publishCount++; });

    await monitor.runOnce();
    var inFlight = monitor.runOnce();
    await Promise.resolve();
    await monitor.runOnce();
    assert.equal(fetchCount, 2);

    finishFetch();
    await inFlight;
    assert.equal(publishCount, 1);
});
