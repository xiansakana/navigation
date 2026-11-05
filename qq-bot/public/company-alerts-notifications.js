(() => {
  const host = document.getElementById('company-salary-notifications');
  let state;
  async function request(method = 'GET', body) {
    const response = await fetch('/api/torn-company-alerts/salary/notifications' + (method === 'POST' ? '/test' : ''), { method, credentials: 'same-origin', ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    if (response.status === 403 && method === 'GET') { host.hidden = true; return null; }
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || '扣工资通知操作失败');
    return data;
  }
  function render() {
    host.hidden = false;
    host.innerHTML = '<article class="business-card" data-source="company-salary"><div class="business-card-head"><div><h3>Torn · 扣工资</h3><p>当前账号的扣工资提醒</p></div><a href="/torn-toolbox/company/#salary">打开监控 →</a></div>'
      + '<div class="biz-global"><label class="biz-check"><input data-company-salary-channel="qq" type="checkbox"' + (state.settings.qq.enabled ? ' checked' : '') + '> QQ 推送</label><label class="biz-check"><input data-company-salary-channel="slack" type="checkbox"' + (state.settings.slack.enabled ? ' checked' : '') + '> Slack 推送</label></div>'
      + '<p class="biz-hint">推送公司扣工资提醒，包含公司链接及命中条件。QQ 使用下方目标，Slack 使用通知管理上方已配置的渠道。</p>'
      + '<h4>QQ 通知目标</h4>' + bizTargets(state.settings.targets, 'company-salary')
      + '<div class="biz-actions"><button type="button" class="test-btn compact" data-action="company-salary-save">保存提醒配置</button><button type="button" class="test-btn compact" data-action="company-salary-test">发送测试</button></div></article>';
    host.querySelectorAll('input,select').forEach(input => { input.disabled = !state.permissions.save; });
    host.querySelectorAll('button').forEach(button => { button.disabled = button.dataset.action === 'company-salary-test' ? !state.permissions.test : !state.permissions.save; });
  }
  function read() {
    state.settings = { qq: { enabled: host.querySelector('[data-company-salary-channel="qq"]').checked }, slack: { enabled: host.querySelector('[data-company-salary-channel="slack"]').checked }, targets: bizReadTargets(host.querySelector('.biz-targets')) };
  }
  async function load() {
    try { const data = await request(); if (data) { state = data; render(); } }
    catch (error) { host.hidden = false; host.textContent = '扣工资通知读取失败：' + error.message; }
  }
  host.addEventListener('change', event => {
    if (event.target.dataset.field !== 'type') return;
    const row = event.target.closest('.biz-target'), group = event.target.value === 'group';
    ['groupId', 'atUserId'].forEach(field => { row.querySelector('[data-field="' + field + '"]').hidden = !group; });
    row.querySelector('[data-field="userId"]').hidden = group;
  });
  host.addEventListener('click', async event => {
    const button = event.target.closest('button[data-action]');
    if (!button || !state || button.disabled) return;
    const action = button.dataset.action;
    if (action === 'company-salary-test' ? !state.permissions.test : !state.permissions.save) return;
    read();
    if (action === 'add-target' || action === 'remove-target') {
      if (action === 'add-target') state.settings.targets.push({ id: 'company-salary-' + Date.now(), type: 'group', groupId: '', userId: '', atUserId: '' });
      else state.settings.targets.splice(Array.from(host.querySelectorAll('.biz-target')).indexOf(button.closest('.biz-target')), 1);
      render(); return;
    }
    button.disabled = true;
    try {
      if (action === 'company-salary-save') { const data = await request('PUT', state.settings); state.settings = data.settings; render(); toast('扣工资提醒配置已保存'); }
      if (action === 'company-salary-test') { await request('POST'); toast('扣工资测试通知已发送（使用已保存配置）'); }
    } catch (error) { toast(error.message, true); }
    finally { button.disabled = false; }
  });
  document.getElementById('business-refresh').addEventListener('click', load);
  load();
})();

(() => {
  const host = document.getElementById('company-training-notifications');
  let state;
  async function request(method = 'GET', body) {
    const response = await fetch('/api/torn-company-alerts/training/notifications' + (method === 'POST' ? '/test' : ''), { method, credentials: 'same-origin', ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    if (response.status === 403 && method === 'GET') { host.hidden = true; return null; }
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || '员工训练通知操作失败');
    return data;
  }
  function render() {
    host.hidden = false;
    host.innerHTML = '<article class="business-card" data-source="company-training"><div class="business-card-head"><div><h3>Torn · 员工训练</h3><p>当前账号的员工训练提醒</p></div><a href="/torn-toolbox/company/#training">打开监控 →</a></div>'
      + '<div class="biz-global"><label class="biz-check"><input data-company-training-channel="qq" type="checkbox"' + (state.settings.qq.enabled ? ' checked' : '') + '> QQ 推送</label><label class="biz-check"><input data-company-training-channel="slack" type="checkbox"' + (state.settings.slack.enabled ? ' checked' : '') + '> Slack 推送</label></div>'
      + '<p class="biz-hint">推送公司员工训练提醒，包含公司链接及命中条件。QQ 使用下方目标，Slack 使用通知管理上方已配置的渠道。</p>'
      + '<h4>QQ 通知目标</h4>' + bizTargets(state.settings.targets, 'company-training')
      + '<div class="biz-actions"><button type="button" class="test-btn compact" data-action="company-training-save">保存提醒配置</button><button type="button" class="test-btn compact" data-action="company-training-test">发送测试</button></div></article>';
    host.querySelectorAll('input,select').forEach(input => { input.disabled = !state.permissions.save; });
    host.querySelectorAll('button').forEach(button => { button.disabled = button.dataset.action === 'company-training-test' ? !state.permissions.test : !state.permissions.save; });
  }
  function read() {
    state.settings = { qq: { enabled: host.querySelector('[data-company-training-channel="qq"]').checked }, slack: { enabled: host.querySelector('[data-company-training-channel="slack"]').checked }, targets: bizReadTargets(host.querySelector('.biz-targets')) };
  }
  async function load() {
    try { const data = await request(); if (data) { state = data; render(); } }
    catch (error) { host.hidden = false; host.textContent = '员工训练通知读取失败：' + error.message; }
  }
  host.addEventListener('change', event => {
    if (event.target.dataset.field !== 'type') return;
    const row = event.target.closest('.biz-target'), group = event.target.value === 'group';
    ['groupId', 'atUserId'].forEach(field => { row.querySelector('[data-field="' + field + '"]').hidden = !group; });
    row.querySelector('[data-field="userId"]').hidden = group;
  });
  host.addEventListener('click', async event => {
    const button = event.target.closest('button[data-action]');
    if (!button || !state || button.disabled) return;
    const action = button.dataset.action;
    if (action === 'company-training-test' ? !state.permissions.test : !state.permissions.save) return;
    read();
    if (action === 'add-target' || action === 'remove-target') {
      if (action === 'add-target') state.settings.targets.push({ id: 'company-training-' + Date.now(), type: 'group', groupId: '', userId: '', atUserId: '' });
      else state.settings.targets.splice(Array.from(host.querySelectorAll('.biz-target')).indexOf(button.closest('.biz-target')), 1);
      render(); return;
    }
    button.disabled = true;
    try {
      if (action === 'company-training-save') { const data = await request('PUT', state.settings); state.settings = data.settings; render(); toast('员工训练提醒配置已保存'); }
      if (action === 'company-training-test') { await request('POST'); toast('员工训练测试通知已发送（使用已保存配置）'); }
    } catch (error) { toast(error.message, true); }
    finally { button.disabled = false; }
  });
  document.getElementById('business-refresh').addEventListener('click', load);
  load();
})();

(() => {
  const host = document.getElementById('company-stock-notifications');
  let state;
  async function request(method = 'GET', body) {
    const response = await fetch('/api/torn-company-alerts/stock/notifications' + (method === 'POST' ? '/test' : ''), { method, credentials: 'same-origin', ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    if (response.status === 403 && method === 'GET') { host.hidden = true; return null; }
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || '库存通知操作失败');
    return data;
  }
  function render() {
    host.hidden = false;
    host.innerHTML = '<article class="business-card" data-source="company-stock"><div class="business-card-head"><div><h3>Torn · 库存</h3><p>当前账号的库存提醒</p></div><a href="/torn-toolbox/company/#stock">打开监控 →</a></div>'
      + '<div class="biz-global"><label class="biz-check"><input data-company-stock-channel="qq" type="checkbox"' + (state.settings.qq.enabled ? ' checked' : '') + '> QQ 推送</label><label class="biz-check"><input data-company-stock-channel="slack" type="checkbox"' + (state.settings.slack.enabled ? ' checked' : '') + '> Slack 推送</label></div>'
      + '<p class="biz-hint">推送公司库存提醒，包含公司链接及命中条件。QQ 使用下方目标，Slack 使用通知管理上方已配置的渠道。</p>'
      + '<h4>QQ 通知目标</h4>' + bizTargets(state.settings.targets, 'company-stock')
      + '<div class="biz-actions"><button type="button" class="test-btn compact" data-action="company-stock-save">保存提醒配置</button><button type="button" class="test-btn compact" data-action="company-stock-test">发送测试</button></div></article>';
    host.querySelectorAll('input,select').forEach(input => { input.disabled = !state.permissions.save; });
    host.querySelectorAll('button').forEach(button => { button.disabled = button.dataset.action === 'company-stock-test' ? !state.permissions.test : !state.permissions.save; });
  }
  function read() {
    state.settings = { qq: { enabled: host.querySelector('[data-company-stock-channel="qq"]').checked }, slack: { enabled: host.querySelector('[data-company-stock-channel="slack"]').checked }, targets: bizReadTargets(host.querySelector('.biz-targets')) };
  }
  async function load() {
    try { const data = await request(); if (data) { state = data; render(); } }
    catch (error) { host.hidden = false; host.textContent = '库存通知读取失败：' + error.message; }
  }
  host.addEventListener('change', event => {
    if (event.target.dataset.field !== 'type') return;
    const row = event.target.closest('.biz-target'), group = event.target.value === 'group';
    ['groupId', 'atUserId'].forEach(field => { row.querySelector('[data-field="' + field + '"]').hidden = !group; });
    row.querySelector('[data-field="userId"]').hidden = group;
  });
  host.addEventListener('click', async event => {
    const button = event.target.closest('button[data-action]');
    if (!button || !state || button.disabled) return;
    const action = button.dataset.action;
    if (action === 'company-stock-test' ? !state.permissions.test : !state.permissions.save) return;
    read();
    if (action === 'add-target' || action === 'remove-target') {
      if (action === 'add-target') state.settings.targets.push({ id: 'company-stock-' + Date.now(), type: 'group', groupId: '', userId: '', atUserId: '' });
      else state.settings.targets.splice(Array.from(host.querySelectorAll('.biz-target')).indexOf(button.closest('.biz-target')), 1);
      render(); return;
    }
    button.disabled = true;
    try {
      if (action === 'company-stock-save') { const data = await request('PUT', state.settings); state.settings = data.settings; render(); toast('库存提醒配置已保存'); }
      if (action === 'company-stock-test') { await request('POST'); toast('库存测试通知已发送（使用已保存配置）'); }
    } catch (error) { toast(error.message, true); }
    finally { button.disabled = false; }
  });
  document.getElementById('business-refresh').addEventListener('click', load);
  load();
})();
