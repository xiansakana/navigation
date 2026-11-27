<script setup>
import { onMounted, reactive, ref, watch } from 'vue';

const initialView = location.hash === '#todos' ? 'todos' : location.hash === '#settings' ? 'settings' : 'workspace';
const activeView = ref(initialView);

const sessionQuery = ref('');
const sessionSource = ref('');
const showArchived = ref(false);
const todoFilter = ref('active');

const sessionNotice = ref('正在读取会话…');
const chatNotice = ref('');
const chatNoticeError = ref(false);
const todoNotice = ref('');
const todoNoticeError = ref(false);
const settingsMessage = ref('正在连接服务器 Codex…');
const settingsMessageType = ref('');

const sessions = ref([]);
const sessionSelected = ref('');

const newDialog = ref(null);
const renameDialog = ref(null);
const todoDialog = ref(null);
const dialogs = reactive({ newChat: false, rename: false, todo: false });
const dialogElements = { newChat: newDialog, rename: renameDialog, todo: todoDialog };

function applyDialog(name, open) {
  const element = dialogElements[name]?.value;
  if (!element) return;
  if (open) {
    if (!element.open) element.showModal();
  } else if (element.open) {
    element.close();
  }
}

for (const name of Object.keys(dialogs)) {
  watch(() => dialogs[name], open => applyDialog(name, open));
}

function setView(name) {
  const next = ['workspace', 'todos', 'settings'].includes(name) ? name : 'workspace';
  activeView.value = next;
  history.replaceState(null, '', location.pathname + location.search + (next === 'workspace' ? '' : '#' + next));
  document.dispatchEvent(new CustomEvent('codex-view', { detail: next }));
}

function notice(slot, text, type = '') {
  if (slot === 'chat') {
    chatNotice.value = text;
    chatNoticeError.value = type === 'error' || type === true;
  } else if (slot === 'todos') {
    todoNotice.value = text;
    todoNoticeError.value = type === 'error' || type === true;
  } else if (slot === 'sessions') {
    sessionNotice.value = text;
  } else if (slot === 'settings') {
    settingsMessage.value = text;
    settingsMessageType.value = typeof type === 'string' ? type : type ? 'error' : '';
  }
}

function setSessions(payload) {
  sessions.value = Array.isArray(payload?.items) ? payload.items : [];
  sessionSelected.value = payload?.selected || '';
  if (typeof payload?.notice === 'string') sessionNotice.value = payload.notice;
}

function openSession(id) {
  if (id && window.CodexChat?.select) void window.CodexChat.select(id);
}

function closeDialog(name) {
  if (name in dialogs) dialogs[name] = false;
}

onMounted(() => {
  window.CodexShell = { setView, notice, setSessions, openDialog: name => { if (name in dialogs) dialogs[name] = true; }, closeDialog, setArchived: value => { showArchived.value = !!value; }, get activeView() { return activeView.value; } };
  window.portalLayout?.set(window.portalLayout.get());
});
</script>

