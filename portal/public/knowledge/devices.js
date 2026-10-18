export function createDevicePanel({ can, api, send, onError }) {
  const $ = id => document.getElementById(id);
  const mayInstall = can('devices:install') && can('devices:edit') && can('process:edit');
  $('worker-install').hidden = !mayInstall;
  $('device-manager').hidden = !can('devices:view');
  $('device-pair-form').hidden = !can('devices:edit');
  let pendingCode = '';
  async function refresh() {
    if (!can('devices:view')) return;
    const { devices } = await api('/devices');
    const list = $('worker-devices'); list.replaceChildren();
    if (!devices.length) { const p = document.createElement('p'); p.className = 'kb-hint'; p.textContent = '尚未绑定独立设备。现有工作器仍可继续运行；新电脑可点击“安装并连接”。'; list.append(p); }
    for (const device of devices) {
      const row = document.createElement('div'); row.className = 'kb-section-heading'; row.dataset.deviceId = device.id;
      const text = document.createElement('p'); text.className = 'kb-hint';
      text.textContent = `${device.label} · ${device.revokedAt ? '已停用' : device.online ? '在线' : '离线'}${device.capabilities.media?.ready ? device.capabilities.media.detail === 'cuda' ? ' · GPU' : ' · CPU' : ''}${device.lastSeen ? ' · 最近连接 ' + new Date(device.lastSeen).toLocaleString('zh-CN') : ' · 等待首次连接'}`;
      row.append(text);
      if (!device.revokedAt && can('devices:edit')) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'btn ghost'; button.textContent = '停用';
        button.onclick = async () => {
          if (!window.confirm(`停用“${device.label}”？这台设备将不能再领取视频，正在处理的任务需重试，其他设备不受影响。`)) return;
          try { await api('/devices/' + device.id, { method: 'DELETE' }); await refresh(); } catch (e) { onError(e); }
        };
        row.append(button);
      }
      list.append(row);
    }
  }
  $('worker-install').onclick = async () => {
    const button = $('worker-install'); button.disabled = true;
    try {
      const r = await fetch('/api/knowledge/worker-install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!r.ok || !r.headers.get('content-type')?.includes('application/vnd.microsoft.portable-executable')) { const d = await r.json().catch(() => ({})); throw new Error(d.error || '安装包下载失败，请重新登录后重试'); }
      const blob = await r.blob(), url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = 'Navigation-Knowledge-Worker-Setup.exe'; document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      $('device-install-status').textContent = 'EXE 安装程序已下载，双击运行即可，无需解压。10分钟内运行可自动绑定当前账号，超时会打开网页确认。首次安装会下载依赖；Codex 未登录时会引导登录。';
    } catch (e) { onError(e); } finally { button.disabled = false; }
  };
  async function inspect() {
    const code = $('device-pair-code').value.trim().toUpperCase();
    const pair = await api('/device-pair?code=' + encodeURIComponent(code)); pendingCode = code;
    $('device-pair-description').textContent = `将设备“${pair.label}”连接到当前账号。它将能读取你上传的视频并提交笔记。请确认配对码与该电脑安装程序显示的一致：${code}`;
    $('device-pair-confirm').hidden = !can('devices:edit') || !can('process:edit');
  }
  $('device-pair-form').onsubmit = event => { event.preventDefault(); inspect().catch(onError); };
  $('device-pair-confirm').onclick = async () => {
    try {
      await send('/device-pair', 'POST', { code: pendingCode }); pendingCode = '';
      $('device-pair-confirm').hidden = true; $('device-pair-description').textContent = '已确认连接，请回到安装程序。';
      const url = new URL(location.href); url.searchParams.delete('pair'); history.replaceState(null, '', url);
      await refresh();
    } catch (e) { onError(e); }
  };
  const code = new URL(location.href).searchParams.get('pair');
  if (code && can('devices:view')) { $('settings').hidden = false; $('device-pair-code').value = code; inspect().catch(onError); }
  refresh().catch(onError);
  setInterval(() => { if (!document.hidden) refresh().catch(() => {}); }, 15000);
}
