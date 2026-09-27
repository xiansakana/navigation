import test from 'node:test';
import assert from 'node:assert/strict';
import { sendSlack, validateSlackWebhookUrl } from './slack.js';

const webhookUrl = 'https://hooks.slack.com/services/T123/B456/secret';

test('Slack sender posts text to the configured webhook', async function() {
    var request;
    var result = await sendSlack({ webhookUrl: webhookUrl }, '通知测试', {
        fetch: async function(url, options) {
            request = { url: url, options: options };
            return { ok: true };
        }
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(request.url, webhookUrl);
    assert.equal(request.options.method, 'POST');
    assert.deepEqual(JSON.parse(request.options.body), { text: '通知测试' });
    assert.equal(request.options.redirect, 'error');
});

test('Slack sender rejects non-Slack URLs and reports delivery failure', async function() {
    assert.throws(function() { validateSlackWebhookUrl('http://127.0.0.1/services/a/b/c'); }, /Slack Webhook URL/);
    assert.throws(function() { validateSlackWebhookUrl('https://hooks.slack.com.evil.test/services/a/b/c'); }, /Slack Webhook URL/);
    await assert.rejects(sendSlack({ webhookUrl: webhookUrl }, 'message', {
        fetch: async function() { return { ok: false, status: 404, text: async function() { return 'no_service'; } }; }
    }), /HTTP 404/);
});
