import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendMessage } from './napcat.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.resolve(__dirname, '../data/tibo-reset-state.json');
const MAX_SEEN = 300;

function decodeXml(text) {
    return String(text || '')
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
        .replace(/\s+/g, ' ').trim();
}

export function parseRss(xml) {
    var items = String(xml || '').match(/<item>[\s\S]*?<\/item>/g) || [];
    return items.map(function(item) {
        function field(name) {
            var match = item.match(new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + name + '>'));
            return match ? decodeXml(match[1]) : '';
        }
        var id = field('guid');
        var link = field('link') || ('https://x.com/thsottiaux/status/' + id);
        return { id: id, url: link.replace('x.noodl3.net/thsottiaux/status/', 'x.com/thsottiaux/status/'), text: field('title'), at: new Date(field('pubDate')).toISOString(), source: 'rss' };
    }).filter(function(tweet) { return /^\d+$/.test(tweet.id) && tweet.text; });
}

export function classifyResetOpportunity(tweet) {
    var text = String(tweet?.text || '').replace(/\s+/g, ' ').trim();
    var lower = text.toLowerCase();
    var reset = /\b(reset(?:ting|s)?|refill(?:ed|ing|s)?|replenish(?:ed|ment|ing)?)\b/.test(lower);
    var limits = /\b(codex|chatgpt work|usage|rate[ -]?limits?|paid (?:users|subscriptions?|plans?))\b/.test(lower);
    var future = /\b(will|going to|lands?|tomorrow|today|tonight|next hour|end of day|midnight|soon|coming|by \d|later)\b/.test(lower);
    var uncertain = /\b(may|might|maybe|possible|possibly|likely|chance|occasional|who says|if)\b|[?？]|👀/.test(lower);
    var complete = /\b(reset all propagated|have reset|has been reset|we(?:'ve| have)? reset|i(?:'ve| have)? reset|just reset|reset(?:ting)? (?:is )?(?:done|complete|completed|live|propagated))\b/.test(lower);
    var remediation = /\b(fix(?:ed|es|ing)?|investigat(?:e|ed|ing|ion)|issue|bug|outage|drain(?:ed|ing)?|inefficien)/.test(lower);
    var upstreamCandidate = tweet?.kind && tweet.kind !== 'other' && tweet.kind !== 'unrelated';

    if (reset && complete) return { level: 'confirmed', label: '已确认重置', confidence: 'high', relevant: true };
    if (reset && future && limits) return { level: 'announced', label: '即将重置', confidence: 'high', relevant: true };
    if (reset && future) return { level: 'announced', label: '疑似即将重置', confidence: 'medium', relevant: true };
    if (reset && (uncertain || limits || upstreamCandidate)) return { level: 'possible', label: '可能有重置机会', confidence: limits ? 'medium' : 'low', relevant: true };
    if (limits && remediation && future) return { level: 'possible', label: '可能触发补偿重置', confidence: 'low', relevant: true };
    return { level: 'unrelated', label: '与额度重置无关', confidence: 'high', relevant: false };
}

function readState() {
    try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
    catch (_) { return { initialized: false, seenIds: [] }; }
}

function writeState(state) {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    var temp = STATE_PATH + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', 'utf8');
    fs.renameSync(temp, STATE_PATH);
}

async function fetchText(url) {
    var response = await fetch(url, {
        headers: { 'User-Agent': 'navigation-notification-monitor/1.0' },
        signal: AbortSignal.timeout(20_000)
    });
    if (!response.ok) throw new Error(url + ' 返回 HTTP ' + response.status);
    return response.text();
}

