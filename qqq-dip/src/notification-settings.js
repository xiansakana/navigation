import { timingSafeEqual } from 'node:crypto';
import { maskNotifyForClient } from './notify.js';

// Notification management has its own service identity; it must not impersonate a portfolio user.
export function createInternalNotificationSettingsHandler({ getToken, getNotify, getStatus }) {
  return (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)) {
      return res.status(403).json({ ok: false, error: '内部提醒接口仅允许本机服务访问' });
    }
    const token = getToken();
    if (!token) return res.status(503).json({ ok: false, error: '未配置通知服务认证 Token' });
    const supplied = Buffer.from(String(req.headers.authorization || ''));
    const expected = Buffer.from('Bearer ' + token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return res.status(401).json({ ok: false, error: '通知服务认证失败' });
    }
    const legacy = maskNotifyForClient(getNotify());
    const status = getStatus();
    return res.json({
      ok: true,
      notify: { desktop: legacy.desktop, qq: { enabled: legacy.qq.enabled }, slack: legacy.slack, targets: legacy.targets, events: legacy.events },
      monitor: { running: !!status.running, checks: status.checks || 0 }
    });
  };
}
