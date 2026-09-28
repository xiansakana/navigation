import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { classifyResetOpportunity, parseRss, deliverToChannels, fetchText } from './tibo-reset-monitor.js';

test('tweet source uses IPv4 HTTPS transport and reports response failures', async function() {
    var requestOptions;
    var fakeGet = function(url, options, callback) {
        requestOptions = options;
        queueMicrotask(function() {
            var response = Readable.from(['{"tweets":[]}']);
            response.statusCode = 200;
            response.headers = {};
            callback(response);
        });
        return new EventEmitter();
    };
    assert.equal(await fetchText('https://codex-reset.com/api/feed', { request: fakeGet }), '{"tweets":[]}');
    assert.equal(requestOptions.family, 4);
    await assert.rejects(fetchText('http://codex-reset.com/api/feed', { request: fakeGet }), /HTTPS/);
});

test('classifies confirmed, announced and possible reset signals', function() {
    assert.equal(classifyResetOpportunity({ text: 'Reset all propagated. Sweet dreams.' }).level, 'confirmed');
    assert.equal(classifyResetOpportunity({ text: 'We will do a full reset of usage for all paid Codex subscriptions by midnight today.' }).level, 'announced');
    assert.equal(classifyResetOpportunity({ text: 'When I say excellent service for existing users, that includes the occasional reset.' }).level, 'possible');
    assert.equal(classifyResetOpportunity({ text: 'What is a feature we should remove from Codex?' }).relevant, false);
});

test('flags future remediation of Codex usage as a low-confidence opportunity', function() {
    var result = classifyResetOpportunity({ text: 'We found a Codex usage issue and will ship fixes tomorrow.' });
    assert.equal(result.level, 'possible');
    assert.equal(result.confidence, 'low');
});

test('parses public RSS items into canonical X tweets', function() {
    var tweets = parseRss('<?xml version="1.0"?><rss><channel><item>'
        + '<title><![CDATA[Reset <b>soon</b> &amp; enjoy]]></title>'
        + '<pubDate>Wed, 16 Sep 2026 07:19:52 GMT</pubDate>'
        + '<guid isPermaLink="false">2100122479947817059</guid>'
        + '<link>https://x.noodl3.net/thsottiaux/status/2100122479947817059</link>'
        + '</item></channel></rss>');
    assert.equal(tweets.length, 1);
    assert.equal(tweets[0].text, 'Reset soon & enjoy');
    assert.equal(tweets[0].url, 'https://x.com/thsottiaux/status/2100122479947817059');
});

test('failed Slack delivery resumes without repeating QQ', async function() {
    var config = { monitors: { tiboReset: { channels: ['qq', 'slack'] } } };
    var sent = [];
    var checkpoint = [];
    await assert.rejects(deliverToChannels(config, 'signal', [], async function(_, channel) {
        sent.push(channel);
        if (channel === 'slack') throw new Error('temporarily unavailable');
    }, function(channels) { checkpoint = channels; }), /temporarily unavailable/);
    assert.deepEqual(checkpoint, ['qq']);
    await deliverToChannels(config, 'signal', checkpoint, async function(_, channel) {
        sent.push(channel);
    });
    assert.deepEqual(sent, ['qq', 'slack', 'slack']);
});
