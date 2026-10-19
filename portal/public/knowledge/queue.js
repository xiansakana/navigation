export function parseBatchLinks(text) {
  return String(text).split(/\r?\n/).map(s => s.trim()).filter(Boolean)
    .flatMap(line => line.match(/https?:\/\/[^\s<>"“”]+/gi) || [line]);
}
export function createUploadQueuePanel({ element: $, can, api, send, onError, openDocument }) {
  let offset = 0, snapshot, sequence = 0;
  const text = (tag, value) => { const el = document.createElement(tag); el.textContent = value; return el; };
  async function refresh() {
    if (!can('queue:view')) return;
    const seq = ++sequence, result = await api('/upload-queue?offset=' + offset);
    if (seq !== sequence) return;
    snapshot = result; $('upload-queue-panel').hidden = false;
    $('queue-counts').textContent = `处理中 ${result.active}/${result.capacity} · 等待 ${result.counts.pending || 0} · 读取信息 ${result.counts.resolving || 0} · 需重试 ${result.counts.failed || 0}`;
    const list = $('link-queue-list'); list.replaceChildren();
    if (!result.entries.length) list.append(text('p', '批量提交的B站链接会保存在这里，关闭页面后仍会自动接续。'));
    for (const entry of result.entries) {
      const row = document.createElement('div'); row.className = 'kb-queue-row';
      row.append(text('strong', entry.documentTitle || entry.title || entry.url));
      const status = { pending: '等待空闲位置，尚未下载', resolving: '正在读取视频信息', failed: '导入失败', cancelled: '已取消', duplicate: '重复视频，已跳过', submitted: entry.documentStage || '已提交，关联笔记已删除' }[entry.state];
      row.append(text('p', entry.error || status));
      const link = document.createElement('a'); link.href = entry.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = '来源视频'; row.append(link);
      const actions = document.createElement('div'); actions.className = 'kb-actions';
      if (entry.documentId && entry.documentStatus && can('notes:view')) {
        const button = text('button', '打开笔记'); button.type = 'button'; button.className = 'btn ghost';
        button.onclick = () => openDocument(entry.documentId).catch(onError); actions.append(button);
      }
      if (can('queue:manage')) for (const [action, label, allowed] of [['retry', '重试', entry.state === 'failed'], ['cancel', '取消等待', ['pending', 'resolving', 'failed'].includes(entry.state)]]) {
        if (!allowed) continue;
        const button = text('button', label); button.type = 'button'; button.className = 'btn ghost';
        button.onclick = async () => { button.disabled = true; try { await send('/upload-queue/' + entry.id + '/' + action, 'POST'); await refresh(); } catch (e) { onError(e); button.disabled = false; } }; actions.append(button);
      }
      row.append(actions); list.append(row);
    }
    $('queue-page').textContent = `${Math.min(offset + 1, result.total)}—${Math.min(offset + result.entries.length, result.total)} / ${result.total}`;
    $('queue-prev').disabled = offset === 0; $('queue-next').disabled = offset + result.entries.length >= result.total;
    return result;
  }
  $('queue-prev').onclick = () => { offset = Math.max(0, offset - 50); refresh().catch(onError); };
  $('queue-next').onclick = () => { if (snapshot && offset + 50 < snapshot.total) { offset += 50; refresh().catch(onError); } };
  return { refresh, reset() { offset = 0; return refresh(); } };
}
