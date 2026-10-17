# ECS 部署（navigation 仓库）

本仓库为 ECS 服务栈（portal / qq-bot / torn-toolbox / stock-manage / qqq-dip）。Torn 浏览器脚本在 [xiansakana-torn-scripts](https://github.com/xiansakana/xiansakana-torn-scripts)。

**ECS 路径：** `/opt/navigation`

行情服务连接策略与验收说明见 [quote-network-recovery.md](docs/quote-network-recovery.md)。仅 stock-manage、qqq-dip 启用该策略，部署后核对启动日志、采集请求审计和监控完成时间。

---

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

视频知识库随 Portal 部署，入口 `/knowledge/`，无新增公网端口。`scripts/sync-blog-upload-nginx.py` 同时维护其分片/工作器结果上传路由。Portal只接收文件和持久化队列；如需在ECS执行转写和总结，另行按 [工作器说明](docs/video-knowledge.md) 安装Python>=3.10、语音依赖和Codex CLI，使用该账号私有凭据启动 `knowledge-worker`。本机工作器也可处理同一站点任务。不要在常规Portal更新中自动安装模型或启动CPU密集任务；备份须额外包含 `portal/data/knowledge/` 的视频和截图。

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
