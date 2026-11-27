<script setup>
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import { flowPillar, selectedFlow, shortGod } from '../../public/mingli/chart-presentation.js';
import { createCaseFilters } from '../../public/mingli/case-filters.js';
import { createKnowledgeCases } from '../../public/mingli/knowledge-cases.js';

const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const birthKeys = ['calendar', 'gender', 'year', 'month', 'day', 'hour', 'minute', 'sect', 'yunSect', 'leapMonth', 'trueSolar', 'longitude', 'location', 'recordedSolarTime'];

const statusText = ref('');
const errorText = ref('');
const activeTab = ref('chart');
const busy = ref(false);
const chartReady = ref(false);
const caseEditorVisible = ref(false);
const sourceRecordVisible = ref(false);
const savedAt = ref('尚未保存');
const categoryManagerOpen = ref(false);
const importPreviewText = ref('');
const importConfirmVisible = ref(false);
const importVisible = ref(false);
const bulkVisible = ref(false);
const categoryFilterVisible = ref(false);
const categoryCreateVisible = ref(false);
const caseCategoryVisible = ref(false);
const selectionCount = ref('已选 0 条');
const caseListHost = ref(null);

let permissions = [];
let current = null;
let chart = null;
let dirty = false;
let cycleIndex = 0;
let selectedYear = 0;
let caseOffset = 0;
let pendingImport = null;
let readingLayout = false;
let caseQuery = null;
let categoryData = { categories: [], total: 0, uncategorized: 0 };
const selectedCases = new Set();
let caseItems = [];
let caseView;
let caseViewReady;
let advancedFilters;
let knowledgeCases;

const can = action => permissions.includes('*') || permissions.includes('mingli:' + action);

function setStatus(message = '') { statusText.value = message; }
function setError(message = '') { errorText.value = message; }

function renderCaseList(emptyText) {
  if (!caseViewReady) {
    const url = '/generated/mingli-cases-view.js?v=1';
    caseViewReady = import(url).then(({ mountMingliCasesView }) => {
      caseView = mountMingliCasesView(caseListHost.value, { canClassify: can('cases:classify') && can('categories:view') });
    });
  }
  return caseViewReady.then(() => caseView.render(caseItems, selectedCases, emptyText));
}

function birth() {
  const value = Object.fromEntries(birthKeys.map(k => [k, ['leapMonth', 'trueSolar'].includes(k) ? $(k).checked : $(k).value]));
  if (!$('use-recorded-clock').checked) value.recordedSolarTime = null;
  return value;
}

function syncCalendar() {
  $('leap-label').hidden = $('calendar').value !== 'lunar';
  $('longitude').required = $('trueSolar').checked;
  $('recorded-clock-settings').hidden = !$('recordedSolarTime').value;
  $('recorded-clock-label').textContent = $('recordedSolarTime').value
    ? $('recordedSolarTime').value + '（来源参考时刻；修改出生日期或时间后自动停用）' : '';
}

function syncActions() {
  knowledgeCases?.busy(busy.value);
  advancedFilters?.busy(busy.value);
  $('calculate').disabled = busy.value || !can('chart:calculate');
  $('save-case').disabled = busy.value || !chart || !can('cases:edit');
  $('delete-case').hidden = !current || !can('cases:delete');
  $('delete-case').disabled = busy.value;
  $('new-case').disabled = busy.value;
  $('cases-tab').disabled = busy.value;
  $('more-cases').disabled = busy.value;
  $('import-file').disabled = busy.value;
  $('confirm-import').disabled = busy.value || !pendingImport || !can('cases:import') || !can('cases:edit');
  $('search-form').querySelector('button').disabled = busy.value;
  caseListHost.value?.querySelectorAll('button').forEach(el => { el.disabled = busy.value; });
  $('birth-form').querySelectorAll('input,select').forEach(el => { el.disabled = busy.value; });
  $('tags').disabled = busy.value || !can('cases:edit');
  $('notes').readOnly = busy.value || !can('cases:edit');
  for (const id of ['category-filter', 'bulk-category', 'select-loaded', 'manage-categories']) $(id).disabled = busy.value;
  $('case-category').disabled = busy.value || !can('cases:classify') || !can('categories:view');
  $('move-cases').disabled = busy.value || !selectedCases.size;
  $('category-manager').querySelectorAll('input,button').forEach(el => { el.disabled = busy.value; });
  caseListHost.value?.querySelectorAll('input[type=checkbox]').forEach(el => { el.disabled = busy.value; });
}

