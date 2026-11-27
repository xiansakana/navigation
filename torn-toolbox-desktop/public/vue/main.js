import { createApp } from 'vue';
import App from './App.vue';
import UndercutApp from './UndercutApp.vue';
import CompanyApp from './CompanyApp.vue';

const root = document.getElementById('torn-app');
const undercutRoot = document.getElementById('undercut-app');
const companyRoot = document.getElementById('company-app');

if (root) createApp(App).mount(root);
else if (undercutRoot) createApp(UndercutApp).mount(undercutRoot);
else if (companyRoot) createApp(CompanyApp).mount(companyRoot);
