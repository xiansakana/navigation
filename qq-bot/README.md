# Torn QQ Bot（NapCat）

通过 [NapCat](https://napneko.github.io/) 发送 QQ 私聊/群消息。本地跑通后，可将同一套代码部署到云服务器，供 Torn 工具箱等脚本远程调用。

## 目录结构

```
qq-bot/
  config.example.json   # 配置模板
  config.json           # 本地配置（勿提交）
  src/
    napcat.js           # NapCat HTTP 客户端
    send-test.js        # 命令行测试发送
    server.js           # HTTP 推送服务（日后对接工具箱）
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

## 4. 启动 HTTP 推送服务（可选）

供浏览器脚本或其他程序 POST 消息，**尚未接入 Torn 工具箱**：

```bash
npm start
```

```bash
curl -X POST http://127.0.0.1:8787/notify ^
  -H "Authorization: Bearer change-me-to-a-long-random-string" ^
  -H "Content-Type: application/json" ^
  -d "{\"message\":\"测试推送\"}"
```

## 5. 迁移到云服务器

1. 在云服务器安装 NapCat 并保持 QQ 在线
2. 将 `qq-bot` 目录上传，`npm` 无需额外依赖（Node 18+）
3. `config.json` 中：
   - `napcat.baseUrl` 改为 `http://127.0.0.1:3000`（Bot 与 NapCat 同机）
   - `server.host` 改为 `0.0.0.0` 以便外网访问
   - 设置强随机 `notifyToken`，云防火墙仅开放必要端口
4. 使用 `pm2` / `systemd` 保持 `node src/server.js` 运行

日后 Torn 工具箱只需向 `https://你的域名/notify` 发 POST，无需直连 NapCat。

## 注意

- NapCat 使用非官方协议，存在账号风险，请自行评估
- 不要将 `config.json` 提交到公开仓库
