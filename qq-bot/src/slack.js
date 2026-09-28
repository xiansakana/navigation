export function validateSlackWebhookUrl(value) {
    var url;
    try { url = new URL(value); }
    catch (_) { throw new Error('Slack Webhook URL 无效'); }
    if (url.protocol !== 'https:'
        || !['hooks.slack.com', 'hooks.slack-gov.com'].includes(url.hostname)
        || !/^\/services\/[^/]+\/[^/]+\/[^/]+$/.test(url.pathname)
        || url.username || url.password || url.port || url.search || url.hash) {
        throw new Error('Slack Webhook URL 必须是 Slack 提供的 HTTPS 地址');
    }
    return url.href;
}

export async function sendSlack(channel, message, options) {
    if (!channel?.webhookUrl) throw new Error('Slack Webhook URL 尚未配置');
    var webhookUrl = validateSlackWebhookUrl(channel.webhookUrl);
    var text = String(message);
    if (!text.includes('<!channel>')) text = '<!channel> ' + text;
    var response = await (options?.fetch || fetch)(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ text: text }),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) {
        var reason = (await response.text()).slice(0, 120).replace(/[\r\n]/g, ' ');
        throw new Error('Slack 发送失败 (HTTP ' + response.status + '): ' + reason);
    }
    return { ok: true };
}
