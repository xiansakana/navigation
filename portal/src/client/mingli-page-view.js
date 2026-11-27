import { createApp } from 'vue';
import MingliPage from './MingliPage.vue';

export function mountMingliPage(container) {
  const app = createApp(MingliPage);
  app.mount(container);
  return {
    dispose() { app.unmount(); }
  };
}
