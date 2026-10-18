const local = 'http://127.0.0.1:17891';
export async function sendLocalInput({ file, documentId, send, status, fetcher = fetch }) {
  let offered = false;
  try {
    status('正在连接本机 GPU…');
    const health = await fetcher(local + '/health', { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(8000) });
    const device = await health.json();
    if (!health.ok || !device.ok || !/^[a-f0-9]{32}$/.test(device.workerId)) throw new Error('offline');
    const grant = await send('/documents/' + documentId + '/local-input', 'POST', { workerId: device.workerId });
    offered = true; status('正在将原视频直送本机 GPU，同时上传服务器…');
    const response = await fetcher(local + '/inputs/' + documentId, { method: 'POST', credentials: 'omit',
      headers: { Authorization: 'Bearer ' + grant.ticket, 'Content-Type': 'application/octet-stream' }, body: file, signal: AbortSignal.timeout(60000) });
    if (!response.ok || !(await response.json()).ok) throw new Error('unavailable');
    status('本机原视频已就绪：上传完成后立即处理，115在后台归档。');
    return true;
  } catch {
    if (offered) await send('/documents/' + documentId + '/local-input', 'POST', { cancel: true }).catch(() => {});
    status('本机直送不可用，自动使用服务器流程；可检查工作器和浏览器本地网络访问权限。');
    return false;
  }
}
