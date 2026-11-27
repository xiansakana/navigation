import { createApp } from 'vue';
import HoldingsPage from './HoldingsPage.vue';

export function mountHoldingsPage() {
  const root = document.getElementById('app');
  if (!root) return null;
  root.innerHTML = '';
  const app = createApp(HoldingsPage);
  app.mount(root);
  return app;
}
