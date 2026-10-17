import { flowPillar, selectedFlow, shortGod } from './chart-presentation.js?v=1';

const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const birthKeys = ['calendar', 'gender', 'year', 'month', 'day', 'hour', 'minute', 'sect', 'yunSect', 'leapMonth', 'trueSolar', 'longitude', 'location', 'recordedSolarTime'];
let permissions = [], current = null, chart = null, dirty = false, busy = false, cycleIndex = 0, selectedYear = 0, caseOffset = 0;
let pendingImport = null;
let readingLayout = false;
let categoryData = { categories: [], total: 0, uncategorized: 0 };
const selectedCases = new Set();
const can = action => permissions.includes('*') || permissions.includes('mingli:' + action);
function error(message = '') { $('error').textContent = message; $('error').hidden = !message; }
function status(message = '') { $('status').textContent = message; }
function birth() {
  const value = Object.fromEntries(birthKeys.map(k => [k, ['leapMonth', 'trueSolar'].includes(k) ? $(k).checked : $(k).value]));
  if (!$('use-recorded-clock').checked) value.recordedSolarTime = null;
  return value;
}
function syncCalendar() {
  $('leap-label').hidden = $('calendar').value !== 'lunar'; $('longitude').required = $('trueSolar').checked;
  $('recorded-clock-settings').hidden = !$('recordedSolarTime').value;
  $('recorded-clock-label').textContent = $('recordedSolarTime').value ? $('recordedSolarTime').value + '（来源参考时刻；修改出生日期或时间后自动停用）' : '';
}
function syncActions() {
  $('calculate').disabled = busy || !can('chart:calculate');
  $('save-case').disabled = busy || !chart || !can('cases:edit');
  $('delete-case').hidden = !current || !can('cases:delete');
  $('delete-case').disabled = busy;
  $('new-case').disabled = busy;
  $('cases-tab').disabled = busy;
  $('more-cases').disabled = busy;
  $('import-file').disabled = busy;
  $('confirm-import').disabled = busy || !pendingImport || !can('cases:import') || !can('cases:edit');
  $('search-form').querySelector('button').disabled = busy;
  $('case-list').querySelectorAll('button').forEach(el => { el.disabled = busy; });
  $('birth-form').querySelectorAll('input,select').forEach(el => { el.disabled = busy; });
  $('tags').disabled = busy || !can('cases:edit'); $('notes').readOnly = busy || !can('cases:edit');
  for (const id of ['category-filter', 'bulk-category', 'select-loaded', 'manage-categories']) $(id).disabled = busy;
  $('case-category').disabled = busy || !can('cases:classify') || !can('categories:view');
  $('move-cases').disabled = busy || !selectedCases.size;
  $('category-manager').querySelectorAll('input,button').forEach(el => { el.disabled = busy; });
  $('case-list').querySelectorAll('input[type=checkbox]').forEach(el => { el.disabled = busy; });
}
async function api(path, method = 'GET', data) {
  const response = await fetch('/api/mingli' + path, { method, headers: data ? { 'Content-Type': 'application/json' } : {}, body: data ? JSON.stringify(data) : undefined });
  let result;
  try { result = await response.json(); } catch { throw new Error('服务暂不可用，请重新登录或稍后再试'); }
  if (!response.ok || !result.ok) throw new Error(result.error || '请求失败');
  return result;
}
async function run(fn) {
  if (busy) return;
  busy = true; error(); syncActions();
  try { await fn(); } catch (e) { error(e.message); status(); }
  finally { busy = false; syncActions(); }
}
async function discard() { return !dirty || await window.portalDialog.confirm('当前修改尚未保存，确定离开当前案例吗？', { title: '未保存的修改' }); }
function tab(name) {
  for (const t of ['chart', 'cases']) { $(t + '-view').hidden = t !== name; $(t + '-tab').classList.toggle('active', t === name); $(t + '-tab').setAttribute('aria-pressed', t === name ? 'true' : 'false'); }
  document.querySelector('.ml-shell').classList.toggle('ml-reading', readingLayout && name === 'chart');
}
function renderChart() {
  $('empty-chart').hidden = !!chart; $('chart-result').hidden = !chart;
  if (chart) readingLayout = true;
  document.querySelector('.ml-workspace').classList.toggle('has-chart', readingLayout);
  document.querySelector('.ml-shell').classList.toggle('ml-reading', readingLayout && !$('chart-view').hidden);
  if (!chart) return;
  const c = chart, i = c.input;
  $('chart-title').textContent = $('case-name').value.trim() || '未命名命盘';
  $('chart-kind').textContent = i.gender === 1 ? '乾造 · 男' : '坤造 · 女';
  $('day-master').textContent = '日主 ' + c.dayMaster;
  $('birth-panel-caption').textContent = `${$('case-name').value.trim() || '未命名'} · ${c.solar.slice(0, 16)}`;
  $('birth-summary').innerHTML = `<div>公历 ${escape(c.solar.slice(0, 16))} · 北京时间</div><div>农历 ${escape(c.lunar)}${i.location ? ' · ' + escape(i.location) : ''}</div>${i.trueSolar || i.recordedSolarTime ? `<div>${i.recordedSolarTime ? '原站真太阳时' : '真太阳时'} ${escape(c.clock.slice(0, 16))}（${c.correctionMinutes > 0 ? '+' : ''}${c.correctionMinutes} 分）</div>` : ''}`;
  $('term-summary').textContent = `前节 ${c.previousJie.name} ${c.previousJie.time} · 后节 ${c.nextJie.name} ${c.nextJie.time}`;
  $('elements').innerHTML = Object.entries(c.elements).map(([e, count]) => `<span>${element(e, e)} <b>${count}</b></span>`).join('');
  const l = c.luck;
  $('luck-summary').textContent = `${l.forward ? '顺行' : '逆行'} · 出生后 ${l.years} 年 ${l.months} 月 ${l.days} 天 ${l.hours} 小时起运 · 交运 ${l.start}（北京时间）`;
  const now = Number(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Shanghai', year: 'numeric' }).format(new Date()));
  cycleIndex = Math.max(0, l.cycles.findIndex(d => now >= d.startYear && now <= d.endYear));
  selectedYear = now;
  renderCycles();
  $('case-editor').hidden = !can('cases:edit') && !current;
  $('saved-at').textContent = current ? '已保存 · ' + new Date(current.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '尚未保存';
  $('source-record').hidden = !current?.source;
  if (current?.source) {
    const s = current.source, o = s.original;
    $('source-summary').textContent = `问真案例；原站分组：${s.group || '未分组'}；${o.star ? '已星标' : '未星标'}；原始公历：${o.solarTime}；原始农历：${o.lunarTime || '未记录'}；原站真太阳时：${o.sunTime}；原始四柱：${s.originalPillars}。导入时四柱${s.matched ? '逐柱一致' : '存在差异'}。来源 ID：${s.key}。后续编辑不会改写此来源快照。`;
  }
  $('rules').textContent = `${c.engine}；立春时刻换年，十二节时刻换月；${i.sect === 1 ? '23:00' : '00:00'} 换日。晚子时时干沿用历法库的子时口径；${i.yunSect === 1 ? '传统时辰折算' : '分钟折算'}起运。时间均按 UTC+8 输入，不自动处理历史夏令时。${i.recordedSolarTime ? '日时柱沿用原站保存的真太阳时；年、月柱及交运按原始北京时间。' : i.trueSolar ? '日时柱使用经度与均时差修正；年、月柱及交运按真实时刻。节气边界或时辰边界附近请核验原始出生记录。' : ''}`;
  syncActions();
}
const element = (text, e) => `<span class="ml-element-${escape(e)}">${escape(text)}</span>`;
function renderPillars(flow) {
  const { columns } = flow;
  const cellClass = p => p.flow ? 'ml-pillar-flow' : p.label === '日柱' ? 'ml-pillar-day' : '';
  const rows = [
    ['主星', p => escape(p.tenGod || '—')],
    ['天干', p => p.gan ? `<span class="ml-character">${element(p.gan, p.elements[0])}</span>` : '—'],
    ['地支', p => p.zhi ? `<span class="ml-character">${element(p.zhi, p.elements[1])}</span>` : '—'],
    ['藏干', p => p.hidden?.map(h => `<span class="ml-hidden-stem">${element(h.gan + h.element, h.element)}</span>`).join('') || '—'],
    ['副星', p => p.hidden?.map(h => `<span class="ml-hidden-stem">${escape(h.tenGod)}</span>`).join('') || '—'],
    ['纳音', p => escape(p.naYin || '—')], ['旬空', p => escape(p.xunKong || '—')]
  ];
  $('pillars').innerHTML = `<caption class="ml-sr-only">四柱命盘与所选大运流年</caption><thead><tr><th scope="col">日期</th>${columns.map(p => `<th scope="col" class="${cellClass(p)}">${p.label}${p.caption ? `<small>${escape(p.caption)}</small>` : ''}</th>`).join('')}</tr></thead><tbody>${rows.map(([title, render]) => `<tr><th scope="row">${title}</th>${columns.map(p => `<td class="${cellClass(p)}">${render(p)}</td>`).join('')}</tr>`).join('')}</tbody>`;
}
function flowCharacters(ganZhi) {
  const p = flowPillar(ganZhi, chart.dayMaster);
  if (!p) return '<span class="ml-flow-character">童</span><span class="ml-flow-character">限</span>';
  return `<span class="ml-flow-character">${element(p.gan, p.elements[0])}<small title="${p.tenGod}">${shortGod(p.tenGod)}</small></span><span class="ml-flow-character">${element(p.zhi, p.elements[1])}<small title="${p.hidden[0].tenGod}">${shortGod(p.hidden[0].tenGod)}</small></span>`;
}
function renderCycles() {
  const cycles = chart.luck.cycles;
  const flow = selectedFlow(chart, cycleIndex, selectedYear);
  cycleIndex = flow.cycleIndex; selectedYear = flow.year.year;
  $('cycles').innerHTML = cycles.map((d, index) => `<button type="button" data-cycle="${index}" aria-label="${d.startYear}年起 ${d.ganZhi}大运 ${d.startAge}至${d.endAge}岁" aria-pressed="${index === cycleIndex}" class="${index === cycleIndex ? 'active' : ''}"><small>${d.startYear}</small><small>${d.startAge}岁起</small>${flowCharacters(d.ganZhi)}</button>`).join('');
  $('years').innerHTML = flow.cycle.years.map(y => `<button type="button" data-year="${y.year}" aria-label="${y.year}年 ${y.ganZhi}流年 ${y.age}岁" aria-pressed="${y.year === selectedYear}" class="${y.year === selectedYear ? 'active' : ''}"><small>${y.year}</small><small>${y.age}岁</small>${flowCharacters(y.ganZhi)}</button>`).join('');
  $('months-title').textContent = '流月';
  $('months').innerHTML = flow.year.months.map(m => `<div class="ml-flow-month"><small>${escape(m.label)}</small>${flowCharacters(m.ganZhi)}</div>`).join('');
  $('flow-selection').textContent = `${flow.year.year} ${flow.year.ganZhi}流年 · ${flow.year.age}岁 · ${flow.cycle.ganZhi}${flow.cycle.index ? '大运' : ''}`;
  renderPillars(flow);
  requestAnimationFrame(() => {
    for (const id of ['cycles', 'years']) {
      const track = $(id), active = track.querySelector('.active');
      if (!active || !track.clientWidth) continue;
      const cell = active.getBoundingClientRect(), viewport = track.getBoundingClientRect();
      if (cell.left < viewport.left || cell.right > viewport.right) track.scrollLeft += cell.left - viewport.left - (track.clientWidth - cell.width) / 2;
    }
  });
}
async function loadCases(append = false) {
  if (!can('cases:view')) return;
  if (!append) await loadCategories();
  const offset = append ? caseOffset : 0;
  const result = await api('/cases?' + new URLSearchParams({ search: $('search').value, categoryId: $('category-filter').value, offset, limit: 30 }));
  if (!append) { $('case-list').replaceChildren(); selectedCases.clear(); }
  for (const item of result.cases) {
    const entry = document.createElement('div'); entry.className = 'ml-case-entry';
    const button = document.createElement('button'); button.className = 'ml-case-card'; button.type = 'button'; button.dataset.case = item.id;
    button.innerHTML = `<strong>${escape(item.name)}</strong><span class="ml-category-badge">${escape(item.categoryName || '未分类')}</span><p class="ml-case-pillars">${item.pillars.map(escape).join(' · ')}</p><p>${item.birth.calendar === 'lunar' ? '农历' : '公历'} ${item.birth.year}-${item.birth.leapMonth ? '闰' : ''}${item.birth.month}-${item.birth.day} · ${item.birth.gender === 1 ? '男' : '女'}</p><p class="ml-muted">标签：${escape(item.tags.join(' / ')) || '无'}</p><p class="ml-muted">${escape(item.notePreview)}</p><small>更新于 ${escape(new Date(item.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }))}</small>`;
    entry.append(button);
    if (can('cases:classify') && can('categories:view')) {
      const check = document.createElement('input'); check.type = 'checkbox'; check.dataset.selectCase = item.id;
      check.setAttribute('aria-label', '选择案例：' + item.name); check.className = 'ml-case-select'; entry.append(check);
    }
    $('case-list').append(entry);
  }
  caseOffset = offset + result.cases.length;
  $('case-count').textContent = `${result.total} 个案例`;
  $('more-cases').hidden = caseOffset >= result.total;
  if (!result.total) $('case-list').textContent = $('search').value || $('category-filter').value ? '当前筛选没有匹配的案例。' : '还没有案例，先排一张命盘并保存。';
  syncSelection();
}
function syncSelection() {
  const checks = [...$('case-list').querySelectorAll('[data-select-case]')];
  $('selection-count').textContent = `已选 ${selectedCases.size} 条`;
  $('select-loaded').checked = !!checks.length && checks.every(c => selectedCases.has(c.dataset.selectCase));
  $('select-loaded').indeterminate = !!selectedCases.size && !$('select-loaded').checked;
  $('move-cases').disabled = busy || !selectedCases.size;
}
async function loadCategories() {
  if (!can('categories:view')) return;
  categoryData = await api('/categories');
  const options = categoryData.categories.map(c => `<option value="${c.id}">${escape(c.name)}</option>`).join('');
  for (const id of ['case-category', 'bulk-category', 'category-filter']) {
    const previous = $(id).value;
    $(id).innerHTML = id === 'category-filter'
      ? `<option value="">全部分类（${categoryData.total}）</option><option value="uncategorized">未分类（${categoryData.uncategorized}）</option>` + categoryData.categories.map(c => `<option value="${c.id}">${escape(c.name)}（${c.count}）</option>`).join('')
      : '<option value="">未分类</option>' + options;
    $(id).value = [...$(id).options].some(o => o.value === previous) ? previous : '';
  }
  $('category-manager-list').innerHTML = categoryData.categories.length ? categoryData.categories.map(c => `<div class="ml-category-row" data-category="${c.id}"><label>分类名称：${escape(c.name)}<input value="${escape(c.name)}" maxlength="30" ${can('categories:edit') ? '' : 'readonly'}></label><span class="ml-muted">${c.count} 个案例</span>${can('categories:edit') ? '<button type="button" class="btn ghost" data-rename-category>保存名称</button><button type="button" class="btn ghost" data-delete-category>删除分类</button>' : ''}</div>`).join('') : '<p class="ml-muted">还没有分类，可以先新增一个。</p>';
}
function restore(item) {
  current = item; chart = item.chart;
  for (const k of birthKeys) { if (['leapMonth', 'trueSolar'].includes(k)) $(k).checked = item.birth[k]; else $(k).value = item.birth[k] ?? ''; }
  $('case-name').value = item.name; $('tags').value = item.tags.join('，'); $('notes').value = item.notes;
  $('use-recorded-clock').checked = !!item.birth.recordedSolarTime;
  if (item.categoryId && ![...$('case-category').options].some(o => o.value === item.categoryId)) {
    const option = document.createElement('option'); option.value = item.categoryId; option.textContent = item.categoryName || '当前分类'; $('case-category').append(option);
  }
  $('case-category').value = item.categoryId || '';
  syncCalendar(); renderChart(); dirty = false;
  $('birth-panel').open = false;
}
$('birth-form').addEventListener('submit', e => { e.preventDefault(); run(async () => {
  status('正在排盘…');
  const result = await api('/chart', 'POST', birth()); chart = result.chart; dirty = true;
  renderChart(); $('birth-panel').open = false; status('排盘完成，可保存为自己的案例。');
}); });
$('birth-form').addEventListener('input', e => {
  dirty = true; status();
  if (['calendar', 'year', 'month', 'day', 'hour', 'minute', 'leapMonth'].includes(e.target.id)) { $('recordedSolarTime').value = ''; $('use-recorded-clock').checked = false; }
  if (e.target.id === 'trueSolar' && $('trueSolar').checked) $('use-recorded-clock').checked = false;
  if (e.target.id === 'use-recorded-clock' && $('use-recorded-clock').checked) $('trueSolar').checked = false;
  if (e.target.id !== 'case-name') { chart = null; renderChart(); }
  else $('chart-title').textContent = $('case-name').value.trim() || '未命名命盘';
  syncCalendar();
});
for (const id of ['tags', 'notes']) $(id).addEventListener('input', () => { dirty = true; status(); });
$('case-category').addEventListener('change', () => { dirty = true; status(); });
$('category-filter').addEventListener('change', () => run(() => loadCases()));
$('manage-categories').addEventListener('click', () => run(async () => { await loadCategories(); $('category-manager').hidden = !$('category-manager').hidden; }));
$('close-categories').addEventListener('click', () => { $('category-manager').hidden = true; });
$('category-create-form').addEventListener('submit', e => { e.preventDefault(); run(async () => {
  await api('/categories', 'POST', { name: $('new-category-name').value }); $('new-category-name').value = '';
  await loadCategories(); status('分类已新增。');
}); });
$('category-manager-list').addEventListener('click', e => {
  const row = e.target.closest('[data-category]'); if (!row) return;
  if (e.target.closest('[data-rename-category]')) run(async () => {
    await api('/categories/' + row.dataset.category, 'PUT', { name: row.querySelector('input').value });
    await loadCases(); status('分类名称已更新。');
  });
  if (e.target.closest('[data-delete-category]')) run(async () => {
    const category = categoryData.categories.find(c => c.id === row.dataset.category);
    if (!await window.portalDialog.confirm(`删除分类「${category.name}」？其中 ${category.count} 个案例将归入未分类，案例及笔记会保留。`, { title: '删除分类', danger: true })) return;
    await api('/categories/' + category.id, 'DELETE');
    if (current?.categoryId === category.id) { current.categoryId = null; $('case-category').value = ''; }
    await loadCases(); status('分类已删除，案例已归入未分类。');
  });
});
$('case-list').addEventListener('change', e => {
  if (!e.target.matches('[data-select-case]')) return;
  if (e.target.checked) selectedCases.add(e.target.dataset.selectCase); else selectedCases.delete(e.target.dataset.selectCase);
  syncSelection();
});
$('select-loaded').addEventListener('change', () => {
  $('case-list').querySelectorAll('[data-select-case]').forEach(c => { c.checked = $('select-loaded').checked; if (c.checked) selectedCases.add(c.dataset.selectCase); else selectedCases.delete(c.dataset.selectCase); });
  syncSelection();
});
$('move-cases').addEventListener('click', () => run(async () => {
  const result = await api('/cases/category', 'POST', { ids: [...selectedCases], categoryId: $('bulk-category').value });
  if (current && selectedCases.has(current.id)) { current.categoryId = $('bulk-category').value || null; $('case-category').value = $('bulk-category').value; }
  await loadCases(); status(`已移动 ${result.count} 个案例。`);
}));
$('cycles').addEventListener('click', e => { const b = e.target.closest('[data-cycle]'); if (b) { cycleIndex = Number(b.dataset.cycle); renderCycles(); } });
$('years').addEventListener('click', e => { const b = e.target.closest('[data-year]'); if (b) { selectedYear = Number(b.dataset.year); renderCycles(); } });
$('chart-tab').addEventListener('click', () => tab('chart'));
$('cases-tab').addEventListener('click', () => run(async () => { await loadCases(); tab('cases'); status(); }));
$('search-form').addEventListener('submit', e => { e.preventDefault(); run(() => loadCases()); });
$('more-cases').addEventListener('click', () => run(() => loadCases(true)));
$('import-file').addEventListener('change', () => run(async () => {
  pendingImport = null; $('confirm-import').hidden = true; $('import-preview').textContent = '';
  const file = $('import-file').files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) throw new Error('迁移文件不能超过 2MB');
  let bundle;
  try { bundle = JSON.parse((await file.text()).replace(/^\uFEFF/, '')); } catch { throw new Error('文件不是合法 JSON'); }
  $('import-preview').textContent = '正在解析并逐条核对四柱…';
  const result = await api('/import/preview', 'POST', bundle);
  $('import-preview').textContent = `共 ${result.total} 条，有效 ${result.valid} 条，重复 ${result.duplicates} 条；四柱一致 ${result.matched} 条，差异 ${result.mismatches} 条。${result.errors.map(e => `第 ${e.row} 条：${e.error}`).join('；')}`;
  if (!result.errors.length && !result.mismatches) { pendingImport = bundle; $('confirm-import').hidden = false; }
}));
$('confirm-import').addEventListener('click', () => run(async () => {
  if (!pendingImport) return;
  status('正在导入案例…');
  const result = await api('/import/confirm', 'POST', pendingImport);
  pendingImport = null; $('confirm-import').hidden = true; $('import-file').value = '';
  $('import-preview').textContent = `新增 ${result.imported} 条，跳过重复 ${result.duplicates} 条。`;
  $('search').value = ''; await loadCases(); status('案例导入完成。');
}));
$('case-list').addEventListener('click', e => { const b = e.target.closest('[data-case]'); if (b) run(async () => {
  if (!await discard()) return;
  restore((await api('/cases/' + b.dataset.case)).case); tab('chart'); status('已打开案例。');
}); });
$('new-case').addEventListener('click', () => run(async () => {
  if (!await discard()) return;
  current = null; chart = null; readingLayout = false; $('birth-form').reset(); $('tags').value = ''; $('notes').value = ''; dirty = false;
  $('birth-panel').open = true; $('birth-panel-caption').textContent = '填写后开始排盘';
  $('recordedSolarTime').value = '';
  $('case-category').value = '';
  syncCalendar(); renderChart(); status('填写新案例的出生信息。');
}));
$('save-case').addEventListener('click', () => run(async () => {
  if (!chart) throw new Error('请先排盘');
  if (!$('case-name').value.trim()) { $('case-name').focus(); throw new Error('请填写案例名称后保存'); }
  const data = { name: $('case-name').value, birth: chart.input, tags: $('tags').value.split(/[,，]/).map(t => t.trim()).filter(Boolean), notes: $('notes').value };
  if (can('cases:classify') && can('categories:view')) data.categoryId = $('case-category').value;
  const result = await api('/cases' + (current ? '/' + current.id : ''), current ? 'PUT' : 'POST', data);
  restore(result.case); status('案例已保存。');
}));
$('delete-case').addEventListener('click', () => run(async () => {
  if (!current || !await window.portalDialog.confirm(`确定删除案例「${current.name}」及其笔记？`, { title: '删除案例', danger: true })) return;
  await api('/cases/' + current.id, 'DELETE'); current = null; dirty = true; $('saved-at').textContent = '案例已删除，当前命盘尚未保存'; status('案例已删除。');
}));
window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
run(async () => {
  const response = await fetch('/api/me'); const me = await response.json();
  if (!response.ok || !me.ok || me.isGuest) throw new Error('请先登录后使用命理模块');
  permissions = me.permissions || [];
  if (!can('view')) throw new Error('当前账号没有命理模块权限');
  $('cases-tab').hidden = !can('cases:view'); $('save-case').hidden = !can('cases:edit');
  $('import-panel').hidden = !can('cases:import');
  $('category-filter-label').hidden = !can('categories:view'); $('manage-categories').hidden = !can('categories:view');
  $('category-create-form').hidden = !can('categories:edit');
  $('case-category-label').hidden = !can('categories:view');
  $('bulk-classify').hidden = !can('cases:classify') || !can('categories:view');
  await loadCategories();
  syncCalendar(); status('出生时间按北京时间录入，案例仅当前账号可见。');
});
