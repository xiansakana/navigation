const STOCK_MANAGE_SERVICE = 'stock-manage';

let ctx = {
  portal: false,
  permissions: [],
  prefs: { stockManage: {} }
};

function featurePermId(feature, action) {
  return `service:${STOCK_MANAGE_SERVICE}:${feature}:${action}`;
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
  const perms = ctx.permissions;
  if (perms.includes('*')) return true;
  const fid = featurePermId(feature, action);
  if (perms.includes(fid)) return true;
  if (action === 'view' && perms.includes(featurePermId(feature, 'edit'))) return true;
  return false;
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
