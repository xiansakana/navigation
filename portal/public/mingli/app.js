const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const birthKeys = ['calendar', 'gender', 'year', 'month', 'day', 'hour', 'minute', 'sect', 'yunSect', 'leapMonth', 'trueSolar', 'longitude', 'location', 'recordedSolarTime'];
let permissions = [], current = null, chart = null, dirty = false, busy = false, cycleIndex = 0, selectedYear = 0, caseOffset = 0;
let pendingImport = null;
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
}
function renderChart() {
  $('empty-chart').hidden = !!chart; $('chart-result').hidden = !chart;
  if (!chart) return;
  const c = chart, i = c.input;
  $('chart-title').textContent = $('case-name').value.trim() || '未命名命盘';
  $('chart-kind').textContent = i.gender === 1 ? '乾造 · 男' : '坤造 · 女';
  $('day-master').textContent = '日主 ' + c.dayMaster;
  $('birth-summary').innerHTML = `<div>公历 ${escape(c.solar)} · 北京时间</div><div>农历 ${escape(c.lunar)}${i.location ? ' · ' + escape(i.location) : ''}</div>${i.trueSolar || i.recordedSolarTime ? `<div>${i.recordedSolarTime ? '原站记录真太阳时' : '真太阳时'} ${escape(c.clock)}（修正 ${c.correctionMinutes > 0 ? '+' : ''}${c.correctionMinutes} 分钟）</div>` : ''}<div>前节 ${escape(c.previousJie.name)} ${escape(c.previousJie.time)} · 后节 ${escape(c.nextJie.name)} ${escape(c.nextJie.time)}</div>`;
  const element = (text, e) => `<span class="ml-element-${escape(e)}">${escape(text)}</span>`;
  const rows = [
    ['主星', p => escape(p.tenGod)],
    ['天干', p => `<span class="ml-character">${element(p.gan, p.elements[0])}</span>`],
    ['地支', p => `<span class="ml-character">${element(p.zhi, p.elements[1])}</span>`],
    ['藏干', p => p.hidden.map(h => `<span class="ml-hidden-stem">${element(h.gan, h.element)} <small>${escape(h.tenGod)}</small></span>`).join('')],
    ['纳音', p => escape(p.naYin)], ['旬空', p => escape(p.xunKong)]
  ];
  $('pillars').innerHTML = `<caption class="ml-hint">四柱命盘</caption><thead><tr><th scope="col">四柱</th>${c.pillars.map(p => `<th scope="col">${p.label}</th>`).join('')}</tr></thead><tbody>${rows.map(([title, render]) => `<tr><th scope="row">${title}</th>${c.pillars.map(p => `<td>${render(p)}</td>`).join('')}</tr>`).join('')}</tbody>`;
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
function renderCycles() {
  const cycles = chart.luck.cycles;
  $('cycles').innerHTML = cycles.map((d, index) => `<button type="button" data-cycle="${index}" aria-pressed="${index === cycleIndex}" class="${index === cycleIndex ? 'active' : ''}"><strong>${d.ganZhi}</strong><small>${d.startYear}—${d.endYear}</small><small>${d.startAge}—${d.endAge} 岁</small></button>`).join('');
  const years = cycles[cycleIndex].years;
  if (!years.some(y => y.year === selectedYear)) selectedYear = years[0].year;
  $('years').innerHTML = years.map(y => `<button type="button" data-year="${y.year}" aria-pressed="${y.year === selectedYear}" class="${y.year === selectedYear ? 'active' : ''}"><small>${y.year} · ${y.age} 岁</small>${y.ganZhi}</button>`).join('');
  const y = years.find(y => y.year === selectedYear);
  $('months-title').textContent = `${y.year} ${y.ganZhi} · 流月`;
  $('months').innerHTML = y.months.map(m => `<span><small>${m.label}</small>${m.ganZhi}</span>`).join('');
}
async function loadCases(append = false) {
  if (!can('cases:view')) return;
  const offset = append ? caseOffset : 0;
  const result = await api('/cases?' + new URLSearchParams({ search: $('search').value, offset, limit: 30 }));
  if (!append) $('case-list').replaceChildren();
  for (const item of result.cases) {
    const button = document.createElement('button'); button.className = 'ml-case-card'; button.type = 'button'; button.dataset.case = item.id;
    button.innerHTML = `<strong>${escape(item.name)}</strong><p class="ml-case-pillars">${item.pillars.map(escape).join(' · ')}</p><p>${item.birth.calendar === 'lunar' ? '农历' : '公历'} ${item.birth.year}-${item.birth.leapMonth ? '闰' : ''}${item.birth.month}-${item.birth.day} · ${item.birth.gender === 1 ? '男' : '女'}</p><p class="ml-muted">${escape(item.tags.join(' / ')) || '无标签'}</p><p class="ml-muted">${escape(item.notePreview)}</p><small>更新于 ${escape(new Date(item.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }))}</small>`;
    $('case-list').append(button);
  }
  caseOffset = offset + result.cases.length;
  $('case-count').textContent = `${result.total} 个案例`;
  $('more-cases').hidden = caseOffset >= result.total;
  if (!result.total) $('case-list').textContent = $('search').value ? '没有找到匹配的案例。' : '还没有案例，先排一张命盘并保存。';
}
function restore(item) {
  current = item; chart = item.chart;
  for (const k of birthKeys) { if (['leapMonth', 'trueSolar'].includes(k)) $(k).checked = item.birth[k]; else $(k).value = item.birth[k] ?? ''; }
  $('case-name').value = item.name; $('tags').value = item.tags.join('，'); $('notes').value = item.notes;
  $('use-recorded-clock').checked = !!item.birth.recordedSolarTime;
  syncCalendar(); renderChart(); dirty = false;
}
$('birth-form').addEventListener('submit', e => { e.preventDefault(); run(async () => {
  status('正在排盘…');
  const result = await api('/chart', 'POST', birth()); chart = result.chart; dirty = true;
  renderChart(); status('排盘完成，可保存为自己的案例。');
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
  current = null; chart = null; $('birth-form').reset(); $('tags').value = ''; $('notes').value = ''; dirty = false;
  $('recordedSolarTime').value = '';
  syncCalendar(); renderChart(); status('填写新案例的出生信息。');
}));
$('save-case').addEventListener('click', () => run(async () => {
  if (!chart) throw new Error('请先排盘');
  if (!$('case-name').value.trim()) { $('case-name').focus(); throw new Error('请填写案例名称后保存'); }
  const data = { name: $('case-name').value, birth: chart.input, tags: $('tags').value.split(/[,，]/).map(t => t.trim()).filter(Boolean), notes: $('notes').value };
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
  syncCalendar(); status('出生时间按北京时间录入，案例仅当前账号可见。');
});
