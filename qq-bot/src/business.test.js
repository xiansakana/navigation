import test from 'node:test';
import assert from 'node:assert/strict';
import { createBusinessService } from './business.js';

function sourceFetch(url) {
    const data = url.includes(':5001')
        ? { ok: true, notify: { qq: { enabled: true }, slack: { enabled: false }, targets: [{ type: 'private', userId: '123' }], events: { T1: true, openSummary: false } }, monitor: { running: true } }
        : { ok: true, config: { notify: { desktop: false, qq: { enabled: true }, slack: { enabled: false } },
            [url.includes(':8790') ? 'undercut' : 'company']: { watchers: [{ id: 'w1', label: '账号', enabled: true, apiKey: 'SECRET', notify: {
                desktop: false, qq: { enabled: true, targets: [{ type: 'group', groupId: '456' }] }, slack: { enabled: false }
            } }] } } };
    return Promise.resolve({ ok: true, json: async () => data });
}

test('imports legacy settings once and redacts monitoring secrets', async () => {
    const config = {};
    const snapshots = [];
    const service = createBusinessService(config, { fetcher: sourceFetch, persist: value => snapshots.push(JSON.parse(JSON.stringify(value))), send: async () => {} });
    const list = await service.list();
    assert.equal(list.length, 3);
    assert.equal(list[1].watchers[0].apiKey, undefined);
    assert.equal(config.business.stock.notify.events.openSummary, false);
    assert.equal(config.business.undercut.watchers.w1.qq.targets[0].groupId, '456');
    assert.equal(snapshots.length, 3);
    await service.list();
    assert.equal(snapshots.length, 3);
});

test('hub owns rules, targets, delivery and test regardless of old service settings', async () => {
    const config = {};
    const sent = [];
    const service = createBusinessService(config, { fetcher: sourceFetch, persist: () => {},
        send: async (channel, body) => sent.push({ channel, body }), desktop: async () => {} });
    await service.list();
    assert.deepEqual(await service.dispatch('stock', null, 'openSummary', '摘要'), { skipped: true, reason: 'event-disabled' });
    await service.dispatch('stock', null, 'T1', '触发 $10');
    assert.equal(sent[0].body.userId, '123');
    assert.match(sent[0].body.message, /＄10/);
    await service.save('stock', { qq: { enabled: false }, slack: { enabled: true }, targets: [], events: { T1: true } });
    await service.dispatch('stock', null, 'T1', '再次触发');
    assert.equal(sent.length, 2);
    assert.equal(sent[1].channel, 'slack');
    await service.save('company', { notify: { qq: { enabled: true }, slack: { enabled: true } }, watchers: [{ id: 'w1', notify: {
        desktop: false, qq: { enabled: true, targets: [{ type: 'private', userId: '789' }] }, slack: { enabled: true }
    } }] });
    await service.dispatch('company', 'w1', 'application', '新申请');
    assert.deepEqual(sent.slice(2).map(x => x.channel), ['qq', 'slack']);
    assert.equal(sent[2].body.userId, '789');
    await assert.rejects(service.dispatch('company', 'missing', 'application', 'test'), /监听账号不存在/);
    await assert.rejects(service.save('company', { watchers: [{ id: 'missing', notify: {} }] }), /监听账号不存在/);
});
