import { normalizeQqMentions } from '../../shared/integrations/qq-mentions.js';

export const DEFAULT_CHAIN_NOTIFY = { qq: { enabled: false }, slack: { enabled: false }, targets: [] };

export function chainNotifySettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('无效通知配置');
  if (!Array.isArray(input.targets) || input.targets.length > 20) throw new Error('QQ 目标最多 20 个');
  for (const channel of ['qq', 'slack']) if (typeof input[channel]?.enabled !== 'boolean') throw new Error('请设置通知渠道开关');
  const targets = input.targets.map((target, index) => {
    if (!target || !['private', 'group'].includes(target.type)) throw new Error('通知类型无效');
    const row = { id: String(index), type: target.type, userId: String(target.userId || '').trim(), groupId: String(target.groupId || '').trim(), atUserId: String(target.atUserId || '').trim() };
    if (!/^\d{5,20}$/.test(row.type === 'private' ? row.userId : row.groupId)) throw new Error('请填写有效的 QQ 号或群号');
    row.atUserId = normalizeQqMentions(row.atUserId);
    if (row.type === 'private') { row.groupId = ''; row.atUserId = ''; } else row.userId = '';
    return row;
  });
  if (input.qq.enabled && !targets.length) throw new Error('启用 QQ 推送时请添加通知目标');
  return { qq: { enabled: input.qq.enabled }, slack: { enabled: input.slack.enabled }, targets };
}

// Reuse notification management's authenticated delivery API. Destinations are
// saved per Portal user, never imported from another user's global settings.
export function createChainNotifier({ endpoint, token, fetchImpl = fetch }) {
  return async (settings, row) => {
    const targets = [...(settings.qq.enabled ? settings.targets.map(target => ({ channel: 'qq', ...target })) : []), ...(settings.slack.enabled ? [{ channel: 'slack' }] : [])];
    if (!targets.length) return { skipped: true };
    const url = new URL('/notify', endpoint);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol) || !token) throw new Error('通知管理连接或认证尚未配置');
    const message = row ? `[Torn Chain] ${row.name} · ${row.hits} hits 刚进入冷却\nhttps://www.torn.com/war.php?step=chainreport&chainID=${Number(row.id)}` : '[Torn Chain] 测试通知 · 配置正常';
    let failed = 0;
    for (const target of targets) {
      try {
        const response = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ ...target, message }), signal: AbortSignal.timeout(10000), redirect: 'error' });
        const data = await response.json();
        if (!response.ok || data.ok !== true) failed++;
      } catch { failed++; }
    }
    if (failed) throw new Error(`${failed} 个通知目标投递失败，请检查通知管理渠道配置（不自动重试）`);
    return { sent: targets.length };
  };
}
