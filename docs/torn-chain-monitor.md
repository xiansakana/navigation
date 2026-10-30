# Torn 工具箱：监控

入口 `/torn-toolbox/` → **监控**，页面 `/torn-toolbox/chain/`。包含“帮派摧毁监控”“帮派筛选”和“用户监控”三个 Tab。原 Chain 冷却监控已被帮派摧毁监控替换，不再调用 warfarechains、Chain 详情或 report；路由、权限 ID `torn-chain:*` 和已有数据范围授权保持兼容。

## 帮派摧毁监控

使用官方 `/v2/faction/search`，Public Key 即可。完整分页读取 `notDestroyed` 和 respect 范围内的存活帮派，按 respect 升序显示。首次扫描建立存活基线，之后持续自动扫描，不等待 Chain 结束，不受原每轮 40 条详情核验限制。

- respect 默认 0–10000，包含边界，上限可留空；输入非负整数。
- 完整一轮结束后默认等 15 秒，再开始下一轮；可配置 5–3600 秒。
- 请求间隔默认 2 秒/账号，可配置 1–60 秒，支持小数。同一 Torn 账号与帮派筛选共享较慢的间隔，同账号多个 Key 不叠加额度。最多 10 个已授权 Public Keys，每行一个，留空保存保留原值，填写替换全部，重复自动去除，独立按钮删除全部。
- 所有页面状态每 5 秒从 Portal 读取，状态列表由服务器筛选和分页，每次只返回 50 个帮派，避免手机反复下载全量资料；服务器在关闭浏览器后继续运行，服务重启后恢复原有运行意图。配置保存会停止监控，再手动启动。

## 确认与防误报

保存每个存活帮派的 ID、名称、respect、Leader 和最后确认存活时间。若完整列表中未再看到已跟踪帮派，额外查询 `filters=id:=:{id}`，不附加 respect 或存活过滤条件。

已跟踪的存活帮派只要 API 明确返回 respect=0，立即记录 `respect-zero` 并推送，不要求 is_destroyed=true。在列表分页中读到清零即可处理，不等待剩余分页完成。其他存活基线仍在完整分页成功后更新；缺页/错误/重复不能作为清零或摧毁的证据，但不撤销已经取得的明确零值证据。按 ID 补查亦适用：之前在范围内、现已跌到下限以下的零值也会触发。

后续同帮派 is_destroyed=true 时只在原清零记录补充 destroyedConfirmedAt，不再发第二条通知。旧的直接摧毁记录继续保留展示。首次发现已经为 0 或已摧毁的帮派只建立基线，不批量通知；升级前已经跟踪的存活零值、且尚无 zeroHandled 标记，下次成功核验零值会提醒一次。没有存活基线的新帮派不会因第一次已摧毁而提醒。

zeroHandled 标记按 Portal 用户与帮派永久保存，清空记录、重启和正数缓存回跳不会清掉。每个帮派清零最多提醒一次；已确认摧毁状态同样不可逆。已清零但未标记摧毁的帮派仍持续核验，直到确认摧毁；即使 respect=0 已低于所设下限，也保留在状态列表和补查中。配置 Keys、范围及原通知目标不迁移或清空。

实际延迟仍有 API 数据更新/缓存、扫描周期、分页位置和账号限速；只是消除了等待 Torn 标记摧毁及发现零值后等待整轮结束的时间。发现清零时间不等于精确归零时刻。此前不在监控范围、且直接降为零的帮派无法覆盖，需扩大范围。

## 通知与记录

通知管理 → 业务提醒 → **帮派清零 / 摧毁**，沿用原 QQ/Slack 开关和目标；不自动发送测试消息。通知包含帮派链接、最后存活快照中的 Leader profile、respect 前后值、最后存活时间和发现清零/摧毁时间（通知使用 UTC ISO 时间，页面使用浏览器本地时间）。不伪造 Chain report，也不把摧毁归因于 Bonus。

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
