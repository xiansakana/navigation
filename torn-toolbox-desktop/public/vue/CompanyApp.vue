<script setup>
import { onMounted, ref } from 'vue';

const companyTab = ref('application');
const globalStatus = ref('就绪');

function setCompanyTab(name) {
  companyTab.value = name === 'salary' || name === 'training' || name === 'stock' ? name : 'application';
}

function setGlobalStatus(text) {
  globalStatus.value = text == null ? '' : String(text);
}

onMounted(() => {
  window.TornShell = { setCompanyTab, setGlobalStatus, get companyTab() { return companyTab.value; } };
});
</script>

<template>
  <div class="app" data-layout-container data-skeleton="dashboard" data-skeleton-key="page">
    <header class="header">
      <div>
        <h1>公司监听</h1>
        <p class="subtitle">申请、扣工资、员工训练与库存提醒 · 支持多账号</p>
      </div>
      <div class="header-status" id="global-status">{{ globalStatus }}</div>
    </header>

    <p class="hint">提醒规则、通知目标与测试请前往 <a href="/notifications/#business-company">通知管理 · 公司提醒</a>。此处仅配置监控。</p>

    <section class="card notification-legacy" hidden>
      <h2>全局设置</h2>
      <div class="checks">
        <label><input type="checkbox" id="notify-desktop" checked> 桌面通知</label>
        <label><input type="checkbox" id="notify-qq" checked> QQ 通知</label>
      </div>
      <div class="field">
        <label for="qq-url">QQ 推送地址</label>
        <input type="text" id="qq-url" value="http://127.0.0.1:8787/notify">
      </div>
      <div class="field">
        <label for="qq-token">QQ 推送 Token</label>
        <input type="password" id="qq-token" placeholder="与 qq-bot notifyToken 一致">
      </div>
    </section>

    <nav id="company-tabs" class="btn-row" aria-label="公司监听"><button class="btn" data-company-tab="application" :aria-pressed="String(companyTab === 'application')" @click="setCompanyTab('application')">申请</button><button class="btn" data-company-tab="salary" hidden :aria-pressed="String(companyTab === 'salary')">扣工资</button><button class="btn" data-company-tab="training" hidden :aria-pressed="String(companyTab === 'training')">员工训练</button><button class="btn" data-company-tab="stock" hidden :aria-pressed="String(companyTab === 'stock')">库存</button></nav>
    <section class="card" id="company-application" :hidden="companyTab !== 'application'">
      <div class="section-head">
        <h2 style="margin:0">监听账号</h2>
        <button type="button" class="btn small" id="co-add-watcher">+ 添加账号</button>
      </div>
      <p class="hint">每个 Torn API Key 可添加多个 QQ 通知方式（群 @ 人 / 群直接发 / 私聊均可同时配置）。</p>
      <div id="co-watchers" class="watcher-list"></div>
      <div class="btn-row">
        <button type="button" class="btn primary" id="co-save-config">保存公司监听配置</button>
      </div>
      <div class="field inline">
        <label for="co-interval">检查间隔（秒）</label>
        <input type="number" id="co-interval" value="30" min="10" max="300">
      </div>
      <div class="btn-row">
        <button class="btn green" id="co-start">开始监听</button>
        <button class="btn red" id="co-stop" hidden>停止</button>
      </div>
      <div class="status-box" id="co-status">
        <p><strong id="co-status-text">已停止</strong></p>
        <p>下次检查：<span id="co-next">--</span></p>
        <p>已检查 <span id="co-checks">0</span> 次 · 申请 <span id="co-apps">0</span> 个</p>
        <p id="co-message"></p>
      </div>
      <div class="list" id="co-list"></div>
    </section>
    <section class="card" id="company-operations" :hidden="companyTab === 'application'">
      <h2 id="ops-title"></h2><p class="hint" id="ops-explanation"></p>
      <p class="hint">独立保存当前用户的经营提醒，沿用申请 Tab 中已启用的公司账号。仅提醒，请自行操作游戏。</p>
      <form id="ops-form"><div class="field"><label>监控公司账号（可多选）</label><div id="ops-watchers" class="checks"></div></div>
      <div class="checks"><label><input id="ops-enabled" type="checkbox">启用本项监控</label></div>
      <div id="ops-thresholds" class="watcher-grid"></div>
      <div class="field"><label for="ops-interval">经营提醒扫描间隔（秒）</label><input id="ops-interval" type="number" min="30" max="3600" value="60"></div>
      <div class="btn-row"><button id="ops-save" class="btn primary">保存本项配置（保存后需启动）</button><button id="ops-start" type="button" class="btn green">启动经营提醒</button><button id="ops-stop" type="button" class="btn red">停止经营提醒</button></div></form>
      <p id="ops-status" role="status"></p><div id="ops-rows"></div><p><a id="ops-notification-link" href="/notifications/">通知管理 → 业务提醒</a></p>
      <h3>本项提醒记录</h3><div id="ops-history"></div>
    </section>
  </div>
</template>
