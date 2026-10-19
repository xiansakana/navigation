# Navigation 平台整理与运维

保留单机多进程部署。Portal 管理身份、入口、业务 API 和代理；业务实现通过共享包复用，执行任务不依赖 QQ 通知进程是否运行。

## 模块接入

`portal/src/modules.js` 是内置模块目录，声明菜单、权限入口、API 归属、运行服务与可公开给资源管理员的任务统计。`module-api.js` 装配处理函数，`router.js` 从目录派生命名空间；博客保留原有逐方法的路由匹配，未知接口不进入代理。

新增模块时添加目录和处理器，仍须明确注册每项 RBAC 权限并在页面、API、数据所有权处执行。`modules.test.js` 校验目录、菜单、命名空间和派发是否一致。普通成员默认能力采用固定允许列表，新权限不会因同名前缀自动授权。

资源页区分“已注册”、任务状态和工作器心跳；进程在线不等于业务健康。共用 Portal 的模块不能单独归因 CPU/内存。远端知识库设备当前只显示在线数，不声称已采集远端资源。

## 运行与配置

- `portal`：Web、鉴权、业务 API、代理；`/healthz` 存活、`/readyz` 验证数据库可访问。
- `portal-background`：博客视频恢复/处理、缩略图、媒体清理和资产历史。只有 `runtime.externalWorkers=true` 时从 Web 移出这些任务。
- `codex-worker`：执行持久化 Codex/Todo 队列；QQ 消息接收、回复投递保留在 `qq-bot`。停止通知进程不会停止 Web 任务执行。
- `shared/codex`：业务存储、CLI 客户端、执行、调度和状态；`shared/auth`：无 Portal 依赖的权限判断。旧 QQ 源码路径只保留兼容入口/渠道格式化。
- `data/codex.json`：私有执行配置，支持 `NAVIGATION_CODEX_CONFIG` 显式路径。
- `data/integrations.json`：私有行情/通知集成凭据，支持 `NAVIGATION_INTEGRATIONS_CONFIG`。日常运行不再从兄弟服务源码提取密钥。

后台执行器应只启动一份；不要直接把 PM2 实例数增加到多个。视频任务仍有进程内串行控制，尚未改造成支持多实例领取的通用分布式队列。

RBAC 快照新增 `revision`，更新采用比较版本的事务；缓存读取数据库版本并返回独立对象。冲突须刷新重试。现有 SQL 更新工具由触发器提升版本；新工具应调用 `saveRbacBlob`，禁止绕过协议整份覆盖。其他业务表保持既有迁移方式，后续迁移可逐域整理。

## 登录与代理

生产 `auth.sessionSecret` 必须独立随机、至少32字符，不能使用示例值或密码。登录仅验证数据库密码，禁用账号不能登录。Cookie 包括 HttpOnly、SameSite=Lax，生产设置 `auth.secureCookies=true`；本地 HTTP 开发需显式保持 false。密钥轮换会要求重新登录。

登录失败按账号和来源限速并短期退避；内存桶有数量及过期限制。只有 `auth.trustedProxies` 列出的直接代理地址可提供转发 IP，默认不信任外部头。它是当前单实例保护，不是跨节点限流。

浏览器写接口复用 `shared/http.js`，内部 Token 接口、OAuth 回调、本机直送握手保留各自协议。代理上传使用背压流式转发，仅发布站 loadPetals 小型 JSON 限量缓冲改写；响应现有改写限32MiB。透传响应保留 CSP，注入 HTML 的策略需要后续按上游分开治理；尚未声称全站 CSP 已落实。

请求日志仅记录随机请求 ID、方法、API 命名空间、状态和耗时，不记录查询参数、Cookie、Token、用户标识或正文。

## 115备份与恢复

执行 `node scripts/configure-backup115.mjs` 可从唯一已绑定的知识库115账号创建私有 `data/backup115.json`。多个账号时必须在此文件明确指定备份账号；备份独立目录为 `/115/Navigation-Backups`，不删除知识库对象。

执行 `bash scripts/backup-navigation-115.sh`：

