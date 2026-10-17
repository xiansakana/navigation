import { createCaseFilters } from './case-filters.js?v=2';

const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function createKnowledgeCases({ run, api, tab }) {
  let query = null, offset = 0;
  const filters = createCaseFilters(action => run(() => action(() => load())), { prefix: 'kc-', anchor: 'kc-search-form', search: 'kc-search', category: 'kc-document', basicFields: ['gender'] });
  async function load(more = false) {
    const params = more && query ? query : { search: $('kc-search').value, documentId: $('kc-document').value, filters: JSON.stringify(filters.value()) };
    const start = more ? offset : 0;
    const result = await api('/knowledge-cases?' + new URLSearchParams({ ...params, offset: start, limit: 30 }));
    query = params; offset = start + result.cases.length;
    if (!more) {
      $('kc-list').replaceChildren(); $('kc-detail').hidden = true;
      $('kc-document').innerHTML = '<option value="">全部来源</option>' + result.documents.map(d => `<option value="${d.id}">${escape(d.title)}（${d.count}）</option>`).join('');
      $('kc-document').value = params.documentId;
    }
    for (const item of result.cases) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'ml-case-card'; button.dataset.knowledgeCase = item.id;
      button.innerHTML = `<strong>${escape(item.title)}</strong><span class="ml-category-badge">自动归集 · 待核对</span><p class="ml-case-pillars">${item.chart.pillars.map(p => escape(p.ganZhi)).join(' · ')}</p><p>${item.birth.gender === 1 ? '男' : item.birth.gender === 0 ? '女' : '性别未注明'}${item.timeLabel ? ' · ' + escape(item.timeLabel) : ''}</p><p class="ml-muted">来源：${escape(item.documentTitle)}</p><p class="ml-muted">${escape(item.topic || '未分类')} · ${escape(item.tags.join(' / '))}</p>`;
      $('kc-list').append(button);
    }
    $('kc-count').textContent = `${result.total} 条案例 · ${result.uniqueCharts} 组八字`;
    $('kc-more').hidden = offset >= result.total;
    if (!result.total) $('kc-list').textContent = params.search || params.documentId || params.filters !== '{}' ? '当前筛选没有匹配的知识库案例。' : '暂无可归集案例。知识库笔记中明确写出按年、月、日、时排列的完整四柱后，将自动收录。';
    filters.describe(params.search, params.documentId);
  }
  function show(item) {
    const p = item.chart.pillars;
    $('kc-title').textContent = item.title;
    $('kc-meta').textContent = `${item.documentTitle} · ${item.timeLabel || '时间未注明'} · ${item.validation}${item.excerptTruncated ? ' · 摘录超过3万字已截断，请查看知识库原文' : ''}`;
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
  $('kc-more').addEventListener('click', () => run(() => load(true)));
  $('knowledge-tab').addEventListener('click', () => run(async () => { await load(); tab('knowledge'); }));
  return {
    permissions(list) {
      const can = p => list.includes('*') || list.includes(p);
      const allowed = can('mingli:knowledge:view') && can('knowledge:view') && can('knowledge:notes:view');
      $('knowledge-tab').hidden = !allowed; filters.show(allowed && can('mingli:knowledge:filter'));
    },
    busy(value) { filters.busy(value); for (const id of ['knowledge-tab', 'kc-more', 'kc-document']) $(id).disabled = value; $('kc-search-form').querySelector('button').disabled = value; $('kc-list').querySelectorAll('button').forEach(b => { b.disabled = value; }); }
  };
}
