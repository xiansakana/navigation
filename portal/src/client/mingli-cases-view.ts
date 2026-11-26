import { createApp, h, shallowRef } from 'vue';

export interface MingliCase {
  id: string;
  name: string;
  categoryName?: string;
  pillars: string[];
  birth: { calendar: string; year: number; leapMonth?: boolean; month: number; day: number; gender: number };
  tags: string[];
  notePreview?: string;
  updatedAt: string;
}

const updated = (value: string) => new Date(value).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });

export function mountMingliCasesView(host: HTMLElement, options: { canClassify: boolean }) {
  const cases = shallowRef<MingliCase[]>([]);
  const selected = shallowRef<Set<string>>(new Set());
  const empty = shallowRef('');

  const app = createApp(() => cases.value.length ? cases.value.map(item => {
    const card = h('button', { key: item.id, type: 'button', class: 'ml-case-card', 'data-case': item.id }, [
      h('strong', item.name),
      h('span', { class: 'ml-category-badge' }, item.categoryName || '未分类'),
      h('p', { class: 'ml-case-pillars' }, item.pillars.join(' · ')),
      h('p', `${item.birth.calendar === 'lunar' ? '农历' : '公历'} ${item.birth.year}-${item.birth.leapMonth ? '闰' : ''}${item.birth.month}-${item.birth.day} · ${item.birth.gender === 1 ? '男' : '女'}`),
      h('p', { class: 'ml-muted' }, '标签：' + (item.tags.join(' / ') || '无')),
      h('p', { class: 'ml-muted' }, item.notePreview || ''),
      h('small', '更新于 ' + updated(item.updatedAt))
    ]);
    const checkbox = options.canClassify
      ? h('input', {
        type: 'checkbox', class: 'ml-case-select', 'data-select-case': item.id,
        'aria-label': '选择案例：' + item.name, checked: selected.value.has(item.id)
      })
      : null;
    return h('div', { key: item.id, class: 'ml-case-entry' }, checkbox ? [card, checkbox] : [card]);
  }) : [h('p', empty.value)]);
  app.mount(host);

  return {
    render(next: MingliCase[], selectedIds: Set<string>, emptyText = '') {
      cases.value = next;
      selected.value = selectedIds;
      empty.value = emptyText;
    },
    dispose() { app.unmount(); }
  };
}
