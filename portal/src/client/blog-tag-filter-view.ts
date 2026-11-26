import { createApp, h, shallowRef } from 'vue';

export interface BlogTag {
  tag: string;
  count: number;
}

export function mountBlogTagFilter(host: HTMLElement) {
  const tags = shallowRef<BlogTag[]>([]);
  const active = shallowRef('');

  const app = createApp(() => [{ tag: '', count: null as number | null }, ...tags.value].map(item => h('button', {
    key: item.tag || 'all',
    type: 'button',
    class: 'blog-tag',
    'data-tag': item.tag,
    'aria-pressed': String(active.value === item.tag)
  }, item.tag ? '#' + item.tag + ' (' + item.count + ')' : '全部动态')));
  app.mount(host);

  return {
    render(next: BlogTag[], current: string) {
      tags.value = next;
      active.value = current;
    },
    dispose() { app.unmount(); }
  };
}
