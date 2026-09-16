import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyResetOpportunity, parseRss } from './tibo-reset-monitor.js';

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
