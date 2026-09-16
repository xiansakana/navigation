import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, publicConfig, applyPublicConfig } from './config.js';

test('legacy QQ config is normalized with email disabled', function() {
    var config = normalizeConfig({
        napcat: { baseUrl: 'http://127.0.0.1:3000' },
        defaultTarget: { type: 'private', userId: '1' },
        server: { port: 8787 }
    });
    assert.equal(config.channels.qq.enabled, true);
    assert.equal(config.channels.email.enabled, false);
    assert.equal(config.channels.email.smtp.port, 465);
});

test('public config redacts secrets', function() {
    var output = publicConfig({
        napcat: { accessToken: 'secret' },
        server: { notifyToken: 'notify-secret' },
        channels: { email: { smtp: { pass: 'mail-secret' } } }
    });
    assert.equal(output.napcat.accessToken, undefined);
    assert.equal(output.napcat.hasAccessToken, true);
    assert.equal(output.server.notifyToken, undefined);
    assert.equal(output.channels.email.smtp.pass, undefined);
    assert.equal(output.channels.email.smtp.hasPassword, true);
});

test('blank secret inputs preserve saved values', function() {
    var current = normalizeConfig({
        napcat: { accessToken: 'qq-secret' },
        channels: { email: { smtp: { pass: 'mail-secret' } } }
    });
    var updated = applyPublicConfig(current, {
        napcat: { accessToken: '' },
        channels: { email: { smtp: { pass: '', host: 'smtp.example.com' } } }
    });
    assert.equal(updated.napcat.accessToken, 'qq-secret');
    assert.equal(updated.channels.email.smtp.pass, 'mail-secret');
    assert.equal(updated.channels.email.smtp.host, 'smtp.example.com');
});