async function api(path, method = 'GET', data) {
  const response = await fetch('/api/mingli' + path, {
    method,
    headers: data ? { 'Content-Type': 'application/json' } : {},
    body: data ? JSON.stringify(data) : undefined
  });
  let result;
  try { result = await response.json(); }
  catch { throw new Error('服务暂不可用，请重新登录或稍后再试'); }
  if (!response.ok || !result.ok) throw new Error(result.error || '请求失败');
  return result;
}

async function run(fn) {
  if (busy.value) return;
  busy.value = true; setError(''); syncActions();
  try { await fn(); }
  catch (e) { setError(e.message); setStatus(''); }
  finally { busy.value = false; syncActions(); }
}

async function discard() {
  return !dirty || !can('cases:edit') || await window.portalDialog.confirm('当前修改尚未保存，确定离开当前案例吗？', { title: '未保存的修改' });
}

function tab(name) {
  activeTab.value = name;
  document.querySelector('.ml-shell').classList.toggle('ml-reading', readingLayout && name === 'chart');
}

function element(text, e) {
  return `<span class="ml-element-${escape(e)}">${escape(text)}</span>`;
}

function renderPillars(flow) {
  const { columns } = flow;
  const cellClass = p => p.flow ? 'ml-pillar-flow' : p.label === '日柱' ? 'ml-pillar-day' : '';
  const rows = [
    ['主星', p => escape(p.tenGod || '—')],
    ['天干', p => p.gan ? `<span class="ml-character">${element(p.gan, p.elements[0])}</span>` : '—'],
    ['地支', p => p.zhi ? `<span class="ml-character">${element(p.zhi, p.elements[1])}</span>` : '—'],
    ['藏干', p => p.hidden?.map(h => `<span class="ml-hidden-stem">${element(h.gan + h.element, h.element)}</span>`).join('') || '—'],
    ['副星', p => p.hidden?.map(h => `<span class="ml-hidden-stem">${escape(h.tenGod)}</span>`).join('') || '—'],
    ['纳音', p => escape(p.naYin || '—')],
    ['旬空', p => escape(p.xunKong || '—')]
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
  cycleIndex = flow.cycleIndex;
  selectedYear = flow.year.year;
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

function renderChart() {
  chartReady.value = !!chart;
  if (chart) readingLayout = true;
  document.querySelector('.ml-workspace').classList.toggle('has-chart', readingLayout);
  document.querySelector('.ml-shell').classList.toggle('ml-reading', readingLayout && activeTab.value === 'chart');
  if (!chart) {
    caseEditorVisible.value = false;
    sourceRecordVisible.value = false;
    return;
  }
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
  caseEditorVisible.value = !!can('cases:edit') || !!current;
  savedAt.value = current ? '已保存 · ' + new Date(current.updatedAt).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }) : '尚未保存';
  sourceRecordVisible.value = !!current?.source;
  if (current?.source) {
    const s = current.source, o = s.original;
    $('source-summary').textContent = `问真案例；原站分组：${s.group || '未分组'}；${o.star ? '已星标' : '未星标'}；原始公历：${o.solarTime}；原始农历：${o.lunarTime || '未记录'}；原站真太阳时：${o.sunTime}；原始四柱：${s.originalPillars}。导入时四柱${s.matched ? '逐柱一致' : '存在差异'}。来源 ID：${s.key}。后续编辑不会改写此来源快照。`;
  }
  $('rules').textContent = `${c.engine}；立春时刻换年，十二节时刻换月；${i.sect === 1 ? '23:00' : '00:00'} 换日。晚子时时干沿用历法库的子时口径；${i.yunSect === 1 ? '传统时辰折算' : '分钟折算'}起运。时间均按 UTC+8 输入，不自动处理历史夏令时。${i.recordedSolarTime ? '日时柱沿用原站保存的真太阳时；年、月柱及交运按原始北京时间。' : i.trueSolar ? '日时柱使用经度与均时差修正；年、月柱及交运按真实时刻。节气边界或时辰边界附近请核验原始出生记录。' : ''}`;
  syncActions();
}

