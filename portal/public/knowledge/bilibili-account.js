export function createBilibiliPanel({ element: $, can, api, send, onError, onDefaults }) {
  let timer = null, generation = 0;
  const show = (id, visible) => { $(id).hidden = !visible; };
  function render(a) {
    $('bilibili-status').textContent = a.state === 'connected' ? `已绑定：${a.nickname || 'B站账号'} · 上次检查 ${new Date(a.lastChecked).toLocaleString('zh-CN')}` : a.state === 'expired' ? 'B站登录已失效，请重新扫码绑定。' : '尚未绑定B站；公开接口可能只提供较低清晰度。';
    $('bilibili-default-quality').value = String(a.quality); $('bilibili-default-mode').value = a.strict ? 'strict' : 'auto';
    show('bilibili-unlink', can('bilibili:edit') && a.bound); show('bilibili-check', can('bilibili:view') && a.bound);
    onDefaults(a);
  }
  const stop = () => { generation++; clearTimeout(timer); timer = null; $('bilibili-qr').removeAttribute('src'); show('bilibili-qr', false); };
  async function refresh() {
    if (!can('bilibili:view')) return;
    render((await api('/bilibili')).account);
  }
  async function poll(epoch) {
    try {
      const r = await send('/bilibili/login/poll', 'POST');
      if (epoch !== generation) return;
      const labels = { waiting: '请用B站手机端扫描二维码并确认登录。', scanned: '已扫描，请在B站手机端确认登录。', expired: '二维码已过期，请重新点击扫码绑定。', cancelled: '扫码已取消。' };
      if (r.status === 'connected') { stop(); render(r.account); $('bilibili-login-status').textContent = 'B站绑定成功，可以重新读取视频清晰度。'; return; }
      $('bilibili-login-status').textContent = labels[r.status] || '正在等待扫码…';
      if (['expired', 'cancelled'].includes(r.status)) { stop(); return; }
      timer = setTimeout(() => poll(epoch), 3000);
    } catch (e) { if (epoch === generation) { stop(); $('bilibili-login-status').textContent = e.message; onError(e); } }
  }
  $('bilibili-login').onclick = async () => {
    if (!can('bilibili:edit')) return;
    $('error').hidden = true;
    stop(); const epoch = generation; $('bilibili-login').disabled = true;
    try {
      const r = await send('/bilibili/login/start', 'POST');
      if (epoch !== generation) return;
      if (!/^data:image\/png;base64,/.test(r.qrImage)) throw new Error('二维码图片无效');
      $('bilibili-qr').src = r.qrImage; show('bilibili-qr', true);
      $('bilibili-login-status').textContent = '请用B站手机端扫码并确认。二维码约3分钟有效。';
      timer = setTimeout(() => poll(epoch), 3000);
    } catch (e) { onError(e); } finally { $('bilibili-login').disabled = false; }
  };
  $('bilibili-unlink').onclick = async () => {
    if (!can('bilibili:edit')) return;
    stop();
    try { render((await api('/bilibili', { method: 'DELETE' })).account); $('bilibili-login-status').textContent = '已解除本知识库的B站绑定。'; } catch (e) { onError(e); }
  };
  $('bilibili-check').onclick = async () => { try { render((await send('/bilibili/check', 'POST')).account); } catch (e) { onError(e); } };
  $('bilibili-save-quality').onclick = async () => {
    try {
      const s = { quality: Number($('bilibili-default-quality').value), strict: $('bilibili-default-mode').value === 'strict' };
      await send('/bilibili/settings', 'PUT', s); onDefaults(s);
      $('bilibili-login-status').textContent = '默认清晰度已保存，用于新导入和下载失败后的重试。';
    } catch (e) { onError(e); }
  };
  show('bilibili-settings', can('bilibili:view') || can('quality:edit'));
  show('bilibili-login', can('bilibili:edit')); show('bilibili-quality-settings', can('quality:edit'));
  return { refresh, stop };
}
