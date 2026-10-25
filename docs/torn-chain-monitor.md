# Torn 工具箱：Chain 监控

入口：`/torn-toolbox/` → Chain 监控，页面 `/torn-toolbox/chain/`。这是 navigation 的 Portal 内置模块，独立于浏览器用户脚本和原有压价/公司监听服务。

同页新增“帮派筛选”Tab：通过 faction/search 按 respect 升序扫描 Leader 的历史 networth、最后活动和入帮天数，配置两种跌幅及 A−B，按 C≥A 判断。配置和状态独立，详见[帮派筛选说明](torn-faction-screener.md)。两个功能按 Torn 游戏账号共享 Portal Torn API 限速队列；通过 key/info 核验归属，同账号不同 Key 不叠加额度，不同账号的队列可独立运行。

## 使用

1. 管理员分配 `torn-chain:view`，按需分配 `torn-chain:config:edit`、`torn-chain:control:edit`、`torn-chain:history:edit`。工具箱首页还需要原有工具箱访问权限；游客不可使用。
2. 保存 Torn Public API Key、长度上下限及轮次间隔。默认最小 100、最大不限、间隔 60 秒，范围包含边界，间隔最短 30 秒。留空 Key 保留已有值；删除 Key 使用独立按钮。
3. 点击启动。首次看见已冷却的 Chain 记录为“首次发现”；同次持续运行中核验到 Active → Cooldown 才记录为“刚进入冷却”。点击 report 链接手动打开报告。