async function loadCases(append = false) {
  if (!can('cases:view')) return;
  if (!append) await loadCategories();
  const offset = append ? caseOffset : 0;
  const query = append && caseQuery ? caseQuery : { search: $('search').value, categoryId: $('category-filter').value, filters: JSON.stringify(advancedFilters.value()) };
  const result = await api('/cases?' + new URLSearchParams({ ...query, offset, limit: 30 }));
  caseQuery = query;
  if (!append) { caseItems = []; selectedCases.clear(); }
  caseItems.push(...result.cases);
  await renderCaseList(query.search || query.categoryId || query.filters !== '{}' ? '当前筛选没有匹配的案例。' : '还没有案例，先排一张命盘并保存。');
  caseOffset = offset + result.cases.length;
  $('case-count').textContent = `${result.total} 个案例`;
  $('more-cases').hidden = caseOffset >= result.total;
  advancedFilters.describe(query.search, query.categoryId);
  syncSelection();
}

function syncSelection() {
  const checks = [...caseListHost.value.querySelectorAll('[data-select-case]')];
  selectionCount.value = `已选 ${selectedCases.size} 条`;
  $('select-loaded').checked = !!checks.length && checks.every(c => selectedCases.has(c.dataset.selectCase));
  $('select-loaded').indeterminate = !!selectedCases.size && !$('select-loaded').checked;
  $('move-cases').disabled = busy.value || !selectedCases.size;
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
  $('category-manager-list').innerHTML = categoryData.categories.length
    ? categoryData.categories.map(c => `<div class="ml-category-row" data-category="${c.id}"><label>分类名称：${escape(c.name)}<input value="${escape(c.name)}" maxlength="30" ${can('categories:edit') ? '' : 'readonly'}></label><span class="ml-muted">${c.count} 个案例</span>${can('categories:edit') ? '<button type="button" class="btn ghost" data-rename-category>保存名称</button><button type="button" class="btn ghost" data-delete-category>删除分类</button>' : ''}</div>`).join('')
    : '<p class="ml-muted">还没有分类，可以先新增一个。</p>';
}

function restore(item) {
  current = item;
  chart = item.chart;
  for (const k of birthKeys) {
    if (['leapMonth', 'trueSolar'].includes(k)) $(k).checked = item.birth[k];
    else $(k).value = item.birth[k] ?? '';
  }
  $('case-name').value = item.name;
  $('tags').value = item.tags.join('，');
  $('notes').value = item.notes;
  $('use-recorded-clock').checked = !!item.birth.recordedSolarTime;
  if (item.categoryId && ![...$('case-category').options].some(o => o.value === item.categoryId)) {
    const option = document.createElement('option');
    option.value = item.categoryId;
    option.textContent = item.categoryName || '当前分类';
    $('case-category').append(option);
  }
  $('case-category').value = item.categoryId || '';
  syncCalendar();
  renderChart();
  dirty = false;
  $('birth-panel').open = false;
}

async function calculate() {
  await run(async () => {
    setStatus('正在排盘…');
    const result = await api('/chart', 'POST', birth());
    chart = result.chart;
    dirty = true;
    renderChart();
    $('birth-panel').open = false;
    setStatus('排盘完成，可保存为自己的案例。');
  });
}

function onBirthInput(event) {
  dirty = true;
  setStatus('');
  if (['calendar', 'year', 'month', 'day', 'hour', 'minute', 'leapMonth'].includes(event.target.id)) {
    $('recordedSolarTime').value = '';
    $('use-recorded-clock').checked = false;
  }
  if (event.target.id === 'trueSolar' && $('trueSolar').checked) $('use-recorded-clock').checked = false;
  if (event.target.id === 'use-recorded-clock' && $('use-recorded-clock').checked) $('trueSolar').checked = false;
  if (event.target.id !== 'case-name') { chart = null; renderChart(); }
  else $('chart-title').textContent = $('case-name').value.trim() || '未命名命盘';
  syncCalendar();
}

function onCaseFieldInput() { dirty = true; setStatus(''); }

