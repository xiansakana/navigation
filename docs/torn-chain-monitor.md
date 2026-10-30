# Torn 工具箱：监控

入口 `/torn-toolbox/` → **监控**，页面 `/torn-toolbox/chain/`。包含“帮派摧毁监控”和“帮派筛选”两个 Tab。原 Chain 冷却监控已被帮派摧毁监控替换，不再调用 warfarechains、Chain 详情或 report；路由、权限 ID `torn-chain:*` 和已有数据范围授权保持兼容。

## 帮派摧毁监控

使用官方 `/v2/faction/search`，Public Key 即可。完整分页读取 `notDestroyed` 和 respect 范围内的存活帮派，按 respect 升序显示。首次扫描建立存活基线，之后持续自动扫描，不等待 Chain 结束，不受原每轮 40 条详情核验限制。

- respect 默认 0–10000，包含边界，上限可留空；输入非负整数。
- 完整一轮结束后默认等 15 秒，再开始下一轮；可配置 5–3600 秒。
- 请求间隔默认 2 秒/账号，可配置 1–60 秒，支持小数。同一 Torn 账号与帮派筛选共享较慢的间隔，同账号多个 Key 不叠加额度。最多 10 个已授权 Public Keys，每行一个，留空保存保留原值，填写替换全部，重复自动去除，独立按钮删除全部。
- 所有页面状态每 5 秒从 Portal 读取，状态列表由服务器筛选和分页，每次只返回 50 个帮派，避免手机反复下载全量资料；服务器在关闭浏览器后继续运行，服务重启后需启动。配置保存会停止监控，再手动启动。

## 确认与防误报

保存每个存活帮派的 ID、名称、respect、Leader 和最后确认存活时间。若完整列表中未再看到已跟踪帮派，额外查询 `filters=id:=:{id}`，不附加 respect 或存活过滤条件。

只有返回同一 ID 且 `is_destroyed=true`，并已有存活基线，才记录“存活→摧毁”事件。返回存活但 respect 超出范围，则更新快照并退出范围；返回空、错误或无有效字段，只标记“待确认”，后续继续核验。列表缺页、重复、网络失败都不能据此推断摧毁，分页未完成不更新基线。后续分页仅取官方 next 链接的有效递增 offset，每页重建 respect/存活筛选与 limit，避免 API 分页链接丢失条件；分页期间已超范围或已摧毁的行跳过，不当作存活基线。已确认摧毁是永久状态，后续陈旧的存活 API 缓存不会使其复活。

首次已摧毁的帮派不会通知；两次轮询之间出现并被摧毁、未被观察到存活的帮派也不会通知。respect 筛选根据最近观察值：之前在范围外且直接被打至摧毁的帮派无法覆盖。应按需要扩大监控范围。

实际发现延迟包括 API 数据更新及缓存、整轮分页及补查耗时、账号限速和轮次等待。不能保证秒级或精确摧毁时刻。界面展示最后确认存活时间到发现摧毁时间的区间；API 查询时间不等于事件发生时间。

## 通知与记录

通知管理 → 业务提醒 → **帮派摧毁**，沿用原 QQ/Slack 开关和目标；不自动发送测试消息。通知包含帮派链接、最后存活快照中的 Leader profile、respect 前后值、最后存活时间和发现摧毁时间（通知使用 UTC ISO 时间，页面使用浏览器本地时间）。不伪造 Chain report，也不把摧毁归因于 Bonus。

摧毁事件及去重先在 SQLite 事务中保存再发送，最多保留 200 条记录，清空历史不清除去重。通知发送失败显示错误，事件保留且不自动重复发送；进程在提交后、发送前中断可能漏发，但重启不会重复推送。

## Key 与失败处理

沿用多账号归属核验、同账号备用 Key、账号共享限速及全局请求节流。Key 错误 1/2/10/13/16/18 或无法确认归属时跳过该 Key，状态只显示编号与原因。全部 Key 不可用才停止，重启重新检查，保存的 Keys 不删除。

错误 5/HTTP429 同 Key 同请求等待 65/130/260 秒，尊重更长 Retry-After；网络超时、HTTP408/5xx 等待 10/20/40 秒，最多三次重试。IP 封锁 8/9、日额度 14、重试耗尽停止。非致命列表或单帮派资料异常保留状态，在后续轮次继续；停止立即取消等待并释放配额设置。

## 存储、兼容与权限

新表 `torn_destruction_monitors` 存各 Portal user_id 的配置及历史，`torn_destruction_observations` 按 user_id/faction_id 保存观察与永久摧毁去重。使用幂等建表，不需要手工迁移。首次读取该用户的新配置时复制原 Chain Keys 和 API 请求间隔；原长度、Bonus、Leader 筛选不用于新监控，轮次间隔初始化为 15 秒。

原 `torn_chain_monitors`、`torn_chain_observations` 和旧冷却历史保留，不混入摧毁记录。通知继续使用 `torn_chain_notifications`。后续新监控配置独立保存，不覆盖旧 Chain 配置。旧运行时实现仅作为兼容测试保留，生产入口使用 DestructionMonitor。

保留权限 `torn-chain:view/config:edit/control:edit/history:edit`；通知使用 `torn-chain:notify:view/notify:edit/notify:test:edit`，权限名称和模块目录显示“监控”。游客仅可查看显式授权共享用户/团队的数据，服务器拒绝所有修改、启停、清空和通知配置操作。状态 API 不返回 apiKey/apiKeys，错误过滤全部 Keys；不隐式展示其他用户数据。

“帮派筛选”Tab 的配置、历史缓存、进度与权限独立，详见[帮派筛选说明](torn-faction-screener.md)。

依据：[官方 OpenAPI](https://www.torn.com/swagger/openapi.json) 的 faction/search、ApiFactionSearchFilter、FactionSearch；[官方帮派摧毁规则](https://wiki.torn.com/wiki/Faction#Faction_Destruction)。


用户出院监控已作为同页第三个 Tab 接入，使用独立权限、Keys、运行状态和通知设置。详见 [用户监控](torn-users-monitor.md)。