每条记录显示“进入冷却（推算）”“发现于”和“冷却结束”三个时间，均为浏览器本地时区。“进入冷却”依据[官方每 hit 冷却 6 秒规则](https://wiki.torn.com/wiki/Chain)，从 API 冷却结束时间减去 Chain 长度 × 6 秒推算，并非轮询发现时间。新记录保存 `cooldownStartedAt`；旧记录读取时根据已有长度和结束时间补算，无需清空或额外请求。优先使用同 ID 列表的完整 Chain 长度；无效、结果晚于发现时间或不能可靠推算时显示“—”。API `end` 的语义未明确说明冷却开始时间，不直接作为该时间使用。

保存配置会停止运行；停止/重启会重新建立观察基线。关闭浏览器不会停止服务器监控；Portal 服务重启后需手动启动。报告由用户手动打开。

## 监控明细

“监控状态”保留汇总数字，并逐条显示当前候选帮派名称/ID、Chain ID/report 链接、长度、状态/计时、最近成功核验时间和具体说明。状态分为待核验、核验中、活动中、冷却中、已结束、核验失败、状态不明；可在页面按异常、待核验或各状态筛选。筛选只影响页面展示，不改变扫描或通知规则，沿用 `torn-chain:view` 权限。

成功核验后立即更新对应行；异常或错误 Chain ID 不沿用旧状态冒充本次成功。未核验的长度标为“列表值”，冷却复用标为缓存，40 条预算外显示等待轮换。活动计时为核验当时 API 返回的断链剩余秒数，冷却计时显示结束时间；时间均为浏览器本地时区。候选列表中明确低于最小长度的 Chain 在详情请求前过滤，不占每轮 40 条核验名额；汇总显示跳过数量。长度达到门槛（含等于）后会自动加入后续轮次；长度未知仍核验。此前已确认达到门槛的 Active Chain，即使列表长度突然缩小或消失，也保留跟踪冷却。最大长度仍在记录/通知阶段判断。官方列表接口不支持长度参数，不把 from/to 时间参数误用为长度。按开始时间升序读取（优先较早开始的 Chain），API 满100条却缺少 next 时按本页最大 start 构造包含边界的 from 游标续页，按 Chain ID 去重；避免默认降序首页 next 为空而误判读完。同时间戳满页无法继续或达到10页预算时明确显示列表不完整。失败行显示具体原因及最近尝试时间，历史成功结果只作为“上次确认”参考。

页面仍每 5 秒读取现有状态 API，不额外请求 Torn。若本轮列表读取失败，保留并标明上次明细，不把旧快照当成新结果。明细按当前登录账号隔离，错误文本过滤 Key。最近候选/失败明细只在监控进程中保留；成功观测的长度和核验时间复用 `torn_chain_observations` 保存，无需新表迁移。手机上按逐项卡片排列，避免表格撑宽。

## Bonus hit 被打玩家与 Leader 筛选

Chain 监控配置中可多选 13 个标准档位：10、25、50、100、250、500、1000、2500、5000、10000、25000、50000、100000。默认不选，不增加 report 请求。保存后重新启动监控，记录及通知附上所选且已达到档位的**被打玩家**链接 `https://www.torn.com/profiles.php?XID={defender_id}`；不使用出手玩家的 attacker_id。

身份筛选为“全部 / 仅 Leader / 排除 Leader”，默认全部。开启身份筛选需要至少选择一个档位，至少一名所选档位被打玩家符合身份条件，记录才显示、通知才投递，且只展示匹配玩家的链接。身份未知不会被当成非 Leader；无 faction 的玩家确认属于非 Leader。Co-leader 不属于 Leader。身份以 API 查询时的当前 faction 为准，缓存查询时间快照，不能还原攻击发生时的职位。

仅开启身份筛选时读取玩家公开 `profile.faction_id`，再读取该 faction 的 `basic.leader_id`，用数值 ID 对比，避免自定义职位名称误判。不缓存无关玩家资料。每轮最多核验 10 位不同玩家，同 faction 在本轮复用 Leader 查询，玩家核验成功结果最多复用 5 分钟；记录中已确认的身份作为历史快照保存。

每条符合范围的新冷却记录最多额外读取一次 report，缓存其有效 bonus defender ID。report ID/faction ID 必须匹配。暂不可用不伪造链接，最多尝试 3 次，相邻尝试至少 60 秒；未开启身份筛选时仍正常发送 report 链接，并标记被打玩家暂不可用。开启身份筛选后，未完成核验的通知延后；查询失败最多 3 次，未知不匹配，冷却已经结束的延后通知不补发。投递本身依旧不自动重试，避免重复。

兼容部分新结束 Chain 在 v2 report 返回错误 6（Incorrect ID）、官方 v1 却正常的情况：仅此错误时，在同一限速队列中额外请求 `https://api.torn.com/torn/{chainId}?selections=chainreport`，校验 v1 的 `factionID`、最终 `chain` 长度和 bonus 数据，再把 `bonuses[].defender` 转换为被打玩家 ID。凭据错误、限流和私有数据错误不触发兼容读取。记录保存 `bonusSource`（api-v1/api-v2）；旧版本已耗尽的 report 尝试次数在兼容读取版本中有一次新的有限重试周期，不重发历史通知。

QQ 和 Slack 的 Report、被打玩家标签与完整 HTTPS 网址分别独立成行，并显示被打玩家数字 ID，避免中文标点紧贴网址干扰客户端识别。QQ 是否转成蓝色可点击链接或预览卡片由客户端决定；已发送的旧消息不会自动改变。

旧记录在监控启动后每轮最多补查 5 条，补查本身不重发已发通知；未完成的延后通知在身份核验后投递一次。切换所选档位可立即使用已经缓存的 report 数据；尚未缓存的档位在后续轮次中补查。开启更多档位或身份核验会增加单轮耗时，所有请求仍按 Torn 账号共用 1.5 秒串行队列。

## 通知管理

进入 `/notifications/#chain-notifications` 的业务提醒区域，配置“Torn · Chain 冷却”。QQ 支持当前账号的独立群聊、@、私聊目标，Slack 复用通知管理的公共渠道。两种推送默认关闭，不继承其他用户或业务的目标。保存通知配置不影响扫描运行。

通知查看、保存、测试分别需要 `torn-chain:notify:view`、`torn-chain:notify:edit`、`torn-chain:notify:test:edit`；同时需要 Chain 主模块查看权限，进入通知管理还需原有通知服务权限。后台投递前复查账号及通知保存权限，撤销后不再投递。

新发现且仍在冷却、符合范围的 Chain 推送一次，包括首次扫描发现的冷却记录；超出范围、重复扫描、重启后的已见 Chain 不重复推送。开启 Leader 筛选时还需满足上述身份条件。报告先持久化再投递；失败不自动重试，以免部分投递后重复推送。Chain 页状态显示最近投递异常；下一次成功投递或重启监控清除该提示。测试按钮使用已经保存的配置。

Portal 通过通知服务的本机 `/notify` 接口、共享集成配置中的 `notifyToken` 投递，不暴露 Token 给浏览器。通知请求与测试均不得在开发验证时真实发送；自动测试使用 mock。

## API 与覆盖范围

只访问官方公开 API，不抓取游戏页面或调用游戏操作接口：

- `GET https://api.torn.com/v2/faction/warfarechains?cat=active&limit=100`，读取 `_metadata.links.next` 分页，最多 10 页。分页只允许官方域名和预期接口，不跟随 HTTP 跳转。
- `GET https://api.torn.com/v2/faction/{id}/chain`，必须与列表的 Chain ID 一致，再依据 `cooldown` Unix 秒时间戳和 `timeout` 核验状态。未知/失败结果保留原观察，不推测为已冷却。
- 选择 Bonus hit 后：`GET /v2/faction/{chainId}/chainreport`，只使用 `bonuses[].chain` 和 `bonuses[].defender_id`；根据[官方公开 API schema](https://www.torn.com/swagger/openapi.json)校验 report 身份。
- v2 错误 6 时的兼容读取：官方 v1 `GET /torn/{chainId}?selections=chainreport`；仅允许该选择，不允许任意 v1 API。参见[官方 API 说明](https://www.torn.com/api.html)。兼容请求与其他请求共用原有 1.5 秒间隔。
- 开启身份筛选后：`GET /v2/user/{id}/profile`、`GET /v2/faction/{id}/basic`，均使用 Public Key；仅比对 `profile.faction_id` 和 `basic.leader_id`，不访问游戏页面。
- 每轮最多核验 40 条，其余轮换；已确认且未到期的冷却记录不重复核验。近期从列表消失的已知活动 Chain 最多继续核验 10 分钟。

请求先通过 key/info 确认 Key 所属游戏账号，在 Portal 本进程按 Torn 账号共用串行队列，间隔至少 1.5 秒（每账号约 40 次/分钟，另有初次归属核验），不同账号可独立运行；全进程还限制请求启动间隔至少 100ms。轮次间隔从本轮结束计算，含排队时间，因此发现有延迟；多用户或大量候选时可能漏过短冷却。页面显示核验失败、待轮换和分页不完整状态。限流或失效 Key 会停止，修复后手动启动。其他 Torn 工具的请求仍共享 Torn 用户配额，本模块无法协调外部进程的用量。

官方参考：[API Playground](https://api-playground.torn.com/)、[API v2 更新讨论](https://www.torn.com/forums.php?a=0&b=0&f=63&p=threads&start=360&t=16401584)、[Chain 说明](https://wiki.torn.com/wiki/Chain)。`cat=active` 包含活动与冷却项；状态判断仍依赖详情核验。

## 数据与权限

`torn_chain_monitors` 在共享 SQLite 中按已认证 `user_id` 保存配置、最近 200 条报告（含 Bonus 缓存、身份快照、有限重试状态）和最近 5000 个去重 ID；`torn_chain_notifications` 按同一用户保存通知开关与目标。`torn_chain_observations` 保存近期活动 Chain 观察以便重启后继续核验，进程不会自动恢复运行。清空报告保留去重 ID。API Key 保存在服务器数据库中，状态 API 只回传 `hasKey`，不返回密钥。数据库备份需要按凭据保护。新增 Bonus/Leader 配置使用原有 JSON 字段，旧配置默认空选和全部，不需要表迁移。

页面、各操作 API 均检查 RBAC，写请求检查同源。后台每次请求前后复查运行权限，撤权或禁用账号后停止。报告名称使用文本节点渲染；链接固定为 `https://www.torn.com/war.php?step=chainreport&chainID={id}`，由用户手动打开。

## 验证与部署

- `node scripts/test.mjs portal`：Portal 全量测试，包含范围、基线/转换、去重、分页轮换、停止、用户隔离、Key 隐藏、权限和路由优先级。
- `node scripts/test-torn-chain-ui.cjs`：需 Playwright 和 Edge；本地模拟 API，阻断所有外部请求。检查工具箱及 Chain 页全宽切换/刷新持久化，390/320px 无溢出，权限和手动按钮。
- `node scripts/test-chain-notify-ui.cjs`：本机通过真实 Portal 代理外壳渲染通知管理卡片，验证目标保存/刷新、模拟测试、权限和 320/390px 布局。通知管理 1600px 下主体 1120→1600、导航栏 1440→1600；切回恢复，刷新保存状态。
- 通知管理渠道状态只在 `.channel-grid .channel-card` 中更新，Chain 推送开关使用独立 `data-chain-channel` 标记。回归测试和浏览器验证均覆盖 Chain 先于渠道配置返回的加载顺序，避免把复选框误当状态卡片而触发 `textContent` 空节点错误。
- 通知集成全量服务测试：`node scripts/test.mjs portal qq-bot`。线上 `scripts/verify-platform.mjs` 只读取 Chain 通知配置及通知管理 HTML，不投递消息、不启动扫描。
- 桌面 1600px 实测：工具箱主体 720→1600、Chain 主体 1100→1600、两页导航栏均 1440→1600；切回恢复原尺寸。

通知集成版本部署 `portal,qq-bot`，无新增进程或公网端口。首次授权访问自动创建表；备份共享数据库时包含 `torn_chain_monitors` 和 `torn_chain_notifications`。按仓库 Git/SHA 部署流程运行 `scripts/ecs-update.sh --expected-sha <sha> --only portal,qq-bot`，部署本身不会启动扫描或打开通知开关。