async function openCasesTab() {
  await run(async () => {
    await loadCases();
    tab('cases');
    setStatus('');
  });
}

async function toggleCategoryManager() {
  await run(async () => {
    await loadCategories();
    categoryManagerOpen.value = !categoryManagerOpen.value;
  });
}

async function createCategory(event) {
  event.preventDefault();
  await run(async () => {
    await api('/categories', 'POST', { name: $('new-category-name').value });
    $('new-category-name').value = '';
    await loadCategories();
    setStatus('分类已新增。');
  });
}

async function onCategoryManagerClick(event) {
  const row = event.target.closest('[data-category]');
  if (!row) return;
  if (event.target.closest('[data-rename-category]')) {
    await run(async () => {
      await api('/categories/' + row.dataset.category, 'PUT', { name: row.querySelector('input').value });
      await loadCases();
      setStatus('分类名称已更新。');
    });
  }
  if (event.target.closest('[data-delete-category]')) {
    await run(async () => {
      const category = categoryData.categories.find(c => c.id === row.dataset.category);
      if (!await window.portalDialog.confirm(`删除分类「${category.name}」？其中 ${category.count} 个案例将归入未分类，案例及笔记会保留。`, { title: '删除分类', danger: true })) return;
      await api('/categories/' + category.id, 'DELETE');
      if (current?.categoryId === category.id) { current.categoryId = null; $('case-category').value = ''; }
      await loadCases();
      setStatus('分类已删除，案例已归入未分类。');
    });
  }
}

function onCaseSelectionChange(event) {
  if (!event.target.matches('[data-select-case]')) return;
  if (event.target.checked) selectedCases.add(event.target.dataset.selectCase);
  else selectedCases.delete(event.target.dataset.selectCase);
  syncSelection();
}

function toggleLoadedSelection() {
  caseListHost.value.querySelectorAll('[data-select-case]').forEach(c => {
    c.checked = $('select-loaded').checked;
    if (c.checked) selectedCases.add(c.dataset.selectCase);
    else selectedCases.delete(c.dataset.selectCase);
  });
  syncSelection();
}

async function moveCases() {
  await run(async () => {
    const result = await api('/cases/category', 'POST', { ids: [...selectedCases], categoryId: $('bulk-category').value });
    if (current && selectedCases.has(current.id)) {
      current.categoryId = $('bulk-category').value || null;
      $('case-category').value = $('bulk-category').value;
    }
    await loadCases();
    setStatus(`已移动 ${result.count} 个案例。`);
  });
}

function onCycleClick(event) {
  const b = event.target.closest('[data-cycle]');
  if (b) { cycleIndex = Number(b.dataset.cycle); renderCycles(); }
}

function onYearClick(event) {
  const b = event.target.closest('[data-year]');
  if (b) { selectedYear = Number(b.dataset.year); renderCycles(); }
}

async function onSearchSubmit() {
  await run(() => loadCases());
}

async function loadMoreCases() {
  await run(() => loadCases(true));
}

async function onImportFileChange() {
  await run(async () => {
    pendingImport = null;
    importConfirmVisible.value = false;
    importPreviewText.value = '';
    const file = $('import-file').files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) throw new Error('迁移文件不能超过 2MB');
    let bundle;
    try { bundle = JSON.parse((await file.text()).replace(/^\uFEFF/, '')); }
    catch { throw new Error('文件不是合法 JSON'); }
    importPreviewText.value = '正在解析并逐条核对四柱…';
    const result = await api('/import/preview', 'POST', bundle);
    importPreviewText.value = `共 ${result.total} 条，有效 ${result.valid} 条，重复 ${result.duplicates} 条；四柱一致 ${result.matched} 条，差异 ${result.mismatches} 条。${result.errors.map(e => `第 ${e.row} 条：${e.error}`).join('；')}`;
    if (!result.errors.length && !result.mismatches) {
      pendingImport = bundle;
      importConfirmVisible.value = true;
    }
  });
}

async function confirmImport() {
  await run(async () => {
    if (!pendingImport) return;
    setStatus('正在导入案例…');
    const result = await api('/import/confirm', 'POST', pendingImport);
    pendingImport = null;
    importConfirmVisible.value = false;
    $('import-file').value = '';
    importPreviewText.value = `新增 ${result.imported} 条，跳过重复 ${result.duplicates} 条。`;
    $('search').value = '';
    await loadCases();
    setStatus('案例导入完成。');
  });
}

