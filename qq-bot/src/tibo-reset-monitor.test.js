import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { classifyResetOpportunity, parseRss, deliverToChannels, fetchText, fetchSourceText, startTiboResetMonitor } from './tibo-reset-monitor.js';

const contextParent = { id: '100', text: 'Day 20/ Rest and reset', at: '2026-10-25T03:39:31Z', kind: 'other' };
const contextReply = { id: '101', text: 'By midnight PST', at: '2026-10-25T03:40:04Z', in_reply_to_tweet_id: '100', kind: 'signal', tibo_lane: 'reset_related' };

test('reset day announcements and explicit timed replies use parent context, not unrelated conversations', () => {
    assert.equal(classifyResetOpportunity(contextParent).relevant, true);
    assert.equal(classifyResetOpportunity(contextReply, [contextParent]).level, 'announced');
    assert.equal(classifyResetOpportunity(contextReply).level, 'possible');
    assert.equal(classifyResetOpportunity({ text: 'By midnight PST', conversation_id: '100' }, [contextParent]).relevant, false);
    assert.equal(classifyResetOpportunity({ text: 'Thanks!', in_reply_to_tweet_id: '100' }, [contextParent]).relevant, false);
    assert.equal(classifyResetOpportunity({ ...contextReply, text: 'No reset tonight' }, [contextParent]).relevant, false);
    assert.equal(classifyResetOpportunity({ ...contextReply, text: 'We will not reset usage today' }, [contextParent]).relevant, false);
});

function monitorFixture(initial, tweets, send) {
    var stored = structuredClone(initial);
    const config = { monitors: { tiboReset: { enabled: true, channels: ['qq', 'slack'] } } };
    const create = () => startTiboResetMonitor(() => config, {
        schedule: false, now: () => Date.parse('2026-10-25T04:00:00Z'),
        readState: () => structuredClone(stored), writeState: value => { stored = structuredClone(value); },
        fetchTweets: async () => tweets, send
    });
    return { create, state: () => stored };
}

test('legacy negative is reclassified and delivered once; unknown historical seen IDs are not replayed', async () => {
    const sent = [];
    const fixture = monitorFixture({ initialized: true, seenIds: ['100', '101'], lastTweet: { ...contextReply, decision: { relevant: false } } }, [contextParent, contextReply], async (_, channel, message) => { sent.push(channel); assert.match(message, /回复上下文：Day 20/); });
    const m = fixture.create(); await m.checkNow(); await m.checkNow();
    assert.deepEqual(sent, ['qq', 'slack']);
    assert.equal(fixture.state().lastSignal.id, '101');
    assert.equal(fixture.state().decisions['101'].level, 'announced');
    await fixture.create().checkNow(); assert.equal(sent.length, 2);
});

test('recent negative replies recover when the parent appears later; expired negatives stay suppressed', async () => {
    const tweets = [{ ...contextReply, kind: 'other' }], sent = [];
    const fixture = monitorFixture({ initialized: true, seenIds: [] }, tweets, async (_, channel) => { sent.push(channel); });
    const m = fixture.create(); await m.checkNow(); assert.equal(sent.length, 0);
    tweets.push(contextParent); await m.checkNow(); assert.equal(sent.length, 4);
    const expired = { ...contextReply, at: '2026-10-24T00:00:00Z' };
    const old = monitorFixture({ initialized: true, seenIds: ['100', '101'], lastTweet: { ...expired, decision: { relevant: false } } }, [contextParent, expired], async () => { throw new Error('must not replay'); });
    assert.equal((await old.create().checkNow()).lastError, null);
    assert.equal(old.state().lastSignal, null);
});

test('reclassified delivery resumes after restart without repeating successful QQ or completed signals', async () => {
    const sent = []; let fail = true;
    const fixture = monitorFixture({ initialized: true, seenIds: ['100', '101'], lastTweet: { ...contextReply, decision: { relevant: false } } }, [contextParent, contextReply], async (_, channel) => {
        if (channel === 'slack' && fail) throw new Error('slack unavailable');
        sent.push(channel);
    });
    assert.match((await fixture.create().checkNow()).lastError, /slack/);
    assert.deepEqual(fixture.state().sentChannels['101'], ['qq']);
    fail = false; await fixture.create().checkNow(); await fixture.create().checkNow();
    assert.deepEqual(sent, ['qq', 'slack']);
});

test('first initialization still baselines history without sending old reset messages', async () => {
    const fixture = monitorFixture({ initialized: false, seenIds: [] }, [contextParent, contextReply], async () => { throw new Error('must not send'); });
    const m = fixture.create(); assert.equal((await m.checkNow()).lastError, null);
    await m.checkNow(); assert.deepEqual(fixture.state().seenIds, ['100', '101']);
});

