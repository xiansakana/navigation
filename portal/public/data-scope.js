(async function () {
  if (/^\/(?:admin|login|api)(?:\/|\.)/.test(location.pathname)) return;
  try {
    var response = await fetch('/api/me/data-scopes?path=' + encodeURIComponent(location.pathname));
    if (!response.ok) return;
    var data = await response.json(), module = { id: data.module };
    var container = document.querySelector('.navbar-actions, .navbar-inner, .error-actions, .error-card');
    if (!container) return;
    var label = document.createElement('label'), select = document.createElement('select');
    label.className = 'portal-data-scope'; label.textContent = '数据范围 ';
    label.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:13px;min-width:0';
    select.style.cssText = 'max-width:180px;min-width:0;padding:6px;border:1px solid var(--border);border-radius:7px;background:var(--card);color:var(--text)';
    select.setAttribute('aria-label', '当前模块的数据范围');
    if (!data.selected) { var placeholder = document.createElement('option'); placeholder.textContent = '请选择有权访问的数据范围'; placeholder.value = ''; placeholder.disabled = true; placeholder.selected = true; select.append(placeholder); }
    data.scopes.forEach(function (scope) { var option = document.createElement('option'); option.value = scope.scope; option.textContent = scope.label + (scope.writable ? '' : '（只读）'); option.selected = scope.scope === data.selected; select.append(option); });
    if (!data.scopes.length) { label.textContent = '当前账号没有数据范围授权'; container.prepend(label); return; }
    select.addEventListener('change', async function () {
      select.disabled = true;
      try {
        var saved = await fetch('/api/me/data-scopes?module=' + encodeURIComponent(module.id), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: select.value }) });
        var result = await saved.json(); if (!saved.ok) throw new Error(result.error || '切换失败');
        location.reload();
      } catch (error) { select.disabled = false; select.value = data.selected || ''; window.portalToast?.error(error.message); }
    });
    label.append(select); container.prepend(label);
  } catch { /* The module's API remains authoritative when the selector cannot load. */ }
})();
