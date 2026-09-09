const STOCK_MANAGE_SERVICE = 'stock-manage';
const QQQ_DIP_SERVICE = 'qqq-dip';

let ctx = {
  portal: false,
  permissions: [],
  prefs: { stockManage: {} }
};

function featurePermId(service, feature, action) {
  return `service:${service}:${feature}:${action}`;
}

function checkPerm(service, feature, action) {
  const perms = ctx.permissions;
  if (perms.includes('*')) return true;
  if (action === 'edit' && perms.includes(`service:${service}:edit`)) return true;
  const fid = featurePermId(service, feature, action);
  if (perms.includes(fid)) return true;
  if (action === 'view' && perms.includes(featurePermId(service, feature, 'edit'))) return true;
  return false;
}

export function isPortalMode() {
  return ctx.portal;
}

export function getPermissions() {
  return ctx.permissions;
}

export function getStockManagePrefs() {
  return ctx.prefs.stockManage || {};
}

export function can(feature, action = 'view') {
  if (!ctx.portal) return true;
  return checkPerm(STOCK_MANAGE_SERVICE, feature, action);
}

export function canDip(feature, action = 'view') {
  if (!ctx.portal) return true;
  return checkPerm(QQQ_DIP_SERVICE, feature, action);
}

export async function loadPortalContext() {
  try {
    const res = await fetch('/api/me');
    if (!res.ok) return null;
    const data = await res.json();
    ctx = {
      portal: true,
      permissions: data.permissions || [],
      prefs: data.prefs || { stockManage: {} }
    };
    return ctx;
  } catch {
    return null;
  }
}

export async function saveStockManagePrefs(partial) {
  if (!ctx.portal) return null;
  const res = await fetch('/api/me/prefs', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stockManage: partial })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || res.statusText);
  if (data.prefs?.stockManage) ctx.prefs.stockManage = data.prefs.stockManage;
  return data.prefs?.stockManage;
}
