(function () {
  var form = document.getElementById('config-form');
  var refreshButton = document.getElementById('refresh');
  var restartButton = document.getElementById('restart');
  var saveButton = document.getElementById('save');
  var canEdit = false;

  async function api(path, options) {
    var response = await fetch('/api/piclist/' + path, Object.assign({
      headers: { 'Content-Type': 'application/json' }
    }, options || {}));
    if (response.status === 401) {
      location.href = '/login.html';
      throw new Error('请先登录');
    }
    var data = await response.json();
    if (!response.ok || data.ok === false) throw new Error(data.error || response.statusText);
    return data;
  }

  function statusClass(element, ok) {
    element.classList.toggle('ok', !!ok);
    element.classList.toggle('bad', !ok);
  }

  function setForm(config) {
    if (!config) return;
    ['bucketName', 'region', 'endpoint', 'urlPrefix', 'uploadPath', 'acl'].forEach(function (name) {
      form.elements[name].value = config[name] || '';
    });
    form.elements.accessKeyID.value = '';
    form.elements.secretAccessKey.value = '';
    form.elements.accessKeyID.placeholder = config.accessKeyConfigured ? '已配置，留空则保持原值' : '尚未配置';
    form.elements.secretAccessKey.placeholder = config.secretKeyConfigured ? '已配置，留空则保持原值' : '尚未配置';
    form.elements.pathStyleAccess.checked = config.pathStyleAccess !== false;
    form.elements.disableBucketPrefixToURL.checked = config.disableBucketPrefixToURL !== false;
    form.elements.renamePluginEnabled.checked = !!config.renamePluginEnabled;
  }

  function render(data) {
    canEdit = !!data.canEdit;
    var status = data.status || {};
    var http = status.http || {};
    var container = status.container || {};
    var config = status.config;
    var httpEl = document.getElementById('http-status');
    var containerEl = document.getElementById('container-status');

    httpEl.textContent = http.ok ? '在线' : '不可达';
    statusClass(httpEl, http.ok);
    document.getElementById('http-detail').textContent = http.ok
      ? 'HTTP ' + http.status + ' · ' + http.latencyMs + ' ms'
      : (http.error || '连接失败');

    var containerOk = container.running && (!container.health || container.health === 'healthy');
    containerEl.textContent = container.health || container.status || '未知';
    statusClass(containerEl, containerOk);
    document.getElementById('container-detail').textContent = container.startedAt
      ? '启动于 ' + new Date(container.startedAt).toLocaleString('zh-CN')
      : (container.error || '未获取到容器信息');

    document.getElementById('uploader-status').textContent = config?.uploader || '未配置';
    document.getElementById('uploader-detail').textContent = config
      ? ((config.bucketName || '未配置桶') + ' · ' + (config.region || '未配置区域'))
      : (status.configError || '读取失败');
    var credentialsReady = !!(config?.accessKeyConfigured && config?.secretKeyConfigured && config?.serverKeyConfigured);
    var credentialEl = document.getElementById('credential-status');
    credentialEl.textContent = credentialsReady ? '已配置' : '不完整';
    statusClass(credentialEl, credentialsReady);
    document.getElementById('credential-detail').textContent = config
      ? 'B2 Key ' + (config.accessKeyConfigured && config.secretKeyConfigured ? '✓' : '✗')
        + ' · Server Key ' + (config.serverKeyConfigured ? '✓' : '✗')
      : '—';
    document.getElementById('checked-at').textContent = status.checkedAt
      ? '检查于 ' + new Date(status.checkedAt).toLocaleString('zh-CN') : '';

    setForm(config);
    Array.from(form.elements).forEach(function (element) {
      if (element.tagName !== 'BUTTON') element.disabled = !canEdit;
    });
    saveButton.disabled = !canEdit;
    restartButton.disabled = !canEdit;
    if (!canEdit) document.getElementById('permission-hint').textContent = '当前账号只有查看权限。';
  }

  async function load() {
    refreshButton.disabled = true;
    try { render(await api('status')); }
    catch (error) { window.portalToast?.error(error.message); }
    finally { refreshButton.disabled = false; }
  }

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    if (!canEdit) return;
    saveButton.disabled = true;
    var payload = Object.fromEntries(new FormData(form).entries());
    ['pathStyleAccess', 'disableBucketPrefixToURL', 'renamePluginEnabled'].forEach(function (name) {
      payload[name] = form.elements[name].checked;
    });
    try {
      await api('config', { method: 'PUT', body: JSON.stringify(payload) });
      window.portalToast?.success('配置已保存，PicList 已重启');
      await load();
    } catch (error) {
      window.portalToast?.error(error.message);
    } finally {
      saveButton.disabled = !canEdit;
    }
  });

  restartButton.addEventListener('click', async function () {
    if (!canEdit) return;
    var ok = await window.portalDialog?.confirm('上传服务会短暂中断，确定现在重启吗？', {
      title: '重启 PicList',
      okText: '重启'
    });
    if (!ok) return;
    restartButton.disabled = true;
    try {
      await api('restart', { method: 'POST', body: '{}' });
      window.portalToast?.success('PicList 已重启');
      setTimeout(load, 1200);
    } catch (error) {
      window.portalToast?.error(error.message);
    } finally {
      restartButton.disabled = !canEdit;
    }
  });

  refreshButton.addEventListener('click', load);
  load();
})();