async function fetchTweets(options) {
    var results = await Promise.allSettled([fetchText(options.feedUrl), fetchText(options.rssUrl)]);
    var tweets = [];
    var errors = [];
    if (results[0].status === 'fulfilled') {
        try {
            var feed = JSON.parse(results[0].value);
            if (feed.profile?.handle !== 'thsottiaux' || !Array.isArray(feed.tweets)) throw new Error('feed 身份或结构异常');
            tweets.push(...feed.tweets.map(function(tweet) { return { ...tweet, id: String(tweet.id), source: 'feed' }; }));
        } catch (err) { errors.push(err.message); }
    } else errors.push(results[0].reason.message);
    if (results[1].status === 'fulfilled') {
        try { tweets.push(...parseRss(results[1].value)); }
        catch (err) { errors.push(err.message); }
    } else errors.push(results[1].reason.message);
    var byId = new Map();
    tweets.forEach(function(tweet) {
        if (!/^\d+$/.test(tweet.id || '') || !tweet.text) return;
        var old = byId.get(tweet.id);
        byId.set(tweet.id, old ? Object.assign({}, tweet, old) : tweet);
    });
    if (!byId.size) throw new Error('两个推文源均未返回有效数据：' + errors.join('；'));
    return Array.from(byId.values()).sort(function(a, b) { return new Date(a.at) - new Date(b.at); });
}

function formatMessage(tweet, decision) {
    var time = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(tweet.at));
    var confidence = { high: '高', medium: '中', low: '低' }[decision.confidence] || decision.confidence;
    var excerpt = String(tweet.text).length > 500 ? String(tweet.text).slice(0, 500) + '…' : String(tweet.text);
    return [
        '🔔 Codex 额度重置信号',
        '判断：' + decision.label + '（置信度：' + confidence + '）',
        '时间：' + time,
        '',
        excerpt,
        '',
        tweet.url || ('https://x.com/thsottiaux/status/' + tweet.id),
        '',
        '提示：这是基于公开推文的判断，实际额度请以 Codex Usage 页面为准。'
    ].join('\n');
}

export function startTiboResetMonitor(getConfig, hooks) {
    var state = readState();
    var timer = null;
    var running = false;
    var runtime = { lastCheckedAt: state.lastCheckedAt || null, lastError: null, lastTweet: state.lastTweet || null, lastSignal: state.lastSignal || null };

    async function checkNow() {
        if (running) return runtime;
        var config = getConfig();
        var options = config.monitors?.tiboReset || {};
        if (!options.enabled) return runtime;
        running = true;
        try {
            var tweets = await fetchTweets(options);
            var seen = new Set(state.seenIds || []);
            if (!state.initialized) {
                tweets.forEach(function(tweet) { seen.add(tweet.id); });
                state.initialized = true;
                state.initializedAt = new Date().toISOString();
            } else {
                for (var tweet of tweets) {
                    if (seen.has(tweet.id)) continue;
                    var decision = classifyResetOpportunity(tweet);
                    runtime.lastTweet = { id: tweet.id, text: tweet.text, at: tweet.at, url: tweet.url, decision: decision };
                    if (decision.relevant) {
                        await sendMessage(config.napcat, {
                            type: config.defaultTarget.type || 'private',
                            userId: config.defaultTarget.userId,
                            groupId: config.defaultTarget.groupId,
                            atUserId: config.defaultTarget.atUserId
                        }, formatMessage(tweet, decision));
                        runtime.lastSignal = runtime.lastTweet;
                        hooks?.onSignal?.(runtime.lastSignal);
                    }
                    seen.add(tweet.id);
                }
            }
            state.seenIds = Array.from(seen).slice(-MAX_SEEN);
            state.lastCheckedAt = new Date().toISOString();
            state.lastTweet = runtime.lastTweet;
            state.lastSignal = runtime.lastSignal;
            runtime.lastCheckedAt = state.lastCheckedAt;
            runtime.lastError = null;
            writeState(state);
        } catch (err) {
            runtime.lastCheckedAt = new Date().toISOString();
            runtime.lastError = err.message || String(err);
            console.warn('[tibo-reset] 检查失败: ' + runtime.lastError);
        } finally { running = false; }
        return runtime;
    }

    function schedule() {
        clearInterval(timer);
        var minutes = Math.max(1, Math.min(60, Number(getConfig().monitors?.tiboReset?.intervalMinutes) || 5));
        timer = setInterval(checkNow, minutes * 60_000);
        timer.unref?.();
    }

    schedule();
    setTimeout(checkNow, 5_000).unref?.();
    return { checkNow: checkNow, status: function() { return { ...runtime, running: running, initialized: !!state.initialized }; }, reschedule: schedule, stop: function() { clearInterval(timer); } };
}
