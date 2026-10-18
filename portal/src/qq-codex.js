import { sameOriginWrite } from '../../shared/http.js';
import { codexConfig } from '../../shared/runtime-config.js';
import { getDatabase } from '../../shared/db/index.js';
import { createCodexStore } from '../../shared/codex/codex-store.js';
import { hasPermission } from './rbac.js';

export function codexProvisioning(uid) {
  try {
    const config = {codex:codexConfig()};
    const user = config.codex?.allowedUsers?.find(u => u.userId === uid);
    return { enabled: config.codex?.enabled === true, configured: !!user, projects: user?.projects || [] };
  } catch { return { enabled: false, configured: false, projects: [] }; }
}
export async function handleQqCodexApi(req, res, url, session, json, provision = codexProvisioning) {
  res.setHeader('Cache-Control', 'no-store');
  const can = action => !!session?.userId && !session.isGuest && hasPermission(session.permissions || [], 'qq-codex:' + action);
  if (!can('settings:view') || !can('execute')) return json(res, 403, { ok: false, error: '无权管理QQ Codex设置' });
  if (url.pathname !== '/api/qq-codex/settings') return json(res, 404, { ok: false, error: '接口不存在' });
  const setup = provision(session.userId);
  if (!['GET', 'PUT'].includes(req.method)) return json(res, 405, { ok: false, error: '不支持此方法' });
  if (req.method === 'PUT' && !can('settings:edit')) return json(res, 403, { ok: false, error: '无权保存QQ Codex设置' });
  if (req.method === 'PUT' && (!sameOriginWrite(req))) return json(res, 403, { ok: false, error: '不允许跨站写入' });
  try {
    const store = createCodexStore(getDatabase());
    if (req.method === 'PUT') {
      if (!setup.configured) return json(res, 403, { ok: false, error: '尚未为当前账号配置Codex执行权限，请联系管理员' });
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 8192) return json(res, 413, { ok: false, error: '设置内容过长' }); chunks.push(chunk); }
      let input;
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('设置格式无效'); }
      store.saveSettings(session.userId, input);
    }
    return json(res, 200, { ok: true, ...setup, ...store.settings(session.userId) });
  } catch (e) { return json(res, 400, { ok: false, error: e.code?.startsWith('SQLITE_') ? '设置保存失败，请重试' : e.message }); }
}
