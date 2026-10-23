# Torn 工具箱：Chain 监控

入口：`/torn-toolbox/` → Chain 监控，页面 `/torn-toolbox/chain/`。这是 navigation 的 Portal 内置模块，独立于浏览器用户脚本和原有压价/公司监听服务。

## 使用

1. 管理员分配 `torn-chain:view`，按需分配 `torn-chain:config:edit`、`torn-chain:control:edit`、`torn-chain:history:edit`。工具箱首页还需要原有工具箱访问权限；游客不可使用。
2. 保存 Torn Public API Key、长度上下限及轮次间隔。默认最小 100、最大不限、间隔 60 秒，范围包含边界，间隔最短 30 秒。留空 Key 保留已有值；删除 Key 使用独立按钮。
3. 点击启动。首次看见已冷却的 Chain 记录为“首次发现”；同次持续运行中核验到 Active → Cooldown 才记录为“刚进入冷却”。点击 report 链接手动打开报告。

保存配置会停止运行；停止/重启会重新建立观察基线。关闭浏览器不会停止服务器监控；Portal 服务重启后需手动启动。没有 QQ 推送或自动打开报告。

## API 与覆盖范围

只访问官方公开 API，不抓取游戏页面或调用游戏操作接口：

- `GET https://api.torn.com/v2/faction/warfarechains?cat=active&limit=100`，读取 `_metadata.links.next` 分页，最多 10 页。分页只允许官方域名和预期接口，不跟随 HTTP 跳转。
- `GET https://api.torn.com/v2/faction/{id}/chain`，必须与列表的 Chain ID 一致，再依据 `cooldown` Unix 秒时间戳和 `timeout` 核验状态。未知/失败结果保留原观察，不推测为已冷却。
- 每轮最多核验 40 条，其余轮换；已确认且未到期的冷却记录不重复核验。近期从列表消失的已知活动 Chain 最多继续核验 10 分钟。

请求在 Portal 本进程共用串行队列，间隔至少 1.5 秒（最多约 40 次/分钟）。轮次间隔从本轮结束计算，含排队时间，因此发现有延迟；多用户或大量候选时可能漏过短冷却。页面显示核验失败、待轮换和分页不完整状态。限流或失效 Key 会停止，修复后手动启动。其他 Torn 工具的请求仍共享 Torn 用户配额，本模块无法协调外部进程的用量。

官方参考：[API Playground](https://api-playground.torn.com/)、[API v2 更新讨论](https://www.torn.com/forums.php?a=0&b=0&f=63&p=threads&start=360&t=16401584)、[Chain 说明](https://wiki.torn.com/wiki/Chain)。`cat=active` 包含活动与冷却项；状态判断仍依赖详情核验。

## 数据与权限

`torn_chain_monitors` 在共享 SQLite 中按已认证 `user_id` 保存配置、最近 200 条报告和最近 5000 个去重 ID；清空报告保留去重 ID。API Key 保存在服务器数据库中，状态 API 只回传 `hasKey`，不返回密钥。数据库备份需要按凭据保护。运行基线仅在内存，不自动恢复运行。

页面、各操作 API 均检查 RBAC，写请求检查同源。后台每次请求前后复查运行权限，撤权或禁用账号后停止。报告名称使用文本节点渲染；链接固定为 `https://www.torn.com/war.php?step=chainreport&chainID={id}`，由用户手动打开。

## 验证与部署

- `node scripts/test.mjs portal`：Portal 全量测试，包含范围、基线/转换、去重、分页轮换、停止、用户隔离、Key 隐藏、权限和路由优先级。
- `node scripts/test-torn-chain-ui.cjs`：需 Playwright 和 Edge；本地模拟 API，阻断所有外部请求。检查工具箱及 Chain 页全宽切换/刷新持久化，390/320px 无溢出，权限和手动按钮。
- 桌面 1600px 实测：工具箱主体 720→1600、Chain 主体 1100→1600、两页导航栏均 1440→1600；切回恢复原尺寸。

只部署 `portal`，无新增进程或公网端口。首次授权访问自动创建表；备份共享数据库时包含 `torn_chain_monitors`。按仓库 Git/SHA 部署流程运行 `scripts/ecs-update.sh --expected-sha <sha> --only portal`，部署本身不会启动扫描。
