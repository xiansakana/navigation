# 游客模块浏览

首页始终展示 Codex CLI、知识库和命理入口；菜单被禁用时仍遵守禁用设置。
页面和 API 都检查对应查看权限。部署后仅一次为 guest 补充安全浏览权限，
后续管理员撤销的权限不会在每次读取配置时重新加回。

## 默认权限与边界

- `codex-cli:view`：游客进入公开说明页，通过 `/api/codex-cli/public-status` 查看浏览入口状态。
  此状态只表示公开入口可用，不代表服务器账户或执行器状态。
  会话、Todo、任务执行、账户额度、模型和服务器配置继续要求登录与单独授权。
- `knowledge:view`、`knowledge:notes:view`：游客通过 `/api/knowledge/public/documents` 浏览作者主动公开的笔记。
  只返回 ID、标题、分类、标签、正文和时间；不返回作者账户、文件名、来源链接、存储信息、转写、截图或处理配置。
  私有、处理中和已删除的文档不会进入公开列表、搜索或详情。
- `mingli:view`、`mingli:chart:calculate`：游客只能调用无持久化的排盘计算。
  个人案例、分类、笔记、知识库案例和导入接口均拒绝游客，即使 guest 被误授予通配权限。

## 知识库发布

`knowledge_documents.visibility` 默认 `private`，已有资料不会自动公开。
登录用户获得 `knowledge:publish:edit` 后，可在自己的已生成笔记中选择公开正文或撤回。
当前个人功能策略为普通登录用户自动授予此权限，API 始终限制为自己的笔记。
公开前有正文隐私提示；公开范围不包含原视频、转写及截图。
更新使用 `PUT /api/knowledge/documents/{id}/visibility`，要求查看、发布权限、同源请求和匹配的 revision。
撤回后公开详情立即返回 404；公开响应使用 `Cache-Control: no-store`。

`/knowledge/public/` 为公开浏览页，登录用户也可进入；
游客访问 `/knowledge/` 时直接显示公开浏览页。
普通登录用户的 `/knowledge/` 仍为自己的知识库。

## 验证

`portal/src/guest-browsing.test.js` 覆盖窄范围默认授权、后续撤权、公开字段白名单、
私有文档隔离、作者归属、版本冲突、公开撤回及游客禁写。
页面验收还应检查游客不加载私有工作台控件、排盘不保存案例，以及公共布局切换。
