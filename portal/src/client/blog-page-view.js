import { createApp } from 'vue';
import BlogPage from './BlogPage.vue';

export function mountBlogPage(container) {
  const app = createApp(BlogPage);
  app.mount(container);
  return {
    dispose() { app.unmount(); }
  };
}
