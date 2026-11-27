import { createApp } from 'vue';
import App from './App.vue';
import PublicApp from './PublicApp.vue';

const workspaceRoot = document.getElementById('codex-app');
const publicRoot = document.getElementById('codex-public-app');
if (workspaceRoot) createApp(App).mount(workspaceRoot);
else if (publicRoot) createApp(PublicApp).mount(publicRoot);