1. 先重试以前失败留下的临时包；成功后本轮结束，避免立即重复导出大库。
2. 以只读事务生成一致的 SQLite 逻辑导出并压缩。对于空间足够的小库，`backup-navigation.py` 默认在线备份 API 生成二进制快照；空间不足会预检拒绝。
3. 打包运行数据、本地知识库材料、配置；以 SHA256 清单校验文件。其他实际 SQLite 文件也使用在线快照，扩展名为 `.db` 的 JSON 按普通文件保存。
4. 使用 AES-256-GCM 流式加密，按16MiB分片上传115，最多同时处理两片。逐片完整下载比对大小和 SHA256，已验证分片可续传；最后写入恢复清单。
5. 校验成功才删除临时压缩包；保留上传收据，失败则留包重试。

115避免长期占用 ECS 容量，但逻辑导出、压缩和上传仍有临时磁盘、有限内存和 IO 开销。逻辑导出每万条检查余量，低于512MiB会停止。备份锁防止任务重叠。数据库快照是一致的；可变文件跨备份时间段采集，外部115视频和B2对象仍需保留原有存储，不能把此包称为所有外部对象的独立副本。

恢复密钥：`/opt/backups/navigation/.encryption-key`，权限600，必须另存到可信异机。它不在115加密包中；遗失后无法解密。目录700，临时包和收据600，备份可能包含全部用户的私有数据。

恢复演练在有足够磁盘的独立目录执行：

```bash
# 下载过程只把密文写入指定文件，不输出存储管理令牌或签名 URL。
node scripts/backup-115.mjs download /opt/backups/navigation/<archive>.115.json > backup.enc
node scripts/backup-115.mjs decrypt backup.enc backup.tar.gz /secure/location/.encryption-key
python3 scripts/backup-navigation.py --verify backup.tar.gz
```

`--verify` 完整校验归档内文件，恢复 SQLite 并执行 integrity_check/foreign_key_check；需要容纳解压数据库的磁盘。正式恢复前停止所有写进程，保留现有数据，恢复到新目录核对业务后再切换，不自动覆盖运行中的数据库。

`bash scripts/install-navigation-backup.sh` 首次成功备份后安装每12小时任务。已单独完成上传和恢复验证时，可传入 `--verified-receipt /opt/backups/navigation/<archive>.115.json` 复用12小时内的成功收据。云端暂不自动删除历史备份，避免在未确定恢复保留需求时删除唯一副本；定期检查网盘容量、收据、失败日志与异机恢复。日志失败写 syslog；尚未配置用户的外部告警投递。

## 首次切换与日常部署

首次切换必须先取得加密云备份并异机恢复验证，确认数据库管理员账号能用原密码登录；不得直接删除密码回退后再检查。

`migrate-platform-runtime.mjs` 支持默认只检查和 `--apply`。它拒绝在 Codex/媒体任务运行时切换，拒绝数据库密码与配置密码不一致，迁移私有配置且不打印凭据。`ecs-update.sh` 首次迁移会备份，再执行配置迁移；之后按 SHA 校验和选定服务更新，并启动独立执行器、校验资源权限与模块目录。不要中断正在进行的知识库外部工作器。

共享库改动影响 Portal、qq-bot、stock-manage 和 qqq-dip；部署包含这些使用方。执行器改动还需要更新 portal-background 和 codex-worker。

## 验证

根目录 `npm test` 自动发现五个服务和 shared 内的 `*.test.js`；每个服务的 npm test 使用同一入口，统一工作目录，避免漏登记测试文件。测试需 Node22（现有测试使用 node:sqlite），原生 better-sqlite3 ABI 必须匹配；生产应用仍可使用受支持的 Node20.19+。

```bash
npm test
python3 -m unittest discover -s scripts -p test_backup_navigation.py
python3 -m unittest discover -s portal/workers -p 'test_*.py'
```

GitHub Actions 安装各服务锁定依赖并执行这些检查。工作流提供测试结果，分支保护和“CI成功才能部署”的远程规则仍需单独配置，不能仅凭有工作流宣称已启用强制门禁。

本轮不迁移 PostgreSQL、不引入消息中间件、不更换 HTTP 框架、不一次迁移 workspaces。后续先量化写锁等待、任务积压和慢请求，再决定是否需要这些变动。
