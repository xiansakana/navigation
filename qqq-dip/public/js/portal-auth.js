const QQQ_DIP_SERVICE = 'qqq-dip';

let ctx = {
  portal: false,
  permissions: []
};

function featurePermId(feature, action) {
  return `service:${QQQ_DIP_SERVICE}:${feature}:${action}`;
}

export function isPortalMode() {
  return ctx.portal;
}

export function getPermissions() {
  return ctx.permissions;
}

export function can(feature, action = 'view') {
  if (!ctx.portal) return true;
  const perms = ctx.permissions;
  if (perms.includes('*')) return true;
  if (action === 'edit' && perms.includes(`service:${QQQ_DIP_SERVICE}:edit`)) return true;
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
      permissions: data.permissions || []
    };
    return ctx;
  } catch {
    return null;
  }
}
