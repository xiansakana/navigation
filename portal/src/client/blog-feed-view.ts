import { createApp, h, shallowRef } from 'vue';

export interface BlogPost {
  id: string;
  authorId?: string;
  authorName?: string;
  createdAt: string;
  updatedAt: string;
  content: string;
  contentFormat?: string;
  contentHtml?: string;
  visibility?: { audience: string; startsAt?: string; endsAt?: string };
  location?: { label?: string; latitude?: number | null; longitude?: number | null };
  tags?: string[];
  commentCount?: number;
}

export interface FeedModel {
  posts: BlogPost[];
  userId: string;
  canPost: boolean;
  canManage: boolean;
  canViewComments: boolean;
  empty: string;
  generation?: number;
}

interface Helpers {
  editItems(post: BlogPost): any[];
  renderGallery(host: HTMLElement, items: any[]): void;
  locationSource(): Node;
  resolveAddress(location: any): Promise<string>;
}

const audienceLabels: Record<string, string> = { public: '公开动态', members: '仅登录用户', self: '仅自己（管理员可见）' };
const time = (value: string) => new Date(value).toLocaleString('sv-SE');

export function mountBlogFeed(host: HTMLElement, helpers: Helpers) {
  const model = shallowRef<FeedModel>({ posts: [], userId: '', canPost: false, canManage: false, canViewComments: false, empty: '' });

  function fillLocation(element: HTMLElement, post: BlogPost) {
    if (!element || element.dataset.ready) return;
    element.dataset.ready = '1';
    const location = post.location!;
    element.textContent = '📍 ' + (location.label || '正在解析位置地址…');
    if (location.latitude == null) return;
    const anchor = element as HTMLAnchorElement;
    anchor.href = 'https://www.openstreetmap.org/?mlat=' + location.latitude + '&mlon=' + location.longitude
      + '#map=15/' + location.latitude + '/' + location.longitude;
    anchor.target = '_blank'; anchor.rel = 'noopener noreferrer';
    element.after(helpers.locationSource());
    if (!location.label) {
      helpers.resolveAddress(location).then(label => {
        if (!element.isConnected) return;
        element.textContent = '📍 ' + (label || '地址暂不可用');
        if (label) location.label = label;
      }).catch(() => {});
    }
  }

  function fillGallery(element: HTMLElement, post: BlogPost) {
    if (!element || element.dataset.ready) return;
    element.dataset.ready = '1';
    helpers.renderGallery(element, helpers.editItems(post));
  }

  const app = createApp(() => {
    const state = model.value;
    if (!state.posts.length) return [h('p', { class: 'blog-empty' }, state.empty)];
    return state.posts.map(post => {
      const meta = [h('strong', post.authorName)];
      meta.push(h('time', { datetime: post.createdAt, class: 'blog-published-time' }, '发布于 ' + time(post.createdAt)));
      if (new Date(post.updatedAt).getTime() > new Date(post.createdAt).getTime()) {
        meta.push(h('time', { datetime: post.updatedAt, class: 'blog-edited-time' }, '最后编辑于 ' + time(post.updatedAt)));
      }
      const visibility = post.visibility || { audience: 'public' };
      let badge = audienceLabels[visibility.audience] || '';
      if (visibility.startsAt) badge += ' · ' + time(visibility.startsAt) + ' 起可见';
      if (visibility.endsAt) badge += ' · ' + time(visibility.endsAt) + ' 到期';
      if (visibility.startsAt && new Date(visibility.startsAt) > new Date()) badge += '（尚未开放）';
      if (visibility.endsAt && new Date(visibility.endsAt) <= new Date()) badge += '（已到期）';
      meta.push(h('span', { class: 'blog-visibility-badge' }, badge));

      const rich = post.contentFormat === 'html' || post.contentFormat === 'markdown';
      const body = h('div', {
        class: ['blog-post-content', rich ? 'blog-rich-content' : null],
        innerHTML: rich ? (post.contentFormat === 'markdown' ? post.contentHtml : post.content) : undefined
      }, rich ? undefined : post.content);

      const main: ReturnType<typeof h>[] = [
        h('div', { class: 'blog-post-meta' }, meta),
        body
      ];
      if (post.location) {
        main.push(h(post.location.latitude != null ? 'a' : 'span', {
          class: 'blog-post-location', ref: element => fillLocation(element as HTMLElement, post)
        }));
      }
      main.push(h('div', { class: 'blog-post-tags' }, (post.tags || []).map(tag => h('button', {
        type: 'button', class: 'blog-tag', 'data-tag': tag
      }, '#' + tag))));
      const items = helpers.editItems(post);
      if (items.length) {
        main.push(h('div', { class: 'blog-post-images', ref: element => fillGallery(element as HTMLElement, post) }));
      }
      const footer: ReturnType<typeof h>[] = [];
      if (state.canViewComments) {
        footer.push(h('button', {
          type: 'button', class: 'blog-action', 'data-action': 'comments', 'aria-expanded': 'false'
        }, '评论 (' + (post.commentCount || 0) + ')'));
      }
      if (state.canManage || (state.canPost && post.authorId === state.userId)) {
        footer.push(h('div', { class: 'blog-actions' }, [
          h('button', { type: 'button', class: 'blog-action', 'data-action': 'edit', 'data-id': post.id }, '编辑'),
          h('button', { type: 'button', class: 'blog-action', 'data-action': 'delete', 'data-id': post.id }, '删除')
        ]));
      }
      main.push(h('div', { class: 'blog-post-footer' }, footer));
      if (state.canViewComments) {
        main.push(h('div', { class: 'blog-comments' }, [h('div', { class: 'blog-comments-content', hidden: true })]));
      }
      return h('article', { key: post.id + ':' + (state.generation || 0), class: 'blog-post', 'data-id': post.id }, [
        h('span', { class: 'blog-avatar' }, (post.authorName || '?').slice(0, 1).toUpperCase()),
        h('div', { class: 'blog-post-main' }, main)
      ]);
    });
  });
  app.mount(host);

  return {
    render(next: FeedModel) { model.value = next; },
    dispose() { app.unmount(); }
  };
}
