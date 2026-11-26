export function createActionHistory(root, { api, escapeHtml, formatDateTime, sentimentReading, onError }) {
  const $ = (id) => root.getElementById(id);
  let page = 1;
  let pageSize = 20;
  let requestId = 0;
  let result = { items: [] };
  const source = () => $('action-filter')?.value || 'all';
  const totalOf = (data) => Number(data.total) || 0;
  const pageCount = (data) => Math.max(1, Math.ceil(totalOf(data) / pageSize));

  function render() {
    const { items = [] } = result;
    const pages = pageCount(result);
    page = Math.min(page, pages);
    $('action-list').innerHTML = items.length ? items.map((action) => {
      const sentiment = action.payload?.sentiment;
      return `
        <div class="sm-action">
          <div class="meta">${escapeHtml(formatDateTime(action.ts))} · ${escapeHtml(action.source)} · ${escapeHtml(action.type)}${action.tier ? ' · ' + escapeHtml(action.tier) : ''}</div>
          <div>${escapeHtml(action.message)}</div>
          ${sentiment ? `<div class="hint">触发时情绪 ${escapeHtml(sentimentReading(sentiment))} · ${escapeHtml(sentiment.asOf)} · CNN 公开归档${sentiment.stale ? ' · 当时为旧值' : ''}</div>` : ''}
        </div>`;
    }).join('') : '<p class="hint">暂无操作记录</p>';
    $('action-page-info').textContent = `第 ${page} / ${pages} 页 · 共 ${totalOf(result)} 条`;
    $('action-prev').disabled = page <= 1;
    $('action-next').disabled = page >= pages;
  }

  async function load(target = 1) {
    const targetPage = Math.max(1, Number(target) || 1);
    const revision = ++requestId;
    const params = new URLSearchParams({
      limit: String(pageSize),
      offset: String((targetPage - 1) * pageSize),
      source: source()
    });
    const data = await api(`/actions?${params}`);
    if (revision !== requestId) return;
    const pages = pageCount(data);
    if (targetPage > pages) return load(pages);
    page = targetPage;
    result = data;
    render();
  }

  function acceptSnapshot(data) {
    if (page === 1 && source() === 'all' && (Number(data.limit) || 20) === pageSize) result = data;
  }

  function bind() {
    $('action-filter').addEventListener('change', () => load().catch(onError));
    $('action-prev').addEventListener('click', () => load(page - 1).catch(onError));
    $('action-next').addEventListener('click', () => load(page + 1).catch(onError));
    $('action-page-size').addEventListener('change', (event) => {
      pageSize = Number(event.target.value) || 20;
      load().catch(onError);
    });
  }

  return { acceptSnapshot, bind, load, render };
}