async function openCase(event) {
  const b = event.target.closest('[data-case]');
  if (!b) return;
  await run(async () => {
    if (!await discard()) return;
    restore((await api('/cases/' + b.dataset.case)).case);
    tab('chart');
    setStatus('已打开案例。');
  });
}

async function newCase() {
  await run(async () => {
    if (!await discard()) return;
    current = null;
    chart = null;
    readingLayout = false;
    $('birth-form').reset();
    $('tags').value = '';
    $('notes').value = '';
    dirty = false;
    $('birth-panel').open = true;
    $('birth-panel-caption').textContent = '填写后开始排盘';
    $('recordedSolarTime').value = '';
    $('case-category').value = '';
    syncCalendar();
    renderChart();
    setStatus('填写新案例的出生信息。');
  });
}

async function saveCase() {
  await run(async () => {
    if (!chart) throw new Error('请先排盘');
    if (!$('case-name').value.trim()) { $('case-name').focus(); throw new Error('请填写案例名称后保存'); }
    const data = { name: $('case-name').value, birth: chart.input, tags: $('tags').value.split(/[,，]/).map(t => t.trim()).filter(Boolean), notes: $('notes').value };
    if (can('cases:classify') && can('categories:view')) data.categoryId = $('case-category').value;
    const result = await api('/cases' + (current ? '/' + current.id : ''), current ? 'PUT' : 'POST', data);
    restore(result.case);
    setStatus('案例已保存。');
  });
}

async function deleteCase() {
  await run(async () => {
    if (!current || !await window.portalDialog.confirm(`确定删除案例「${current.name}」及其笔记？`, { title: '删除案例', danger: true })) return;
    await api('/cases/' + current.id, 'DELETE');
    current = null;
    dirty = true;
    savedAt.value = '案例已删除，当前命盘尚未保存';
    setStatus('案例已删除。');
  });
}

function beforeUnload(event) {
  if (dirty && can('cases:edit')) { event.preventDefault(); event.returnValue = ''; }
}

async function boot() {
  await run(async () => {
    const me = await window.portalPage.user();
    permissions = me.permissions || [];
    if (me.isGuest) permissions = permissions.filter(p => ['mingli:view', 'mingli:chart:calculate'].includes(p));
    knowledgeCases.permissions(permissions);
    if (!can('view')) throw new Error('当前账号没有命理模块权限');
    $('cases-tab').hidden = !can('cases:view');
    $('save-case').hidden = !can('cases:edit');
    advancedFilters.show(can('cases:view') && can('cases:filter'));
    importVisible.value = can('cases:import');
    categoryFilterVisible.value = can('categories:view');
    categoryCreateVisible.value = can('categories:edit');
    caseCategoryVisible.value = can('categories:view');
    bulkVisible.value = can('cases:classify') && can('categories:view');
    await loadCategories();
    syncCalendar();
    setStatus(me.isGuest
      ? '游客排盘体验：出生信息仅用于本次计算，不保存案例。登录后可使用获授权的个人案例功能。'
      : '出生时间按北京时间录入，案例仅当前账号可见。');
  });
}

onMounted(() => {
  advancedFilters = createCaseFilters(action => run(() => action(() => loadCases())));
  knowledgeCases = createKnowledgeCases({ run, api, tab });
  syncCalendar();
  window.addEventListener('beforeunload', beforeUnload);
  boot().catch(error => setError(error.message));
});

onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', beforeUnload);
  caseView?.dispose();
});
</script>

