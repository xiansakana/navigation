# 通知管理服务

集中管理 QQ、邮件和 Slack 通知渠道。QQ 通过 [NapCat](https://napneko.github.io/) 发送私聊/群消息，邮件通过 SMTP 发送，Slack 通过 Incoming Webhook 发送到指定频道，并在每条 Slack 消息中提醒该频道所有成员（`@channel`）。Portal 首页的“通知管理”卡片可进入配置页面。

内置 Tibo 重置机会监听：合并公开 feed 与 RSS，逐条检查 `@thsottiaux` 的新推文，对“可能重置、已预告、已确认”的 Codex 额度信号按所选渠道发送通知。首次启用只建立当前推文基线，不补发历史消息。

股票管理抄底提醒、Torn 压价提醒和公司申请提醒的规则、渠道开关、目标与测试由本服务统一管理。原服务只保留市场/Torn 监控和事件发现，并通过经 Bearer Token 鉴权的本机 `/api/business-events` 上报事件；QQ、Slack 和桌面投递均由本服务决定。已有配置首次读取时按业务分别导入本服务的 `config.json`，之后不再回写原服务。Slack 按业务单独启用，Torn 还可按监听账号启用；默认关闭。

部署顺序：先在 ECS 运行 `node scripts/check-business-migration.mjs` 检查三个监控进程的本机上报地址与 Token，再更新通知管理服务并确认三个业务卡片均已成功导入原有配置，最后重启股票与 Torn 监控。请勿提交包含业务目标与密钥的运行时 `config.json`；原监控服务中的推送地址和 Token 仅用于上报事件，其通知设置接口已改为只读/停用。

## 目录结构

```
qq-bot/
  config.example.json   # 配置模板
  config.json           # 本地配置（勿提交）
  src/
    napcat.js           # NapCat HTTP 客户端
    email.js            # SMTP 邮件客户端
    slack.js            # Slack Incoming Webhook 客户端
    send-test.js        # 命令行测试发送
    business.js         # 业务提醒规则、旧配置导入和统一投递
    server.js           # 管理页面、配置 API 与统一通知 API
  public/               # 通知管理页面
```

## 1. 安装 NapCat

1. 按官方文档安装并登录 NapCat：https://napneko.github.io/guide/start-install
2. 在 NapCat 网络配置中 **启用 HTTP 服务**（默认端口常为 `3000`）
3. 若设置了 `access_token`，填入 `config.json` 的 `napcat.accessToken`

HTTP 请求格式参考：[NapCat OneBot API](https://napneko.github.io/onebot/api)

## 2. 配置本项目

```bash
cd qq-bot
copy config.example.json config.json
```

编辑 `config.json`：

| 字段 | 说明 |
|------|------|
| `napcat.baseUrl` | NapCat HTTP 地址，本机一般为 `http://127.0.0.1:3000` |
| `napcat.accessToken` | NapCat 鉴权 token（未设置则留空） |
| `defaultTarget.userId` | 默认接收私聊的 QQ 号（可先填自己的） |
| `channels.qq.enabled` | 是否启用 QQ 渠道 |
| `channels.email` | 邮件启停、默认收发件人与 SMTP 配置 |
| `channels.slack` | Slack 启停与 Incoming Webhook URL；URL 是密钥，勿提交或分享 |
| `monitors.tiboReset.enabled` | 是否启用 Tibo 重置机会监听 |
| `monitors.tiboReset.intervalMinutes` | 拉取间隔；数据源自身可能约 15 分钟更新 |
| `monitors.tiboReset.channels` | 命中后发送的渠道，支持 `qq`、`email`、`slack`，默认仅 QQ |
| `server.port` | 本地推送服务端口，默认 `8787` |
| `server.notifyToken` | 调用 `/notify` 时的 Bearer Token |

## 3. 测试发送

确保 NapCat 已登录且 HTTP 已开启：

```bash
npm run test:send
```

自定义消息与接收人：

```bash
node src/send-test.js --user 123456789 "Poison Mistletoe 被压价了"
node src/send-test.js --group 987654321 "群通知测试"
```

## 4. 启动通知管理服务

启动后可直接打开 `http://127.0.0.1:8787/`，或通过 Portal 的 `/notifications/` 访问：

```bash
npm start
```

```bash
curl -X POST http://127.0.0.1:8787/notify ^
  -H "Authorization: Bearer change-me-to-a-long-random-string" ^
  -H "Content-Type: application/json" ^
  -d "{\"message\":\"测试推送\"}"
```

指定渠道或同时发送多个渠道：

```json
{ "channel": "email", "subject": "测试", "message": "邮件正文" }
{ "channel": "slack", "message": "Slack 通知" }
{ "channels": ["qq", "email", "slack"], "message": "同时发送" }
```

## 5. 迁移到云服务器

1. 在云服务器安装 NapCat 并保持 QQ 在线
2. 将 `qq-bot` 目录上传并执行 `npm install`（Node 18+）
3. `config.json` 中：
   - `napcat.baseUrl` 改为 `http://127.0.0.1:3000`（Bot 与 NapCat 同机）
   - `server.host` 保持 `127.0.0.1`，由 Portal 统一反向代理
   - 设置强随机 `notifyToken`，不对公网开放 8787 端口
4. 使用 `pm2` / `systemd` 保持 `node src/server.js` 运行

后续业务迁移时可在服务器内网调用 `http://127.0.0.1:8787/notify`，无需直连 NapCat。

## 掉线与自动登录

QQ 协议不能在腾讯要求扫码时完全无人值守。能做的是：

1. **持久化登录态**：`./ntqq` 挂载到容器 `/app/.config/QQ`（已配置）
2. **固定 MAC**：`docker-compose` 里 `mac_address`，减少被当成新设备
3. **账号密码自动登录**：在 `/opt/napcat/.env` 写 `ACCOUNT` 和 `NAPCAT_QUICK_PASSWORD`（不要提交 git）。启动/重启时会走密码登录；若腾讯要求新设备验证，仍需扫一次码。
4. **掉线看门狗**：`config.json` 里 `napcat.watchdog.enabled=true` 后，qq-bot 会轮询在线状态，连续掉线则 `docker restart napcat`，再次走快速/密码登录

若腾讯弹出「新设备验证」二维码，仍需打开 Portal 的 NapCat WebUI 扫一次。

## 注意

- NapCat 使用非官方协议，存在账号风险，请自行评估
- 不要将 `config.json` 提交到公开仓库
