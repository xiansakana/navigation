import { createApp } from 'vue';
import DipPage from './DipPage.vue';

export function mountDipPage() {
  const root = document.getElementById('app');
  if (!root) return null;
  root.innerHTML = '';
  const app = createApp(DipPage);
  app.mount(root);
  return app;
}
