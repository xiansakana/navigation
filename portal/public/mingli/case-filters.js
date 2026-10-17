import { STEMS, BRANCHES, PILLARS, RELATIONS } from './filter-options.js?v=1';

export function createCaseFilters(onApply, { prefix = '', anchor = 'search-form', search = 'search', category = 'category-filter', basicFields = ['gender', 'location', 'solarFrom', 'solarTo', 'notes'] } = {}) {
  const $ = id => document.getElementById(({ 'search-form': anchor, search, 'category-filter': category })[id] || prefix + id);
  const panel = document.createElement('details');
  panel.id = prefix + 'advanced-filters'; panel.className = 'ml-advanced'; panel.hidden = true;
  const options = chars => '<option value="">不限</option>' + [...chars].map(c => `<option>${c}</option>`).join('');
  panel.innerHTML = `<summary>高级筛选 <span id="advanced-count" class="ml-muted">未启用</span></summary>
    <form id="advanced-form"><fieldset id="advanced-fields"><legend class="ml-sr-only">案例高级筛选条件</legend>
      <p class="ml-hint">与关键词、分类同时生效；不同条件需全部满足。只检索保存的原局四柱，不含藏干、大运或流年。</p>
      <div class="ml-filter-basic">
        <label>性别<select id="filter-gender"><option value="">不限</option><option value="1">男</option><option value="0">女</option></select></label>
        <label>出生地区包含<input id="filter-location" maxlength="100" placeholder="如：安徽、池州"></label>
        <label>公历出生日期起<input id="filter-solarFrom" type="date" min="1901-01-01" max="2099-12-31"></label>
        <label>公历出生日期止<input id="filter-solarTo" type="date" min="1901-01-01" max="2099-12-31"></label>
        <label>事件笔记<select id="filter-notes"><option value="">不限</option><option value="yes">有笔记</option><option value="no">无笔记</option></select></label>
      </div>
      <h3>指定四柱</h3><div class="ml-filter-pillars">${PILLARS.map((label, i) => `<fieldset><legend>${label}</legend><label>${label}天干<select data-pillar="${i}" data-part="gan">${options(STEMS)}</select></label><label>${label}地支<select data-pillar="${i}" data-part="zhi">${options(BRANCHES)}</select></label></fieldset>`).join('')}</div>
      <h3>四柱包含干支</h3><p class="ml-hint">不限柱位，勾选的每个字均须出现在四柱明干或地支中。</p><div class="ml-filter-chips">${[...STEMS + BRANCHES].map(c => `<label><input type="checkbox" name="characters" value="${c}"><span>${c}</span></label>`).join('')}</div>
      <h3>原局干支关系</h3><label class="ml-relation-mode">已选关系匹配<select id="filter-relationMode"><option value="all">全部满足</option><option value="any">满足任意一项</option></select></label>
      <p class="ml-hint">按四柱中实际出现的字判定，不限相邻、不判断合化；三合、三会、三刑须字齐全，自刑须两个同字。</p>
      <div class="ml-filter-relations">${RELATIONS.map(([id, label, , values]) => `<fieldset><legend>${label}</legend><div class="ml-filter-chips">${values.map(v => `<label><input type="checkbox" name="relations" value="${id}:${v}"><span>${v}</span></label>`).join('')}</div></fieldset>`).join('')}</div>
      <div class="ml-actions"><button class="btn primary" type="submit">应用筛选</button><button id="reset-advanced" class="btn ghost" type="button">清空高级条件</button></div>
    </fieldset></form>`;
  for (const el of panel.querySelectorAll('[id]')) el.id = prefix + el.id;
  $('search-form').after(panel);
  const summary = document.createElement('div'); summary.id = prefix + 'filter-summary'; summary.className = 'ml-filter-summary'; summary.hidden = true;
  summary.innerHTML = '<p id="filter-description"></p><button id="clear-case-filters" class="btn ghost" type="button">清空全部筛选</button>';
  for (const el of summary.querySelectorAll('[id]')) el.id = prefix + el.id;
  panel.after(summary);
  for (const key of ['gender', 'location', 'solarFrom', 'solarTo', 'notes']) if (!basicFields.includes(key)) $('filter-' + key).closest('label').hidden = true;
  let applied = {}, descriptions = [];
  const form = $('advanced-form');
  const collect = () => {
    const f = {}, text = [];
    for (const key of basicFields) {
      const value = $('filter-' + key).value.trim();
      if (value) { f[key] = value; text.push(({ gender: '性别：' + (value === '1' ? '男' : '女'), location: '地区：' + value, solarFrom: '公历起：' + value, solarTo: '公历止：' + value, notes: value === 'yes' ? '有笔记' : '无笔记' })[key]); }
    }
    const pillars = PILLARS.map((label, i) => {
      const p = {};
      for (const part of ['gan', 'zhi']) { const v = form.querySelector(`[data-pillar="${i}"][data-part="${part}"]`).value; if (v) p[part] = v; }
      if (Object.keys(p).length) text.push(label + '：' + (p.gan || '＊') + (p.zhi || '＊'));
      return p;
    });
    if (pillars.some(p => Object.keys(p).length)) f.pillars = pillars;
    for (const key of ['characters', 'relations']) {
      const values = [...form.querySelectorAll(`input[name="${key}"]:checked`)].map(e => e.value);
      if (values.length) f[key] = values;
    }
    if (f.characters) text.push('包含：' + f.characters.join('、'));
    if (f.relations) {
      f.relationMode = $('filter-relationMode').value;
      text.push('关系' + (f.relationMode === 'all' ? '全部' : '任一') + '：' + f.relations.map(id => {
        const [group, value] = id.split(':'); return RELATIONS.find(r => r[0] === group)[1] + value;
      }).join('、'));
    }
    return { f, text };
  };
  form.addEventListener('submit', e => {
    e.preventDefault();
    if ($('filter-solarFrom').value && $('filter-solarTo').value && $('filter-solarFrom').value > $('filter-solarTo').value) {
      $('filter-solarTo').setCustomValidity('结束日期不能早于起始日期'); $('filter-solarTo').reportValidity(); return;
    }
    const next = collect();
    onApply(async load => {
      const before = { applied, descriptions };
      applied = next.f; descriptions = next.text;
      try { await load(); panel.open = false; } catch (e) { ({ applied, descriptions } = before); throw e; }
    });
  });
  $('filter-solarTo').addEventListener('input', () => $('filter-solarTo').setCustomValidity(''));
  $('filter-solarFrom').addEventListener('input', () => $('filter-solarTo').setCustomValidity(''));
  const reset = all => onApply(async load => {
    const before = { applied, descriptions }; applied = {}; descriptions = [];
    const search = $('search').value, category = $('category-filter').value;
    if (all) { $('search').value = ''; $('category-filter').value = ''; }
    try { await load(); form.reset(); $('filter-solarTo').setCustomValidity(''); }
    catch (e) { ({ applied, descriptions } = before); if (all) { $('search').value = search; $('category-filter').value = category; } throw e; }
  });
  $('reset-advanced').addEventListener('click', () => reset(false));
  $('clear-case-filters').addEventListener('click', () => reset(true));
  return {
    value: () => applied,
    show: allowed => { panel.hidden = !allowed; },
    busy: value => { $('advanced-fields').disabled = value; $('clear-case-filters').disabled = value; },
    describe(search, category) {
      const text = [...descriptions];
      if (search) text.unshift('关键词：' + search);
      if (category) text.unshift('分类：' + $('category-filter').selectedOptions[0].textContent);
      $('advanced-count').textContent = descriptions.length ? `已启用 ${descriptions.length} 项` : '未启用';
      summary.hidden = !text.length;
      $('filter-description').textContent = text.join('；');
    }
  };
}
