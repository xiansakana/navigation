/**
 * NapCat OneBot 11 HTTP 客户端
 * @see https://napneko.github.io/onebot/api
 * @see https://napneko.github.io/develop/api
 */

function buildHeaders(accessToken) {
    const headers = { 'Content-Type': 'application/json; charset=utf-8' };
    if (accessToken) headers.Authorization = 'Bearer ' + accessToken;
    return headers;
}

async function callNapCat(baseUrl, accessToken, action, params) {
    const url = baseUrl.replace(/\/$/, '') + '/' + action;
    const resp = await fetch(url, {
        method: 'POST',
        headers: buildHeaders(accessToken),
        body: JSON.stringify(params)
    });

    let data;
    try {
        data = await resp.json();
    } catch {
        data = { raw: await resp.text() };
    }

    if (!resp.ok) {
        const msg = data.message || data.wording || data.raw || resp.statusText;
        throw new Error('NapCat ' + action + ' 失败 (' + resp.status + '): ' + msg);
    }

    if (data.status === 'failed' || data.retcode !== undefined && data.retcode !== 0) {
        throw new Error('NapCat ' + action + ' 返回错误: ' + (data.message || data.wording || JSON.stringify(data)));
    }

    return data;
}

export async function sendPrivateMsg(baseUrl, accessToken, userId, message) {
    return callNapCat(baseUrl, accessToken, 'send_private_msg', {
        user_id: String(userId),
        message: sanitizeOutgoingText(message)
    });
}

export async function sendGroupMsg(baseUrl, accessToken, groupId, message, atUserId) {
    var payload = {
        group_id: String(groupId),
        message: buildGroupMessage(message, atUserId)
    };
    return callNapCat(baseUrl, accessToken, 'send_group_msg', payload);
}

function sanitizeOutgoingText(text) {
    // NapCat 在解析消息时会将 $1、$2 等当作 CQ 反向引用吞掉
    return String(text).replace(/\$/g, '\uFF04');
}

function buildGroupMessage(text, atUserId) {
    var content = sanitizeOutgoingText(text);
    if (!atUserId) return content;
    return [
        { type: 'at', data: { qq: String(atUserId) } },
        { type: 'text', data: { text: ' ' + content } }
    ];
}

export async function sendMessage(napcatConfig, target, message) {
    const baseUrl = napcatConfig.baseUrl;
    const accessToken = napcatConfig.accessToken || '';

    if (target.type === 'group') {
        if (!target.groupId) throw new Error('发送群消息需要 groupId');
        return sendGroupMsg(baseUrl, accessToken, target.groupId, message, target.atUserId);
    }

    if (!target.userId) throw new Error('发送私聊需要 userId');
    return sendPrivateMsg(baseUrl, accessToken, target.userId, message);
}

export async function getLoginInfo(baseUrl, accessToken) {
    return callNapCat(baseUrl, accessToken, 'get_login_info', {});
}
