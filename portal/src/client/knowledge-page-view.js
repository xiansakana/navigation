import { createApp } from 'vue';
import KnowledgePage from './KnowledgePage.vue';

export function mountKnowledgePage(container) {
  const app = createApp(KnowledgePage);
  app.mount(container);
  return {
    dispose() { app.unmount(); }
  };
}
