<script setup>
import { onMounted, ref } from 'vue';

const publicStatus = ref('正在检查浏览入口…');

onMounted(() => {
  window.CodexShell = {
    setPublicStatus(text) {
      publicStatus.value = text;
    }
  };
  window.portalLayout?.set(window.portalLayout.get());
});
</script>

<template>
  <main class="codex-shell" data-layout-container>
    <header class="codex-heading"><div><a href="/">← 我的服务</a><h1>Codex CLI</h1><p>把想法变成项目任务，让问答、代码修改和执行记录留在同一个工作台。</p></div><a href="/login/" class="btn primary">登录后使用</a></header>
    <section class="panel"><h2>公开浏览</h2><p id="public-status" role="status">{{ publicStatus }}</p><p>授权用户可创建会话、跟踪项目任务，并管理自己的待办。会话内容、执行记录、账户额度和服务器设置需要单独授权。</p></section>
  </main>
</template>
