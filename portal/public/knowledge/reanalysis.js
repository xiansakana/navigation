export function createReanalysisPanel({ element: $, can, state, api, send, onError, onDone }) {
  let target = null, previewItems = [], busy = false, versions = [], previewSequence = 0, historySequence = 0, historyDocument = '', historyRevision = -1;
  const dialog = $('reanalysis-dialog');
  function refresh(d = state.current) {
    $('reanalyze-batch').hidden = !can('reanalysis:batch:edit') || !can('reanalysis:edit') || !can('process:edit') || !can('notes:view');
    $('reanalyze').hidden = !d?.notes || !['ready', 'failed'].includes(d.status) || !can('reanalysis:edit') || !can('process:edit');
    $('history-panel').hidden = !d || !can('history:view');
    if ($('history-panel').open && d && (historyDocument !== d.id || historyRevision !== d.revision)) loadHistory().catch(onError);
  }
  async function preview() {
    const ticket = ++previewSequence;
    $('reanalysis-confirm').disabled = true; previewItems = [];
    const mode = $('reanalysis-mode').value;
    const input = target ? { preview: true, mode, revision: target.revision } : { preview: true, mode, ...(state.selected.size ? { items: [...state.selected].map(([id, revision]) => ({ id, revision })) } : { search: $('search').value, topic: $('topic-filter').value }) };
    const result = await send(target ? '/documents/' + target.id + '/reanalyze' : '/reanalysis', 'POST', input);
    if (ticket !== previewSequence) return;
    previewItems = result.results.filter(r => r.accepted).map(({ id, revision }) => ({ id, revision }));
    $('reanalysis-preview').textContent = `可重新分析 ${result.accepted} 篇；暂不能处理 ${result.skipped} 篇。` + [...new Set(result.results.filter(r => r.error).map(r => r.error))].join('；');
    $('reanalysis-confirm').disabled = !previewItems.length;
  }
  async function start(single) {
    if (busy) return;
    target = single ? { ...state.current } : null;
    $('reanalysis-heading').textContent = single ? '重新分析：' + target.title : '批量重新分析';
    $('reanalysis-scope').textContent = single ? '仅此篇笔记。' : state.selected.size ? `本次处理已勾选的 ${state.selected.size} 篇笔记（含跨页选择）。` : '本次处理当前搜索词和分类下所有已生成笔记，跨全部分页；状态筛选不影响此范围。';
    $('reanalysis-mode').value = 'reuse'; $('reanalysis-preview').textContent = '正在核对素材和版本…';
    dialog.showModal(); await preview();
  }
  const previewError = e => { $('reanalysis-preview').textContent = e.message || '核对失败，请重试'; onError(e); };
  $('reanalyze').onclick = () => start(true).catch(previewError);
  $('reanalyze-batch').onclick = () => start(false).catch(previewError);
  $('reanalysis-mode').onchange = () => preview().catch(previewError);
  $('reanalysis-close').onclick = () => { if (!busy) { previewSequence++; dialog.close(); } };
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); else previewSequence++; });
  $('reanalysis-confirm').onclick = async () => {
    if (busy || !previewItems.length) return;
    if (state.editing && !window.confirm('当前编辑尚未保存，继续会基于已保存的笔记重新分析。继续？')) return;
    busy = true; $('reanalysis-confirm').disabled = $('reanalysis-mode').disabled = $('reanalysis-close').disabled = true;
    try {
      const result = await send(target ? '/documents/' + target.id + '/reanalyze' : '/reanalysis', 'POST', target ? { revision: previewItems[0].revision, mode: $('reanalysis-mode').value } : { items: previewItems, mode: $('reanalysis-mode').value });
      $('message').textContent = `已排队重新分析 ${result.accepted} 篇；未提交 ${result.skipped} 篇。旧正文已保留，等待支持重新分析的GPU工作器。` + [...new Set(result.results.filter(r => r.error).map(r => r.error))].join('；');
      state.selected.clear(); dialog.close(); await onDone();
    } catch (e) { previewError(e); }
    finally { busy = false; $('reanalysis-mode').disabled = $('reanalysis-close').disabled = false; $('reanalysis-confirm').disabled = false; }
  };
  function renderVersion() {
    const v = versions.find(v => v.id === $('history-select').value);
    $('history-notes').textContent = v?.notes || '暂无历史版本。';
    $('history-restore').hidden = !can('history:restore') || !can('process:edit');
    $('history-restore').disabled = !v || !['ready', 'failed'].includes(state.current?.status);
  }
  async function loadHistory() {
    const id = state.current?.id; if (!id || !can('history:view')) return;
    const ticket = ++historySequence;
    historyRevision = state.current.revision;
    if (historyDocument !== id) { historyDocument = id; versions = []; $('history-select').replaceChildren(); renderVersion(); }
    const selected = $('history-select').value;
    const result = await api('/documents/' + id + '/versions');
    if (state.current?.id !== id || ticket !== historySequence) return;
    versions = result.versions; $('history-select').replaceChildren();
    for (const v of versions) { const option = document.createElement('option'); option.value = v.id; option.textContent = new Date(v.createdAt).toLocaleString('zh-CN') + ' · ' + v.title; $('history-select').append(option); }
    if (versions.some(v => v.id === selected)) $('history-select').value = selected;
    renderVersion();
  }
  $('history-panel').ontoggle = () => { if ($('history-panel').open) loadHistory().catch(onError); };
  $('history-select').onchange = renderVersion;
  $('history-restore').onclick = async () => {
    const d = state.current, versionId = $('history-select').value;
    if (!versionId || !window.confirm('恢复此版本的正文和素材？当前版本也会先保存，可再次恢复。')) return;
    $('history-restore').disabled = true;
    try { await send('/documents/' + d.id + '/restore', 'POST', { versionId, revision: d.revision }); $('message').textContent = '已恢复历史版本，并同步命理案例。'; await onDone(); }
    catch (e) { onError(e); } finally { renderVersion(); }
  };
  return { refresh };
}
