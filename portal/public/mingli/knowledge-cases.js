import { createCaseFilters } from './case-filters.js?v=2';

const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function createKnowledgeCases({ run, api, tab }) {
  const pageSize = 30;
  let query = null, currentPage = 1, pageCount = 1, loading = false;
  const filters = createCaseFilters(action => run(() => action(() => load())), { prefix: 'kc-', anchor: 'kc-search-form', search: 'kc-search', category: 'kc-document', basicFields: ['gender'] });
  async function load(target = 1, paging = false) {
    const params = paging && query ? query : { search: $('kc-search').value, documentId: $('kc-document').value, filters: JSON.stringify(filters.value()) };
    let page = Math.max(1, Math.floor(Number(target) || 1));
    const fetchPage = n => api('/knowledge-cases?' + new URLSearchParams({ ...params, offset: (n - 1) * pageSize, limit: pageSize }));
    let result = await fetchPage(page);
    const pages = Math.max(1, Math.ceil(result.total / pageSize));
    if (page > pages) { page = pages; result = await fetchPage(page); }
    query = params; currentPage = page; pageCount = Math.max(1, Math.ceil(result.total / pageSize));
    $('kc-list').replaceChildren(); $('kc-detail').hidden = true;
    $('kc-document').innerHTML = '<option value="">全部来源</option>' + result.documents.map(d => `<option value="${d.id}">${escape(d.title)}（${d.count}）</option>`).join('');
    $('kc-document').value = params.documentId;
    for (const item of result.cases) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'ml-case-card'; button.dataset.knowledgeCase = item.id;
      button.innerHTML = `<strong>${escape(item.title)}</strong><span class="ml-category-badge">自动归集 · 待核对</span><p class="ml-case-pillars">${item.chart.pillars.map(p => escape(p.ganZhi)).join(' · ')}</p><p>${item.birth.gender === 1 ? '男' : item.birth.gender === 0 ? '女' : '性别未注明'}${item.timeLabel ? ' · ' + escape(item.timeLabel) : ''}</p><p class="ml-muted">来源：${escape(item.documentTitle)}</p><p class="ml-muted">${escape(item.topic || '未分类')} · ${escape(item.tags.join(' / '))}</p>`;
      $('kc-list').append(button);
    }
    $('kc-count').textContent = `${result.total} 条案例 · ${result.uniqueCharts} 组八字`;
    renderPagination(result.total);
    if (!result.total) $('kc-list').textContent = params.search || params.documentId || params.filters !== '{}' ? '当前筛选没有匹配的知识库案例。' : '暂无可归集案例。知识库笔记中明确写出按年、月、日、时排列的完整四柱后，将自动收录。';
    filters.describe(params.search, params.documentId);
    if (paging) $('kc-count').scrollIntoView({ block: 'start' });
  }
  function renderPagination(total) {
    $('kc-pagination').hidden = !total;
    $('kc-page-info').textContent = `共 ${total} 条，每页 ${pageSize} 条，第 ${currentPage} / ${pageCount} 页`;
    $('kc-prev').disabled = loading || currentPage <= 1;
    $('kc-next').disabled = loading || currentPage >= pageCount;
    const pages = [...new Set([1, ...Array.from({ length: 5 }, (_, i) => currentPage - 2 + i), pageCount])].filter(n => n >= 1 && n <= pageCount).sort((a, b) => a - b);
    $('kc-pages').replaceChildren();
    pages.forEach((n, i) => {
      if (i && n > pages[i - 1] + 1) { const gap = document.createElement('span'); gap.textContent = '…'; gap.setAttribute('aria-hidden', 'true'); $('kc-pages').append(gap); }
      const button = document.createElement('button'); button.type = 'button'; button.className = 'btn ghost'; button.dataset.page = n; button.textContent = n; button.setAttribute('aria-label', '第 ' + n + ' 页');
      if (n === currentPage) button.setAttribute('aria-current', 'page');
      button.disabled = loading || n === currentPage; $('kc-pages').append(button);
    });
    $('kc-page-input').max = pageCount; $('kc-page-input').value = currentPage;
  }
  const go = n => { if (!loading && Number.isInteger(n) && n >= 1 && n <= pageCount && n !== currentPage) run(() => load(n, true)); };
  function show(item) {
    const p = item.chart.pillars;
    $('kc-title').textContent = item.title;
    const genderBasis = [...new Set((item.genderEvidence || []).map(e => e.text.match(/元\s*[男女]|坤造|乾造|女命|男命/)?.[0]).filter(Boolean))];
    $('kc-meta').textContent = `${item.documentTitle} · ${item.birth.gender === 1 ? '男命' : item.birth.gender === 0 ? '女命' : '性别待核对'} · ${item.timeLabel || '时间未注明'} · ${item.validation}${genderBasis.length ? ' · 性别依据：' + genderBasis.join('、') : ''}${item.excerptTruncated ? ' · 摘录超过3万字已截断，请查看知识库原文' : ''}`;
    $('kc-source').href = item.sourceUrl;
    $('kc-references').replaceChildren();
    for (const ref of (item.references || []).slice(1)) {
      const a = document.createElement('a'); a.className = 'btn ghost'; a.textContent = '另一处来源：' + ref.title;
      a.href = '/knowledge/?document=' + item.documentId + (ref.anchor ? '#' + ref.anchor : ''); a.target = '_blank'; a.rel = 'noopener noreferrer'; $('kc-references').append(a);
    }
    $('kc-excerpt').textContent = item.notes;
    const rows = [['主星', (v, i) => i === 2 ? '日主' : v.tenGod || '—'], ['天干', v => v.gan], ['地支', v => v.zhi], ['藏干', v => v.hidden?.map(h => h.gan + ' ' + h.tenGod).join(' / ') || '—'], ['纳音', v => v.naYin || '—'], ['旬空', v => v.xunKong || '—']];
    $('kc-pillars').innerHTML = `<caption class="ml-sr-only">知识库案例四柱</caption><thead><tr><th>四柱</th>${p.map(v => `<th scope="col">${escape(v.label)}</th>`).join('')}</tr></thead><tbody>${rows.map(([label, render]) => `<tr><th scope="row">${label}</th>${p.map((v, i) => `<td>${escape(render(v, i))}</td>`).join('')}</tr>`).join('')}</tbody>`;
    $('kc-detail').hidden = false; $('kc-detail').scrollIntoView({ block: 'start' });
  }
  $('kc-list').addEventListener('click', e => {
    const button = e.target.closest('[data-knowledge-case]');
    if (button) run(async () => { const result = await api('/knowledge-cases/' + button.dataset.knowledgeCase); show(result.case); });
  });
  $('kc-search-form').addEventListener('submit', e => { e.preventDefault(); run(() => load()); });
  $('kc-document').addEventListener('change', () => run(() => load()));
  $('kc-prev').addEventListener('click', () => go(currentPage - 1));
  $('kc-next').addEventListener('click', () => go(currentPage + 1));
  $('kc-pages').addEventListener('click', e => { const button = e.target.closest('[data-page]'); if (button) go(Number(button.dataset.page)); });
  $('kc-jump-form').addEventListener('submit', e => { e.preventDefault(); go(Number($('kc-page-input').value)); });
  $('knowledge-tab').addEventListener('click', () => run(async () => { await load(); tab('knowledge'); }));
  return {
    permissions(list) {
      const can = p => list.includes('*') || list.includes(p);
      const allowed = can('mingli:knowledge:view') && can('knowledge:view') && can('knowledge:notes:view');
      $('knowledge-tab').hidden = !allowed; filters.show(allowed && can('mingli:knowledge:filter'));
    },
    busy(value) {
      loading = value; filters.busy(value);
      for (const id of ['knowledge-tab', 'kc-document', 'kc-page-input', 'kc-jump']) $(id).disabled = value;
      $('kc-prev').disabled = value || currentPage <= 1; $('kc-next').disabled = value || currentPage >= pageCount;
      $('kc-pages').querySelectorAll('button').forEach(b => { b.disabled = value || Number(b.dataset.page) === currentPage; });
      $('kc-search-form').querySelector('button').disabled = value; $('kc-list').querySelectorAll('button').forEach(b => { b.disabled = value; });
    }
  };
}
