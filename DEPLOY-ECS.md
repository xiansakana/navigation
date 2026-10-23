# ECS 部署（navigation 仓库）

本仓库为 ECS 服务栈（portal / qq-bot / torn-toolbox / stock-manage / qqq-dip）。Torn 浏览器脚本在 [xiansakana-torn-scripts](https://github.com/xiansakana/xiansakana-torn-scripts)。

**ECS 路径：** `/opt/navigation`

行情服务连接策略与验收说明见 [quote-network-recovery.md](docs/quote-network-recovery.md)。仅 stock-manage、qqq-dip 启用该策略，部署后核对启动日志、采集请求审计和监控完成时间。

---

平台模块目录、独立执行器、115加密备份、认证迁移与恢复验证见 [平台架构与运维](docs/platform-architecture.md)。首次执行新版本更新脚本会先备份，再迁移运行配置。

## 一、本地开发（主流程）

在本地仓库编辑与测试。开始前检查并分类已有改动，只提交本次任务文件；交付时不得遗留本次任务的暂存或未提交修改。

```bash
git status --short
git diff --check
git add <本次变更的文件>
git commit -m "feat: 描述"
git rev-parse HEAD
```

## 二、推送并由 ECS 拉取部署

优先从本机把提交推送到 GitHub `origin/main`。若本机 GitHub TLS/SSH 不可用，可通过 SSH 将**提交对象**推到 ECS 的非检出分支 `refs/heads/codex-incoming`，然后由 ECS 推送 GitHub `main`；ECS 工作树仍需随后从 GitHub 拉取，不能直接改文件。中转前核对两端 Git 状态和快进关系；任何校验失败就停止。

```bash
# 本机：直连 GitHub 成功时仅需 git push origin main；失败时使用 ECS 中转
git push <ECS-SSH-Git-URL> HEAD:refs/heads/codex-incoming
# ECS：确认 codex-incoming 的 SHA 与本地一致，且 main 工作树干净
git push origin refs/heads/codex-incoming:refs/heads/main
cd /opt/navigation
./scripts/ecs-update.sh --expected-sha <本地提交SHA> --only portal
```

`config.json` 已在各服务 `.gitignore` 中，不会上传密钥。

---

## 三、ECS 首次部署

```bash
cd /opt
git clone git@github.com:xiansakana/navigation.git
cd navigation
```

按顺序配置并 `./deploy-ecs.sh`：`qq-bot` → `torn-toolbox-desktop` → `stock-manage` → `qqq-dip` → `portal`。

详见各目录内 `config.ecs.example.json`。

### 从旧仓库 xiansakana-torn-scripts 迁移

若 ECS 上已有 `/opt/xiansakana-torn-scripts`：

```bash
cd /opt/navigation   # 克隆完成后
bash scripts/migrate-ecs-from-torn-scripts.sh
```

---

## 四、日常更新

正常情况下在本机提交、推送，再让 ECS 拉取并部署：

```bash
cd /opt/navigation
./scripts/ecs-update.sh --expected-sha <本地提交SHA> --only portal
```

将 `portal` 换成实际受影响服务列表；共享代码变更应包含所有受影响服务。脚本会核对部署提交与传入的 SHA 一致。只有已提交的代码可以声明与生产一致。

如需在 ECS 交互式执行：

```bash
cd /opt/navigation
./scripts/ecs-update.sh --expected-sha <已推送的提交哈希> --only portal
```

按需指定服务：

```bash
./scripts/ecs-update.sh --expected-sha <已推送的提交哈希> --only undercut
./scripts/ecs-update.sh --expected-sha <已推送的提交哈希> --only company,qq-bot,portal
```

若 push、pull、工作区检查或提交校验失败，停止部署并检查差异；不要自动改用 SCP、`--skip-pull`、`git reset` 或覆盖服务器文件。`scripts/ecs-deploy-from-local.ps1` 仅保留作经用户明确授权的紧急例外，不能保证 Git 提交一致性。

---

## 五、Deploy Key（ECS 推送 GitHub）

```bash
# ~/.ssh/config 见 xiansakana-torn-scripts 文档或旧 DEPLOY-ECS 第四节
cd /opt/navigation
git remote set-url origin git@github.com:xiansakana/navigation.git
```

Deploy Key 需加到 **navigation** 仓库（可与 torn-scripts 共用同一密钥，两个仓库都加 deploy key）。

---

## 六、添加非 Torn 服务

Chain 监控是 Portal 内置的 Torn 工具箱子模块，入口 `/torn-toolbox/chain/`；通知管理集成更新 `portal,qq-bot`。首次访问自动建立按用户隔离的 `torn_chain_monitors`、`torn_chain_notifications` 表；备份包含两表并按凭据保护其中的 API Key。新增权限和操作说明见 [Chain 监控](docs/torn-chain-monitor.md)。部署后不自动启动扫描或打开通知开关。

Bonus hit 多选、被打玩家 profile 链接及 Leader 筛选同样更新 `portal,qq-bot`。配置和查询快照存入原有按用户隔离的 JSON，无需新表迁移；默认空选/全部，不增加 API 查询。只有用户保存配置并启动监控后才补查 report 和身份；开发及上线验证不得真实发送测试通知。

视频知识库随 Portal 部署，入口 `/knowledge/`，无新增公网端口。`scripts/sync-blog-upload-nginx.py` 同时维护其分片/工作器结果上传路由。Portal只接收文件和持久化队列；如需在ECS执行转写和总结，另行按 [工作器说明](docs/video-knowledge.md) 安装Python>=3.10、语音依赖和Codex CLI，使用该账号私有凭据启动 `knowledge-worker`。本机工作器也可处理同一站点任务。不要在常规Portal更新中自动安装模型或启动CPU密集任务；备份须额外包含 `portal/data/knowledge/` 的视频和截图。

B站链接导入随Portal进程运行，需现有FFmpeg（可设`KNOWLEDGE_IMPORT_FFMPEG`），不依赖yt-dlp或Python下载器。自动新增`knowledge_imports`表；备份该表和原有知识库数据。一次只下载所选单个分P，1GB/4小时上限，权限为`knowledge:import:edit`并需上传/生成笔记权限。下载完成后GPU处理和115归档并行；无须更新本机工作器。部署仍只更新`portal`。

视频分阶段并发自动新增 `knowledge_documents.processing_phase` 和 `knowledge_settings.pipeline_json`；无需重建队列。默认每台设备转写1路、总结2路，可在知识库处理设置中调整。Portal部署后，Windows工作器通过原有空闲自动更新取得新运行包；ECS工作器需使用 `python3 scripts/reload-knowledge-worker-when-idle.py --wait-and-restart` 单独空闲重载，不能直接中断活跃转写。新版服务兼容旧工作器（每台单任务），阶段交接仍保留原租约、原始材料和用户隔离。

上传队列随Portal部署，自动新增 `knowledge_upload_queue` 表与账号/状态索引；备份需包含该表。批量B站链接每批100条、等待/失败上限500条；后台导入循环只在账号活跃任务不足5个时提升下一条，不提高下载或转写并发。元数据解析使用两分钟租约，服务重启后可回收过期解析，处理权限再次核验。本地多文件排队在浏览器内存中进行，页面需保持打开。无需升级GPU工作器、改变代理或增加公网端口。

B站扫码与画质更新仍只部署`portal`，安装Node依赖qrcode并使用FFprobe核实实际宽高（可设`KNOWLEDGE_IMPORT_FFPROBE`）。新增`knowledge_bilibili_accounts`及导入表`settings_json/media_json`字段；首次绑定生成0600权限的`portal/data/knowledge-bilibili.key`（可设`KNOWLEDGE_BILIBILI_KEY_FILE`）。备份账号表时同时备份并单独保护该密钥；不得提交Git。新导入默认1080p严格模式，旧导入快照保留自动降级；网页登录后扫码确认即可，无需迁移浏览器Cookie或升级GPU工作器。

在 `portal/config.json` 的 `services` 增加卡片；新服务放在本仓库根目录（与 `qq-bot` 平级），独立端口 + pm2，仅 portal :80 对外。

---

## 七、访问

```
http://<ECS公网IP>/
```

安全组只需放行 **80**；8790 / 8791 / 8787 / 6099 绑定 `127.0.0.1`。
# QQ 指令记账接收

更新 portal 和 qq-bot 的同一目标提交后，执行 `node scripts/configure-qq-bookkeeping.mjs` 配置私有运行时文件，保留已有 HTTP 发送接口，新增 Token 鉴权的 NapCat WebSocket3001、array 消息格式和 qq-bot 接收开关。脚本不会绑定任何用户或发送通知，原配置备份在 `qq-bot/data/bookkeeping/` 和 NapCat 配置目录。重启 NapCat 与 qq-bot 后检查本机8787 `/health` 的 `bookkeeping.connected=true` 及原 QQ 在线状态；3001 仅通过现有 Docker `127.0.0.1` 映射访问，不开放公网端口。Portal 内部记账端点仅允许本机与通知服务 Token。

## 记账资产历史与证券估值

Portal 每天北京时间 23:59 自动采集一次绑定证券账户用户的总资产；在当天 23:59 后启动会检查并补采尚未保存的当日快照。查看页面仅初始化历史反推基准，不写入或覆盖估值快照，当前资产仍读取最新估值。首次采集将切换日前的账单与余额调整反推曲线冻结到共享 SQLite 的 bookkeeping_asset_baselines；之后按采集时账户范围、现金及最新可用证券行情，将每日定时采集的完整 CNY 估值保存在 bookkeeping_asset_snapshots（均按 user_id 隔离）。无需额外任务或配置，部署 portal 即生效；SQLite 备份需包含这两张表。行情或汇率不完整时不写入部分估值，空缺日沿用上次观测并在页面说明；旧日期不使用新报价重算。切换日口径差额不认定为投资收益。


### QQ Codex 移动入口

新增入口时只部署 `portal,qq-bot`，并按 [QQ Codex](docs/qq-codex.md) 在服务器私有配置中绑定所有者、QQ与项目。代码开发使用 `/var/lib/qq-codex/projects/` 下的独立Git检出，生产 `/opt/navigation` 保持原有部署流程。`AGENTS.md` 随Git同步；不复制CLI会话或登录凭据到仓库。

Codex CLI 管理模块及QQ模型/强度设置也更新 `portal,qq-bot`，入口 `/codex-cli/`，无需新增进程或公网端口。两个服务必须使用同一服务器账号与 `CODEX_HOME`，复用qq-bot私有配置的CLI路径和代理；网页只读白名单字段，默认模型/强度通过官方App Server原子写入该服务器账号的Codex用户配置。备份此次涉及的 `qq_codex_*` 表及服务器私有Codex配置；不必为了此次迁移复制整个共享行情数据库。启动时自动新增QQ会话模型偏好表和任务运行设置字段；既有会话、群设置及附件保留。新模块权限由Portal注册，不向普通用户或游客自动开放。

会话工作台同样部署 `portal,qq-bot`。迁移自动新增 `codex_conversations`、`codex_job_progress` 以及任务 `origin`、`conversation_id` 字段；备份范围需包含这两张表（如已存在）和 `qq_codex_*`、`rbac_snapshot`。工作台仅导入当前用户在本应用中已有的 QQ 任务历史，不枚举服务器全部 CLI 会话。项目或群授权撤销后立即停止展示与续接，执行中也会重新校验权限。网页与 QQ 共用串行队列，但网页任务不写 QQ 回执，也不覆盖 QQ 当前会话。QQ 开关关闭时，已授权的网页执行仍可运行；Codex 总开关会同时暂停两个入口。

工作台支持新建、续聊、模型/强度选择、查看执行记录、停止、重命名和归档；消息、任务状态及进度存入共享 SQLite，页面每3秒读取最新状态，关闭页面不终止后台任务。发送请求使用唯一请求标识避免网络重试重复执行。`codex-cli:sessions:view/create/manage`、`codex-cli:messages:send`、`codex-cli:tasks:stop` 分别控制相关界面与 API，执行仍需私有项目授权及 `qq-codex:execute`。前端模型选择仅作用于本次发送，不改服务器或 QQ 默认配置。

Todo 待办更新 `portal,qq-bot`，新增 `codex_todos` 表及任务 `todo_id`、`failure_kind` 字段；迁移前备份此表（如已有）、`qq_codex_*`、`codex_conversations`、`codex_job_progress`、`rbac_snapshot`，无需备份整个行情数据库。Todo 数据按 Portal 用户归属，权限为 `codex-cli:todos:view/edit/run/order/stop`；自动执行还需该用户已配置项目和会话查看、新建、发送权限。保存自动待办即授权后续执行，未勾选则仅保存为暂停状态；请求标识防止网络重试重复建立自动任务。

调度由 qq-bot 内部队列工作器处理，关闭浏览器不影响运行。手动任务优先，共享项目仍全局串行；Todo 按用户设置的顺序执行。普通 Codex 额度耗尽或额度信息不可用时不提交 CLI 任务，在服务器给出的重置时间附近复核实际余额（1—5分钟间隔）；不自动切换 Reserve 模型、消费重置积分或购买额度。明确额度错误且可安全续接时等待后恢复原会话；一般失败及服务重启中断不自动重做，并阻止该用户后续待办，需手动重试或暂停并跳过。暂停、删除、排序、编辑和关联会话均校验所有权；执行期间持续检查账号、项目、群聊和自动执行权限。只改模型默认设置不会改已进入队列的运行快照。
