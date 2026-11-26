import { createApp } from 'vue';
import LoginForm from './LoginForm.vue';

export function mountLoginView(container) {
  createApp(LoginForm).mount(container);
}