test('feed source tries resolved addresses while keeping the original HTTPS hostname', async function() {
    var signals = [];
    var attempted = [];
    var text = await fetchSourceText('https://feed.example/api/feed', {
        resolve: async function() { return [{ address: '192.0.2.1' }, { address: '192.0.2.2' }]; },
        read: async function(url, options) {
            assert.equal(new URL(url).hostname, 'feed.example');
            signals.push(options.signal);
            var address;
            options.lookup('feed.example', {}, function(error, value) { assert.equal(error, null); address = value; });
            attempted.push(address);
            if (address === '192.0.2.1') throw new Error('connection failed');
            return 'feed';
        }
    });
    assert.equal(text, 'feed');
    assert.deepEqual(attempted, ['192.0.2.1', '192.0.2.2']);
    assert.ok(signals.every(function(signal) { return signal.aborted; }));
});

test('feed retries network failure once but does not retry an HTTP 404', async function() {
    for (var message of ['connection failed', 'feed.example 返回 HTTP 404']) {
        var attempts = 0;
        await assert.rejects(fetchSourceText('https://feed.example/api/feed', {
            resolve: async function() { return [{ address: '192.0.2.1' }]; },
            read: async function() { attempts++; throw new Error(message); }
        }), new RegExp(message));
        assert.equal(attempts, message.includes('404') ? 1 : 2);
    }
});

test('tweet transport requests compression and decodes gzip, deflate and brotli feeds', async function() {
    for (var [encoding, compress] of [['gzip', gzipSync], ['deflate', deflateSync], ['br', brotliCompressSync]]) {
        var request = function(url, options, callback) {
            assert.match(options.headers['Accept-Encoding'], /gzip/);
            queueMicrotask(function() {
                var response = Readable.from([compress(Buffer.from('{"tweets":[]}'))]);
                response.statusCode = 200;
                response.headers = { 'content-encoding': encoding };
                callback(response);
            });
            return new EventEmitter();
        };
        assert.equal(await fetchText('https://feed.example/feed', { request }), '{"tweets":[]}');
    }
});

test('tweet transport imposes an overall deadline even without socket timeout events', async function() {
    var destroyed = false;
    var request = function() {
        var req = new EventEmitter();
        req.destroy = function() { destroyed = true; };
        return req;
    };
    await assert.rejects(fetchText('https://feed.example/feed', { request, timeoutMs: 20 }), /请求超时/);
    assert.equal(destroyed, true);
});

test('Tibo delivers custom targets and resumes at the failed QQ target', async function() {
    var config = { monitors: { tiboReset: { channels: ['qq', 'slack'], qq: { useDefaultTarget: false, targets: [
        { id: 'a', type: 'group', groupId: '123', atUserId: 'all' },
        { id: 'b', type: 'private', userId: '456' }
    ] } } } };
    var checkpoint = [];
    var delivered = [];
    var fail = true;
    var sender = async function(_, channel, message, target) {
        if (target?.id === 'b' && fail) throw new Error('retry');
        delivered.push(target || channel);
    };
    await assert.rejects(deliverToChannels(config, 'signal', [], sender, function(sent) { checkpoint = sent; }), /qq:b/);
    assert.deepEqual(checkpoint, ['qq:a', 'slack']);
    fail = false;
    await deliverToChannels(config, 'signal', checkpoint, sender);
    assert.deepEqual(delivered, [config.monitors.tiboReset.qq.targets[0], 'slack', config.monitors.tiboReset.qq.targets[1]]);
});

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
    }, function(channels) { checkpoint = channels; }), /slack/);
    assert.deepEqual(checkpoint, ['qq']);
    await deliverToChannels(config, 'signal', checkpoint, async function(_, channel) {
        sent.push(channel);
    });
    assert.deepEqual(sent, ['qq', 'slack', 'slack']);
});

test('a pending QQ transport never delays the independent Slack send', async () => {
    let releaseQq, slackDelivered;
    const qq = new Promise(resolve => { releaseQq = resolve; });
    const slack = new Promise(resolve => { slackDelivered = resolve; });
    const job = deliverToChannels({ monitors: { tiboReset: { channels: ['qq', 'slack'] } } }, 'signal', [], async (_, channel) => {
        if (channel === 'qq') await qq;
        else slackDelivered();
    });
    try { await Promise.race([slack, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Slack blocked by QQ')), 1000); timer.unref(); })]); }
    finally { releaseQq(); await job; }
});
