import { createApp } from 'vue';
import QuantPage from './QuantPage.vue';

export function mountQuantPage() {
  const root = document.querySelector('.quant-app') as HTMLElement | null || document.getElementById('app');
  if (!root) return null;
  root.innerHTML = '';
  const app = createApp(QuantPage);
  app.mount(root);
  return app;
}
