export function parseBatchLinks(text) {
  return String(text).split(/\r?\n/).map(s => s.trim()).filter(Boolean)
    .flatMap(line => line.match(/https?:\/\/[^\s<>"“”]+/gi) || [line]);
}
export function createUploadQueuePanel({ element: $, can, api, send, onError, openDocument }) {
  let offset = 0, snapshot, sequence = 0, view, viewLoad;
  function ensureView() {
    if (!viewLoad) {
      viewLoad = import('../generated/knowledge-queue-view.js?v=1').then(({ mountQueueView }) => {
        view = mountQueueView($('link-queue-list'), {
          can,
          open: id => Promise.resolve(openDocument(id)).catch(onError),
          manage: async (action, id) => {
            try { await send('/upload-queue/' + id + '/' + action, 'POST'); await refresh(); }
            catch (error) { onError(error); }
          }
        });
      }).catch(error => { viewLoad = null; throw error; });
    }
    return viewLoad;
  }
  async function refresh() {
    if (!can('queue:view')) return;
    const seq = ++sequence;
    const [result] = await Promise.all([api('/upload-queue?offset=' + offset), ensureView()]);
    if (seq !== sequence) return;
    snapshot = result; $('upload-queue-panel').hidden = false;
    $('queue-counts').textContent = `处理中 ${result.active}/${result.capacity} · 等待 ${result.counts.pending || 0} · 读取信息 ${result.counts.resolving || 0} · 需重试 ${result.counts.failed || 0}`;
    view.update(result.entries);
    $('queue-page').textContent = `${Math.min(offset + 1, result.total)}—${Math.min(offset + result.entries.length, result.total)} / ${result.total}`;
    $('queue-prev').disabled = offset === 0; $('queue-next').disabled = offset + result.entries.length >= result.total;
    return result;
  }
  $('queue-prev').onclick = () => { offset = Math.max(0, offset - 50); refresh().catch(onError); };
  $('queue-next').onclick = () => { if (snapshot && offset + 50 < snapshot.total) { offset += 50; refresh().catch(onError); } };
  return { refresh, reset() { offset = 0; return refresh(); } };
}
