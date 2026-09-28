export async function publishBusinessEvent(config, event, options = {}) {
    const url = String(config?.qq?.url || '').trim();
    const token = String(config?.qq?.token || '').trim();
    if (!url || !token) throw new Error('通知管理事件上报地址或 Token 未配置');
    const endpoint = new URL('/api/business-events', url);
    if (endpoint.hostname !== '127.0.0.1' && endpoint.hostname !== 'localhost' && endpoint.hostname !== '[::1]') {
        throw new Error('业务事件只能上报到本机通知管理服务');
    }
    const response = await (options.fetch || fetch)(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(10000)
    });
    const result = await response.json();
    if (!response.ok || result.ok === false) throw new Error(result.error || '业务事件上报失败');
    return result.result;
}
