import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
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

export function fetchText(url, options) {
    var request = options?.request || https.get;
    var current = new URL(url);
    if (current.protocol !== 'https:') return Promise.reject(new Error('推文源必须使用 HTTPS'));
    return new Promise(function(resolve, reject) {
        var req = request(current, {
            family: 4,
            timeout: 20_000,
            headers: { 'User-Agent': 'navigation-notification-monitor/1.0' }
        }, function(response) {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                response.resume();
                if ((options?.redirects || 0) >= 3) return reject(new Error('推文源重定向次数过多'));
                var next = new URL(response.headers.location, current);
                fetchText(next, { request: request, redirects: (options?.redirects || 0) + 1 }).then(resolve, reject);
                return;
            }
            if (response.statusCode !== 200) {
                response.resume();
                return reject(new Error(current.hostname + ' 返回 HTTP ' + response.statusCode));
            }
            var chunks = [];
            var bytes = 0;
            response.on('data', function(chunk) {
                bytes += chunk.length;
                if (bytes > 5 * 1024 * 1024) {
                    response.destroy(new Error('推文源响应过大'));
                    return;
                }
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            });
            response.on('end', function() { resolve(Buffer.concat(chunks).toString('utf8')); });
            response.on('error', reject);
        });
        req.on('timeout', function() { req.destroy(new Error(current.hostname + ' 连接超时')); });
        req.on('error', reject);
    });
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

export async function deliverToChannels(config, message, alreadySent, send, onDelivered) {
    var sent = new Set(alreadySent || []);
    for (var channel of config.monitors?.tiboReset?.channels || ['qq']) {
        if (sent.has(channel)) continue;
        await send(config, channel, message);
        sent.add(channel);
        onDelivered?.(Array.from(sent));
    }
    return Array.from(sent);
}

export function startTiboResetMonitor(getConfig, hooks) {
    var state = readState();
    state.sentChannels = state.sentChannels || {};
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
                        await deliverToChannels(config, formatMessage(tweet, decision), state.sentChannels[tweet.id],
                            async function(currentConfig, channel, message) {
                                if (hooks?.send) return hooks.send(currentConfig, channel, message);
                                if (channel !== 'qq') throw new Error('监听器缺少 ' + channel + ' 发送器');
                                return sendMessage(currentConfig.napcat, {
                                    type: currentConfig.defaultTarget.type || 'private',
                                    userId: currentConfig.defaultTarget.userId,
                                    groupId: currentConfig.defaultTarget.groupId,
                                    atUserId: currentConfig.defaultTarget.atUserId
                                }, message);
                            }, function(sent) {
                                state.sentChannels[tweet.id] = sent;
                                writeState(state);
                            });
                        delete state.sentChannels[tweet.id];
                        runtime.lastSignal = runtime.lastTweet;
                        hooks?.onSignal?.(runtime.lastSignal);
                    }
                    seen.add(tweet.id);
                }
            }
            state.seenIds = Array.from(seen).slice(-MAX_SEEN);
            Object.keys(state.sentChannels).forEach(function(id) {
                if (seen.has(id)) delete state.sentChannels[id];
            });
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
