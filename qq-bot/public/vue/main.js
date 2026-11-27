import { createApp } from 'vue';
import App from './App.vue';

const root = document.getElementById('notification-app');
if (root) createApp(App).mount(root);