<template>
  <nav class="codex-tabs" aria-label="Codex模块"><button id="workspace-tab" :class="{ active: activeView === 'workspace' }" type="button" :aria-pressed="String(activeView === 'workspace')" @click="setView('workspace')">会话工作台</button><button id="todos-tab" :class="{ active: activeView === 'todos' }" type="button" :aria-pressed="String(activeView === 'todos')" hidden @click="setView('todos')">Todo 待办</button><button id="settings-tab" :class="{ active: activeView === 'settings' }" type="button" :aria-pressed="String(activeView === 'settings')" @click="setView('settings')">服务器与 QQ 设置</button></nav>
  <section id="workspace" class="workspace" data-layout-container aria-label="会话工作台" :hidden="activeView !== 'workspace'">
    <aside class="session-sidebar">
      <div class="sidebar-heading"><div><span class="eyebrow">CODEX WORKSPACE</span><h1>会话总览</h1></div><button id="new-chat" class="btn primary" type="button" hidden>＋ 新建</button></div>
      <label class="sr-only" for="session-search">搜索会话</label><input id="session-search" v-model="sessionQuery" type="search" placeholder="搜索标题或项目…" maxlength="100">
      <label class="sr-only" for="session-source">会话来源</label><select id="session-source" v-model="sessionSource" aria-label="会话来源"><option value="">全部来源</option><option value="web">网页</option><option value="qq">QQ</option><option value="knowledge">知识库</option><option value="cli">服务器 CLI</option></select>
      <label class="archive-filter"><input id="show-archived" v-model="showArchived" type="checkbox">显示已归档</label>
      <p id="sessions-notice" class="hint" role="status">{{ sessionNotice }}</p><div id="sessions" class="session-list" aria-label="我的会话列表"><button v-for="item in sessions" :key="item.id" type="button" class="session-entry" :class="{ selected: item.id === sessionSelected }" :aria-pressed="String(item.id === sessionSelected)" @click="openSession(item.id)"><strong>{{ item.title }}</strong><span>{{ item.meta }}</span></button></div>
      <button id="sessions-more" class="btn ghost" type="button" hidden>加载更多服务器会话</button><div class="sidebar-footer">网页、QQ、知识库与服务器 CLI 统一展示<br>服务器全部历史需要单独授权</div>
    </aside>
    <div class="chat-main">
      <header class="chat-heading"><div><h2 id="chat-title">开始一次新对话</h2><p id="chat-meta">与 Codex 讨论问题，或交给它完成项目任务。</p></div><div class="chat-actions"><button id="rename-chat" class="btn ghost" type="button" hidden>重命名</button><button id="archive-chat" class="btn ghost" type="button" hidden>归档</button></div></header>
      <p id="chat-notice" class="chat-notice" :class="{ error: chatNoticeError }" role="status" aria-live="polite">{{ chatNotice }}</p>
      <button id="history-more" class="btn ghost" type="button" hidden>加载更早对话</button>
      <div id="chat-scroll" class="chat-scroll"><div id="messages" class="messages"></div></div>
      <form id="chat-form" class="composer">
        <div class="composer-options"><label for="chat-model">模型</label><select id="chat-model" disabled><option value="">服务器默认</option></select><label for="chat-effort">强度</label><select id="chat-effort" disabled><option value="">默认</option></select><span id="task-state"></span></div>
        <label class="sr-only" for="chat-prompt">给 Codex 的消息</label><textarea id="chat-prompt" maxlength="20000" rows="3" placeholder="描述你的问题或任务…" disabled></textarea>
        <div class="composer-footer"><small>Enter 发送 · Shift+Enter 换行 · 关闭页面后任务继续执行</small><button id="stop-chat" type="button" class="btn ghost" hidden>停止任务</button><button id="send-chat" type="submit" class="btn primary" disabled>发送 ↑</button></div>
      </form>
    </div>
  </section>
  <section id="todos-view" class="todo-shell" data-layout-container aria-label="Todo 指令待办" :hidden="activeView !== 'todos'">
    <header class="todo-heading"><div><p class="eyebrow">PLAN / QUEUE / EXECUTE</p><h1>指令待办</h1><p class="muted">先安排好要做的事。可指定执行时间，到点且额度可用后自动执行。</p></div><button id="todo-new" class="btn primary" type="button" hidden>＋ 新增待办</button></header>
    <div class="todo-guide"><strong>关闭网页，待办仍会继续等待和执行。</strong><p>自动任务到达计划时间且普通 Codex 额度可用时进入队列；未到点的待办不会阻挡其他已到点的任务，同一账号已到点的待办按列表顺序执行。执行中耗尽额度会等待恢复后继续。普通失败会阻止后续待办，检查后可重试或暂停并跳过。结果保留在关联会话中。</p></div>
    <div class="todo-toolbar"><p id="todo-summary" class="muted">正在读取待办…</p><label for="todo-filter">显示</label><select id="todo-filter" v-model="todoFilter"><option value="active">待处理</option><option value="all">全部</option><option value="done">已完成</option></select></div>
    <p id="todo-notice" class="notice" :class="{ error: todoNoticeError }" role="status" aria-live="polite">{{ todoNotice }}</p><div id="todo-list" class="todo-list"></div>
  </section>
  <dialog id="todo-dialog" ref="todoDialog" class="chat-dialog todo-dialog" @close="closeDialog('todo')"><form id="todo-form"><h2 id="todo-dialog-title">新增待办</h2><label for="todo-title">标题</label><input id="todo-title" maxlength="80" required placeholder="例如：完善登录页面">
    <div class="todo-form-grid"><div><label for="todo-project">项目</label><select id="todo-project" required></select></div><div><label for="todo-conversation">执行会话</label><select id="todo-conversation"><option value="">执行时新建独立会话</option></select></div></div>
    <label for="todo-prompt">要交给 Codex 的指令</label><textarea id="todo-prompt" maxlength="20000" rows="6" required placeholder="写清目标、约束和完成标准…"></textarea>
    <div class="todo-form-grid"><div><label for="todo-model">模型</label><select id="todo-model"><option value="">执行时继承默认模型</option></select></div><div><label for="todo-effort">推理强度</label><select id="todo-effort"><option value="">默认</option></select></div></div>
    <label for="todo-scheduled">最早执行时间（北京时间，可选）</label><input id="todo-scheduled" type="datetime-local" max="2100-12-31T23:59"><p class="hint">留空则尽快执行。到点后仍需等待空闲和可用额度；过去的时间按已到点处理。</p>
    <label class="todo-auto"><input id="todo-auto" type="checkbox" checked>到达执行时间且额度可用时，按顺序自动执行</label><p class="hint">取消勾选则仅保存。开始执行前可以编辑指令和调整顺序；执行后可在关联会话中检查结果。</p>
    <p id="todo-form-error" class="todo-error" role="alert"></p><div class="dialog-actions"><button id="todo-cancel" class="btn ghost" type="button">取消</button><button id="todo-save" class="btn primary" type="submit">保存待办</button></div></form></dialog>
  <dialog id="new-dialog" ref="newDialog" class="chat-dialog" @close="closeDialog('newChat')"><form id="new-form"><h2>新建会话</h2><p class="hint">选择已授权的项目，Codex 将使用该项目的开发工作区。</p><label for="new-project">项目</label><select id="new-project" required></select><div class="dialog-actions"><button id="cancel-new" class="btn ghost" type="button">取消</button><button id="create-chat" class="btn primary" type="submit">创建会话</button></div></form></dialog>
  <dialog id="rename-dialog" ref="renameDialog" class="chat-dialog" @close="closeDialog('rename')"><form id="rename-form"><h2>重命名会话</h2><label for="new-title">会话标题</label><input id="new-title" maxlength="80" required><div class="dialog-actions"><button id="cancel-rename" class="btn ghost" type="button">取消</button><button id="save-title" class="btn primary" type="submit">保存</button></div></form></dialog>
  <main id="settings-view" class="codex-shell" data-layout-container :hidden="activeView !== 'settings'">
    <header class="codex-heading"><div><a class="back" href="/">← 我的服务</a><p class="eyebrow">SERVER / CODEX</p><h1>Codex CLI</h1><p class="muted">管理服务器上的 Codex，让网页设置与 QQ 任务保持一致。</p></div><button id="refresh" class="btn ghost" type="button">刷新状态</button></header>
    <p id="message" class="notice" :class="settingsMessageType" role="status" aria-live="polite">{{ settingsMessage }}</p>
    <section class="summary" aria-label="Codex运行状态">
      <article class="metric"><span>CLI 版本</span><strong id="cli-version">—</strong></article>
      <article class="metric"><span>服务器账户</span><strong id="account">—</strong><small id="account-detail"></small></article>
      <article class="metric"><span>服务器默认模型</span><strong id="default-summary">—</strong><small id="default-effort"></small></article>
      <article class="metric"><span>QQ 入口默认模型</span><strong id="qq-summary">—</strong><small id="qq-detail"></small></article>
    </section>
    <div class="config-grid">
      <section class="panel"><div class="section-heading"><span class="section-number">01</span><div><h2>服务器默认设置</h2><p>写入服务器 Codex 用户配置，对后续继承默认值的任务生效。</p></div></div>
        <form id="server-form"><fieldset id="server-fields" disabled><label for="server-model">默认模型</label><select id="server-model" required></select><label for="server-effort">推理强度</label><select id="server-effort"></select><p class="hint">可选项来自当前登录账号。保存时保留其他 CLI 配置；正在执行的任务不受影响。</p><button id="save-server" type="submit" class="btn primary" hidden>保存服务器默认设置</button></fieldset></form>
        <p id="server-readonly" class="hint" hidden>你有查看权限，保存服务器默认设置需要单独授权。</p><p id="override-notice" class="hint"></p>
        <div class="safety"><span>CLI 沙箱 <b id="sandbox">—</b></span><span>审批策略 <b id="approval">—</b></span></div>
      </section>
      <section class="panel"><div class="section-heading"><span class="section-number">02</span><div><h2>我的 QQ 设置</h2><p>与 QQ 指令共用设置，只影响你在所选会话中的后续任务。</p></div></div>
        <p id="qq-unavailable" class="hint" hidden>当前账号尚未配置 QQ Codex 执行权限。</p>
        <form id="runtime-form"><label for="scope">会话</label><select id="scope"><option value="">我的 QQ 私聊</option></select><fieldset id="runtime-fields" disabled><label for="runtime-model">模型</label><select id="runtime-model"></select><label for="runtime-effort">推理强度</label><select id="runtime-effort"></select><p id="effective" class="effective">实际运行设置：—</p><button id="save-runtime" type="submit" class="btn primary" hidden>保存此会话设置</button></fieldset></form>
        <div class="command-help"><p>也可以在 QQ 中切换</p><code>codex 模型</code><code>codex 模型 模型ID</code><code>codex 强度 强度值</code><small>强度值使用列表中的英文名称。发送「默认」恢复继承；切换模型会清除原强度覆盖。</small></div>
      </section>
    </div>
    <section id="usage-panel" class="panel usage-panel" hidden><div class="section-heading"><span class="section-number">03</span><div><h2>账户额度</h2><p>服务器当前登录账号的实时额度，重置时间使用北京时间。</p></div></div><pre id="usage">正在读取额度…</pre></section>
    <footer id="updated" class="muted"></footer>
  </main>
</template>
