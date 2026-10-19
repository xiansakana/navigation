# 页面路由

业务页面使用小写单词、连字符和目录式路径。查询参数保留现有驼峰命名。
以下入口以 `https://saoyu.fun` 为基址。

| 模块 | 入口 |
| --- | --- |
| 首页 | `/` |
| 登录 | `/login/` |
| 权限管理 | `/admin/` |
| 股票持仓 | `/stock-manage/` |
| 抄底监控 | `/stock-manage/dip/` |
| 量化分析 | `/stock-manage/quant/` |
| 梭哈 | `/stock-manage/yolo/` |
| Torn 工具箱 | `/torn-toolbox/` |
| 压价助手 | `/torn-toolbox/undercut/` |
| 公司监听 | `/torn-toolbox/company/` |
| 记账 | `/bookkeeping/` |
| 资源管理 | `/resources/` |
| 博客动态 | `/#blog-section`（首页内模块） |
| 笔记 | `/notes/`（自动进入电脑或手机界面） |
| 笔记发布站 | `/publish/` |
| AList 网盘 | `/alist/` |
| NapCat 管理 | `/napcat/webui`（上游应用入口） |
| PicList 图床 | `/piclist/manage`（Portal 管理页） |
| 通知管理 | `/notifications/` |
| 笔记分享 | `https://share.saoyu.fun/dashboard`（独立站点） |

## 游客浏览

公开知识库使用 `/knowledge/public/`，游客访问 `/knowledge/` 时自动显示此浏览页。
Codex CLI 的游客入口只提供公开说明和入口状态。游客浏览权限与资料公开范围见
[`docs/guest-module-browsing.md`](../docs/guest-module-browsing.md)。

## 旧地址兼容

`/login`、`/login.html`、`/login/index.html` 永久跳转（308）到 `/login/`。
`/admin`、`/admin.html`、`/admin/index.html` 永久跳转（308）到 `/admin/`。
跳转保留查询参数，包括登录错误信息。新入口继续执行原有登录和权限检查。

API 路由保留 `/api/` 命名空间，例如 `/api/login`、`/api/admin/*`。
GitHub 和 Google 的 OAuth 回调继续使用 `/api/oauth/{provider}/callback`。
上游应用入口由各应用负责，未在本次规范化中更名。
