(function () {
  var data, current;
  var byId = function (id) { return document.getElementById(id); };
  var escape = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  function options(items, selected) { return (selected && !items.some(function (item) { return item.id === selected; }) ? '<option selected value="' + escape(selected) + '">已失效，请重新选择</option>' : '') + items.map(function (item) { return '<option value="' + escape(item.id) + '"' + (item.id === selected ? ' selected' : '') + '>' + escape(item.name) + '</option>'; }).join(''); }
  function users() { return data.users.map(function (u) { return { id: u.id, name: u.username + (u.enabled ? '' : '（已停用）') }; }); }
  function defaultPolicy(module) { return { enabled: true, defaultScope: module.kind === 'personal' ? 'self' : module.kind === 'publication' ? 'public' : 'service', own: { read: true, write: true }, service: { read: true, write: true }, instances: [], grants: [] }; }
  function policy() { return data.policy.modules[current] || (data.policy.modules[current] = defaultPolicy(data.modules.find(function (m) { return m.id === current; }))); }
  function scopes() {
    var module = data.modules.find(function (m) { return m.id === current; });
    if (module.kind === 'instance') return [{ id: 'service', name: '当前共享服务' }].concat(policy().instances.map(function (id) { var s = data.services.find(function (s) { return s.id === id; }); return { id: 'instance:' + id, name: '独立实例：' + s.title }; }));
    return [{ id: module.kind === 'publication' ? 'public' : 'self', name: module.kind === 'publication' ? '博客动态（按文章可见范围）' : '我的数据' }].concat(
      data.policy.teams.map(function (t) { return { id: 'team:' + t.id, name: '共享空间：' + t.name }; }),
      users().map(function (u) { return { id: 'user:' + u.id, name: '指定用户：' + u.name }; }));
  }
  function checkbox(name, value, text) { return '<label><input type="checkbox" data-field="' + name + '"' + (value ? ' checked' : '') + '> ' + text + '</label>'; }
  function collectTeams() {
    data.policy.teams = Array.from(byId('policy-teams').children).map(function (row) { return { id: row.dataset.id, name: row.querySelector('input').value.trim(), ownerId: row.querySelector('select').value }; });
  }
  function renderTeams() {
    byId('policy-teams').innerHTML = data.policy.teams.map(function (t) { return '<div data-id="' + escape(t.id) + '"><label>空间名称<input type="text" maxlength="80" value="' + escape(t.name) + '"></label><label>数据所属账号<select>' + options([{id:'',name:'请选择数据所属账号'}].concat(users()), t.ownerId) + '</select></label><button type="button" class="btn ghost" data-remove-team>删除空间定义</button></div>'; }).join('');
  }
  function collectModule() {
    if (!current) return;
    var p = policy(), root = byId('policy-module-editor');
    ['enabled', 'own-read', 'own-write', 'service-read', 'service-write'].forEach(function (field) { var el = root.querySelector('[data-field="' + field + '"]'); if (!el) return; if (field === 'enabled') p.enabled = el.checked; else { var parts = field.split('-'); p[parts[0]][parts[1]] = el.checked; } });
    p.defaultScope = root.querySelector('[data-default]').value;
    p.grants = Array.from(byId('policy-grants').children).map(function (row) { var principal = row.querySelector('[data-principal]').value.split(':'); return { kind: principal.shift(), id: principal.join(':'), scope: row.querySelector('[data-scope]').value, read: row.querySelector('[data-read]').checked, write: row.querySelector('[data-write]').checked }; });
  }
  function renderModule() {
    var module = data.modules.find(function (m) { return m.id === current; }), p = policy();
    byId('policy-kind').textContent = module.kind === 'instance' ? '此模块管理共享服务。需要隔离时，请先部署并注册独立实例，再为不同用户或角色授权实例；不会把同一套全局配置伪装成个人数据。' : module.kind === 'publication' ? '默认保留博客的公开范围和作者权限；切换指定用户或共享空间后，仅查看该账号的数据。' : '默认访问自己的数据。共享空间及指定用户的数据必须另行授权。';
    byId('policy-module-editor').innerHTML = checkbox('enabled', p.enabled, '启用模块')
      + (module.kind === 'personal' ? checkbox('own-read', p.own.read, '默认允许读取自己的数据') + checkbox('own-write', p.own.write, '默认允许修改自己的数据') : checkbox('service-read', p.service.read, '默认允许读取当前共享服务/动态') + checkbox('service-write', p.service.write, '默认允许修改当前共享服务/动态'))
      + '<label>默认数据范围<select data-default>' + options(scopes(), p.defaultScope) + '</select></label>'
      + (module.kind === 'instance' ? '<label>可授权的独立实例<select data-instances multiple size="5">' + data.services.filter(function (s) { return s.id !== current; }).map(function (s) { return '<option value="' + escape(s.id) + '"' + (p.instances.includes(s.id) ? ' selected' : '') + '>' + escape(s.title) + '</option>'; }).join('') + '</select></label>' : '');
    var principals = users().map(function (u) { return { id: 'user:' + u.id, name: '用户：' + u.name }; }).concat(data.roles.map(function (r) { return { id: 'role:' + r.id, name: '角色：' + r.name }; }));
    byId('policy-grants').innerHTML = p.grants.map(function (g) { return '<div><label>授权对象<select data-principal>' + options(principals, g.kind + ':' + g.id) + '</select></label><label>数据范围<select data-scope>' + options(scopes(), g.scope) + '</select></label><label><input type="checkbox" data-read' + (g.read ? ' checked' : '') + '> 查看</label><label><input type="checkbox" data-write' + (g.write ? ' checked' : '') + '> 修改</label><button class="btn ghost" type="button" data-remove-grant>移除授权</button></div>'; }).join('');
    byId('policy-editor').querySelectorAll('input,select,button').forEach(function (el) { if (el.id !== 'policy-module') el.disabled = !data.canEdit; });
  }
  async function load() {
    try {
      var response = await fetch('/api/admin/data-policy'), body = await response.json();
      if (!response.ok) throw new Error(body.error || '加载失败');
      data = body; current = data.modules[0].id;
      byId('policy-module').innerHTML = options(data.modules.map(function (m) { return { id: m.id, name: m.title }; }), current);
      byId('policy-default-permissions').innerHTML = data.permissions.map(function (p) { return '<label><input type="checkbox" value="' + escape(p.id) + '"' + (data.policy.memberPermissions.includes(p.id) ? ' checked' : '') + (data.canEdit ? '' : ' disabled') + '> ' + escape(p.name) + '</label>'; }).join('');
      renderTeams(); renderModule(); byId('policy-editor').hidden = false; byId('policy-save').disabled = !data.canEdit;
      byId('policy-status').textContent = data.canEdit ? '修改后统一保存。已有数据保持原归属。' : '当前仅有查看权限。';
    } catch (error) { byId('policy-status').textContent = error.message; byId('policy-save').disabled = true; }
  }
  document.querySelector('[data-tab="data-policy"]').addEventListener('click', function () { if (!data) load(); });
  byId('policy-module').addEventListener('change', function () { collectModule(); collectTeams(); current = this.value; renderModule(); });
  byId('policy-add-team').addEventListener('click', function () { collectModule(); collectTeams(); data.policy.teams.push({ id: 'team_' + crypto.randomUUID().replaceAll('-', ''), name: '新共享空间', ownerId: '' }); renderTeams(); renderModule(); });
  byId('policy-add-grant').addEventListener('click', function () { collectModule(); collectTeams(); policy().grants.push({ kind: 'user', id: data.users[0].id, scope: scopes()[0].id, read: true, write: false }); renderModule(); });
  byId('policy-teams').addEventListener('click', function (event) { if (event.target.closest('[data-remove-team]')) { collectModule(); event.target.closest('[data-id]').remove(); collectTeams(); renderModule(); } });
  byId('policy-teams').addEventListener('change', function () { collectModule(); collectTeams(); renderModule(); });
  byId('policy-grants').addEventListener('click', function (event) { if (event.target.closest('[data-remove-grant]')) event.target.closest('div').remove(); });
  byId('policy-module-editor').addEventListener('change', function (event) { if (event.target.matches('[data-instances]')) { collectModule(); policy().instances = Array.from(event.target.selectedOptions).map(function (o) { return o.value; }); renderModule(); } });
  byId('policy-save').addEventListener('click', async function () {
    if (!data || !data.canEdit) return;
    collectModule(); collectTeams(); data.policy.memberPermissions = Array.from(byId('policy-default-permissions').querySelectorAll('input:checked')).map(function (el) { return el.value; });
    this.disabled = true;
    try { var response = await fetch('/api/admin/data-policy', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data.policy) }), result = await response.json(); if (!response.ok) throw new Error(result.error || '保存失败'); data.policy = result.policy; byId('policy-status').textContent = '访问策略已保存，后续请求按新授权校验。'; }
    catch (error) { byId('policy-status').textContent = error.message; }
    finally { this.disabled = false; }
  });
})();