<template>
  <div class="ml-page">
    <header class="ml-heading"><div><a href="/" class="ml-muted">← 我的服务</a><p class="ml-eyebrow">四时有序 · 记录有据</p><h1>命理研习</h1><p class="ml-muted">从一张命盘开始，积累自己的案例与观察。</p></div><span class="ml-badge">☯ 八字 · 案例</span></header>
    <p id="status" class="ml-status" role="status" aria-live="polite">{{ statusText }}</p>
    <p id="error" class="ml-error" role="alert" :hidden="!errorText">{{ errorText }}</p>
    <nav class="ml-tabs" aria-label="命理导航">
      <button id="chart-tab" :class="{ active: activeTab === 'chart' }" :aria-pressed="activeTab === 'chart'" @click="tab('chart')">八字排盘</button>
      <button id="cases-tab" hidden :class="{ active: activeTab === 'cases' }" :aria-pressed="activeTab === 'cases'" @click="openCasesTab">我的案例</button>
      <button id="knowledge-tab" hidden :class="{ active: activeTab === 'knowledge' }" :aria-pressed="activeTab === 'knowledge'">知识库案例</button>
    </nav>
    <section id="chart-view" :hidden="activeTab !== 'chart'">
      <div class="ml-workspace">
        <details id="birth-panel" class="ml-panel ml-input-panel" open><summary><span>出生信息与排盘设置</span><span id="birth-panel-caption" class="ml-muted">填写后开始排盘</span></summary>
          <div class="ml-panel-heading"><h2>出生信息</h2><button type="button" id="new-case" class="btn ghost" @click="newCase">新建</button></div>
          <form id="birth-form" @submit.prevent="calculate" @input="onBirthInput">
            <label>案例名称<input id="case-name" maxlength="80" placeholder="姓名或案例代号" autocomplete="off"></label>
            <div class="ml-form-grid">
              <label>历法<select id="calendar"><option value="solar">公历</option><option value="lunar">农历</option></select></label>
              <label>性别（用于顺逆行）<select id="gender"><option value="1">男 · 乾造</option><option value="0">女 · 坤造</option></select></label>
            </div>
            <div class="ml-date-grid"><label>年<input id="year" type="number" min="1901" max="2099" required value="1990"></label><label>月<input id="month" type="number" min="1" max="12" required value="1"></label><label>日<input id="day" type="number" min="1" max="31" required value="1"></label></div>
            <label id="leap-label" class="ml-check" hidden><input id="leapMonth" type="checkbox">农历闰月</label>
            <div class="ml-form-grid"><label>时（0—23）<input id="hour" type="number" min="0" max="23" required value="12"></label><label>分<input id="minute" type="number" min="0" max="59" required value="0"></label></div>
            <p class="ml-hint">请输入北京时间（UTC+8），历史夏令时需先减去 1 小时。时刻不详请先核实，不自动猜测。</p>
            <details class="ml-settings"><summary>排盘规则与出生地</summary>
              <label>出生地备注<input id="location" maxlength="100" placeholder="如：浙江杭州"></label>
              <label>日柱换日<select id="sect"><option value="2">00:00 换日（晚子时仍属当日）</option><option value="1">23:00 换日（子初换日）</option></select></label>
              <label>起运算法<select id="yunSect"><option value="1">传统时辰折算</option><option value="2">分钟折算</option></select></label>
              <label class="ml-check"><input id="trueSolar" type="checkbox">使用真太阳时计算日柱、时柱</label>
              <div id="recorded-clock-settings" hidden><input type="hidden" id="recordedSolarTime"><label class="ml-check"><input id="use-recorded-clock" type="checkbox">沿用原站保存的真太阳时</label><p id="recorded-clock-label" class="ml-hint"></p></div>
              <label>出生地经度（东正西负）<input id="longitude" type="number" min="-180" max="180" step="any" placeholder="如：120.155"></label>
              <p class="ml-hint">真太阳时＝北京时间＋经度时差＋均时差（天文近似）。年、月柱与起运仍按实际出生瞬间和节气计算。</p>
            </details>
            <button id="calculate" type="submit" class="btn primary ml-wide" disabled>开始排盘</button>
          </form>
        </details>
        <div class="ml-results">
          <div id="empty-chart" class="ml-panel ml-empty" :hidden="chartReady"><span class="ml-empty-icon">☯</span><h2>观四柱，记人生</h2><p class="ml-muted">填写出生信息后排盘，查看十神、藏干与大运流年。</p><p class="ml-hint">计算独立运行，不依赖第三方排盘接口。</p></div>
          <div id="chart-result" :hidden="!chartReady">
            <article class="ml-panel ml-natal-panel"><div class="ml-panel-heading"><div><p class="ml-eyebrow" id="chart-kind"></p><h2 id="chart-title">八字命盘</h2></div><span id="day-master" class="ml-badge"></span></div><div id="birth-summary" class="ml-birth-summary"></div><div class="ml-table-scroll"><table id="pillars" class="ml-pillars"></table></div><details class="ml-chart-notes"><summary>节气与五行统计</summary><p id="term-summary" class="ml-hint"></p><div id="elements" class="ml-elements"></div><p class="ml-hint">五行仅统计四柱天干与地支本气的 8 个字，不含藏干权重，不代表旺衰或喜用神。</p></details></article>
            <article class="ml-panel ml-luck-panel"><div class="ml-panel-heading"><h2>大运 · 流年</h2><span class="ml-muted">虚岁 · 横向滑动查看</span></div><p id="luck-summary" class="ml-muted"></p><p id="flow-selection" class="ml-flow-selection" aria-live="polite"></p><div class="ml-flow-row"><h3>大运</h3><div id="cycles" class="ml-flow-track" aria-label="选择大运" @click="onCycleClick"></div></div><div class="ml-flow-row"><h3>流年</h3><div id="years" class="ml-flow-track" aria-label="选择流年" @click="onYearClick"></div></div><div class="ml-flow-row"><h3 id="months-title">流月</h3><div id="months" class="ml-flow-track" aria-label="流月"></div></div><p class="ml-hint ml-flow-footnote">点选岁运，对照左侧命盘。流年以立春、流月以十二节划分；交运以起运时刻为准。</p></article>
            <article id="case-editor" class="ml-panel" :hidden="!caseEditorVisible"><div class="ml-panel-heading"><h2>案例记录</h2><span id="saved-at" class="ml-muted">{{ savedAt }}</span></div>
              <label id="case-category-label" :hidden="!caseCategoryVisible">案例分类<select id="case-category" @change="onCaseFieldInput"><option value="">未分类</option></select></label><label>标签（逗号分隔，最多 12 个）<input id="tags" maxlength="371" placeholder="如：学习、已核对、事业" @input="onCaseFieldInput"></label>
              <label>观察与事件笔记<textarea id="notes" rows="7" maxlength="20000" placeholder="记录事件日期、实际经历、推断与后续核验，保留观察依据。" @input="onCaseFieldInput"></textarea></label>
              <div class="ml-actions"><button id="save-case" class="btn primary" hidden @click="saveCase">保存案例</button><button id="delete-case" class="btn ghost" hidden @click="deleteCase">删除案例</button></div>
            </article>
            <details id="source-record" class="ml-panel ml-rules" :hidden="!sourceRecordVisible"><summary>原站记录与导入核对</summary><p id="source-summary" class="ml-muted"></p></details>
            <details class="ml-panel ml-rules"><summary>当前计算口径</summary><p id="rules" class="ml-muted"></p><p class="ml-hint">排盘用于传统文化学习与案例整理；本模块不生成吉凶结论。</p></details>
          </div>
        </div>
      </div>
    </section>
    <section id="cases-view" :hidden="activeTab !== 'cases'"><article class="ml-panel"><div class="ml-panel-heading"><div><h2>我的案例库</h2><p class="ml-muted">按当前登录账号独立保存，其他用户无法访问。</p></div><span id="case-count" class="ml-badge">0 个案例</span></div><div class="ml-category-toolbar"><label id="category-filter-label" :hidden="!categoryFilterVisible">案例分类<select id="category-filter" @change="run(() => loadCases())"><option value="">全部分类</option></select></label><button type="button" id="manage-categories" class="btn ghost" :hidden="!categoryFilterVisible" @click="toggleCategoryManager">分类管理</button></div><section id="category-manager" class="ml-category-manager" :hidden="!categoryManagerOpen"><div class="ml-panel-heading"><h3>分类管理</h3><button type="button" id="close-categories" class="btn ghost" @click="categoryManagerOpen = false">收起</button></div><p class="ml-hint">分类与标签独立。重命名同步更新案例分类；删除分类后案例归入未分类，原站来源快照保留。</p><form id="category-create-form" class="ml-search" :hidden="!categoryCreateVisible" @submit="createCategory"><label>新分类名称<input id="new-category-name" maxlength="30" required placeholder="如：客户、待核对"></label><button type="submit" class="btn primary">新增分类</button></form><div id="category-manager-list" @click="onCategoryManagerClick"></div></section><div id="bulk-classify" class="ml-bulk" :hidden="!bulkVisible"><label class="ml-check"><input id="select-loaded" type="checkbox" @change="toggleLoadedSelection">选择已加载案例</label><span id="selection-count" class="ml-muted">{{ selectionCount }}</span><label>移动到<select id="bulk-category"><option value="">未分类</option></select></label><button type="button" id="move-cases" class="btn ghost" disabled @click="moveCases">移动所选案例</button></div><details id="import-panel" class="ml-settings" :hidden="!importVisible"><summary>导入问真案例</summary><p class="ml-hint">选择问真案例迁移 JSON 文件，先预览，再确认导入到当前账号。按原站案例 ID 去重，重复导入不覆盖已有案例或笔记。原站时间、分组、星标及四柱保留在来源记录中。</p><label>迁移文件（JSON，最大 2MB）<input id="import-file" type="file" accept=".json,application/json" @change="onImportFileChange"></label><div id="import-preview" class="ml-hint" role="status">{{ importPreviewText }}</div><button type="button" id="confirm-import" class="btn primary" :hidden="!importConfirmVisible" @click="confirmImport">确认导入案例</button></details><form id="search-form" class="ml-search" @submit.prevent="onSearchSubmit"><label>搜索案例<input type="search" id="search" maxlength="100" placeholder="名称、标签或笔记"></label><button class="btn ghost" type="submit">搜索</button></form><div id="case-list" ref="caseListHost" class="ml-case-list" @click="openCase" @change="onCaseSelectionChange"></div><button id="more-cases" class="btn ghost" hidden @click="loadMoreCases">加载更多</button></article></section>
    <section id="knowledge-view" :hidden="activeTab !== 'knowledge'">
      <article class="ml-panel">
        <div class="ml-panel-heading"><div><h2>知识库案例</h2><p class="ml-muted">从自己的知识库笔记自动归集，保留课程上下文与来源。</p></div><span id="kc-count" class="ml-badge">0 条案例</span></div>
        <p class="ml-hint">笔记生成、编辑后自动更新；同一来源的相同四柱合并收录。原文的案例陈述和推断均未独立验证，自动提取内容需核对。未提供出生日期时只展示原局，不反推出生信息或大运。</p>
        <form id="kc-search-form" class="ml-search"><label>检索知识库案例<input id="kc-search" type="search" maxlength="100" placeholder="案例标题、原文、课程或标签"></label><label>来源课程<select id="kc-document"><option value="">全部来源</option></select></label><button class="btn ghost" type="submit">搜索</button></form>
        <div id="kc-list" class="ml-case-list"></div>
        <nav id="kc-pagination" class="ml-pagination" aria-label="知识库案例分页" hidden>
          <p id="kc-page-info" class="ml-hint" aria-live="polite"></p>
          <div class="ml-page-controls"><button id="kc-prev" class="btn ghost" type="button">上一页</button><div id="kc-pages" class="ml-page-numbers"></div><button id="kc-next" class="btn ghost" type="button">下一页</button></div>
          <form id="kc-jump-form" class="ml-page-jump"><label>跳至<input id="kc-page-input" type="number" min="1" step="1" value="1" required aria-label="跳转页码">页</label><button id="kc-jump" class="btn ghost" type="submit">跳转</button></form>
        </nav>
      </article>
      <article id="kc-detail" class="ml-panel ml-natal-panel" hidden>
        <h2 id="kc-title"></h2><p id="kc-meta" class="ml-hint"></p><a id="kc-source" class="btn ghost" target="_blank" rel="noopener noreferrer">查看知识库原文</a><div id="kc-references" class="ml-actions"></div>
        <div class="ml-table-scroll ml-kc-table"><table id="kc-pillars" class="ml-pillars"></table></div>
        <h3>案例原文与分析</h3><p class="ml-hint">保留原文的事实陈述、备选、推断和待核对项；内容随来源笔记更新。</p><pre id="kc-excerpt" class="ml-kc-excerpt"></pre>
      </article>
    </section>
  </div>
</template>
