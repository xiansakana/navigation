import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, publicConfig, applyPublicConfig } from './config.js';

test('Tibo custom QQ targets persist independently of the channel default', function() {
    var current = normalizeConfig({ defaultTarget: { type: 'private', userId: '111' } });
    assert.equal(current.monitors.tiboReset.qq.useDefaultTarget, true);
    var updated = applyPublicConfig(current, { monitors: { tiboReset: { qq: {
        useDefaultTarget: false,
        targets: [{ id: 'group1', type: 'group', groupId: '222', atUserId: 'all' }, { id: 'private1', type: 'private', userId: '333' }]
    } } } });
    var reloaded = normalizeConfig(JSON.parse(JSON.stringify(updated)));
    assert.equal(reloaded.monitors.tiboReset.qq.targets.length, 2);
    assert.equal(reloaded.monitors.tiboReset.qq.targets[0].atUserId, 'all');
    assert.deepEqual(reloaded.defaultTarget, current.defaultTarget);
    assert.deepEqual(applyPublicConfig(updated, { channels: { email: { enabled: true } } }).monitors, updated.monitors);
    assert.throws(function() {
        applyPublicConfig(current, { monitors: { tiboReset: { qq: { useDefaultTarget: false, targets: [] } } } });
    }, /至少添加/);
});

test('legacy QQ config is normalized with email disabled', function() {
    var config = normalizeConfig({
        napcat: { baseUrl: 'http://127.0.0.1:3000' },
        defaultTarget: { type: 'private', userId: '1' },
        server: { port: 8787 }
    });
    assert.equal(config.channels.qq.enabled, true);
    assert.equal(config.channels.email.enabled, false);
    assert.equal(config.channels.email.smtp.port, 465);
    assert.equal(config.channels.slack.enabled, false);
    assert.deepEqual(config.monitors.tiboReset.channels, ['qq']);
});

test('public config redacts secrets', function() {
    var output = publicConfig({
        napcat: { accessToken: 'secret' },
        server: { notifyToken: 'notify-secret' },
        channels: { email: { smtp: { pass: 'mail-secret' } }, slack: { webhookUrl: 'https://hooks.slack.com/services/T/B/secret' } }
    });
    assert.equal(output.napcat.accessToken, undefined);
    assert.equal(output.napcat.hasAccessToken, true);
    assert.equal(output.server.notifyToken, undefined);
    assert.equal(output.channels.email.smtp.pass, undefined);
    assert.equal(output.channels.email.smtp.hasPassword, true);
    assert.equal(output.channels.slack.webhookUrl, undefined);
    assert.equal(output.channels.slack.hasWebhookUrl, true);
});

test('blank secret inputs preserve saved values', function() {
    var current = normalizeConfig({
        napcat: { accessToken: 'qq-secret' },
        channels: { email: { smtp: { pass: 'mail-secret' } }, slack: { webhookUrl: 'https://hooks.slack.com/services/T/B/secret' } }
    });
    var updated = applyPublicConfig(current, {
        napcat: { accessToken: '' },
        channels: { email: { smtp: { pass: '', host: 'smtp.example.com' } }, slack: { webhookUrl: '' } }
    });
    assert.equal(updated.napcat.accessToken, 'qq-secret');
    assert.equal(updated.channels.email.smtp.pass, 'mail-secret');
    assert.equal(updated.channels.email.smtp.host, 'smtp.example.com');
    assert.equal(updated.channels.slack.webhookUrl, 'https://hooks.slack.com/services/T/B/secret');
});

test('Slack webhook changes are validated before saving', function() {
    var current = normalizeConfig({});
    assert.throws(function() {
        applyPublicConfig(current, { channels: { slack: { webhookUrl: 'http://127.0.0.1/private' } } });
    }, /Slack Webhook URL/);
    var updated = applyPublicConfig(current, {
        channels: { slack: { enabled: true, webhookUrl: 'https://hooks.slack.com/services/T/B/secret' } },
        monitors: { tiboReset: { enabled: true, channels: ['qq', 'slack'] } }
    });
    assert.equal(updated.channels.slack.enabled, true);
    assert.deepEqual(updated.monitors.tiboReset.channels, ['qq', 'slack']);
});

test('channel and Tibo configuration can be saved independently', function() {
    var current = normalizeConfig({
        napcat: { baseUrl: 'http://127.0.0.1:3000' },
        monitors: { tiboReset: { enabled: true, intervalMinutes: 5, channels: ['qq'] } }
    });
    var channelsSaved = applyPublicConfig(current, {
        channels: { email: { enabled: true } }
    });
    assert.equal(channelsSaved.channels.email.enabled, true);
    assert.deepEqual(channelsSaved.monitors.tiboReset, current.monitors.tiboReset);

    var monitorSaved = applyPublicConfig(channelsSaved, {
        monitors: { tiboReset: { intervalMinutes: 10, channels: ['qq', 'email'] } }
    });
    assert.equal(monitorSaved.channels.email.enabled, true);
    assert.equal(monitorSaved.monitors.tiboReset.intervalMinutes, 10);
    assert.deepEqual(monitorSaved.monitors.tiboReset.channels, ['qq', 'email']);
});
