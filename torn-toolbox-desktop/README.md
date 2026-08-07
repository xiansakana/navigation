# Torn 工具箱 Desktop

无需浏览器、无需 Tampermonkey，在本地运行 Torn 工具箱的监听功能。启动后自动打开图形化 Web 界面。

## 功能

- **压价助手**：监听 Bazaar + Item Market，桌面通知 + QQ 群通知
- **公司监听**：新公司申请提醒

浏览器版 [torn-toolbox](../torn-toolbox/torn-toolbox.js) 保持不变，仍使用浏览器通知。

## 前置条件

1. **Node.js 18+**
2. **Torn API Key**（需相应权限）
3. （可选）本地运行 [qq-bot](../qq-bot/) 以接收 QQ 群通知

## 快速开始

```bash
cd torn-toolbox-desktop
copy config.example.json config.json
npm install
npm start
```

启动后会自动打开 `http://127.0.0.1:8790`。在界面中填写 API Key、保存设置，即可开始监听。

## 配置说明

| 字段 | 说明 |
|------|------|
| `tornApiKey` | Torn API Key |
| `server.port` | 本地 UI 端口，默认 `8790` |
| `server.openBrowser` | 启动时是否自动打开浏览器 |
| `undercut.*` | 压价助手：间隔、监听范围、指定物品 |
| `company.intervalSeconds` | 公司监听间隔 |
| `notify.desktop` | Windows/macOS 桌面通知 |
| `notify.qq` | 推送到 qq-bot 的 `/notify` 接口 |

## 与浏览器版的关系

| | 浏览器版 torn-toolbox | Desktop 版 |
|--|----------------------|--------------|
| 运行环境 | Torn 网页 + Tampermonkey | 本地 Node 进程 |
| 通知 | 浏览器通知 | 桌面通知 + QQ |
| 购买/出售均价、攻击筛选 | ✅ | ❌（需浏览器） |
| 压价助手、公司监听 | ✅ | ✅ |

## 注意

- 监听在后台持续运行，关闭浏览器标签不影响 Desktop 版
- 请勿将 `config.json` 提交到公开仓库

## 部署到阿里云 ECS（24/7 云端监听）

与本地 `http://127.0.0.1:8790/` **同一套 Web 配置页**，部署在 ECS 上后用手机/电脑远程打开即可配置，无需本地 PC 常开。

### 架构

```
浏览器 → ECS:8790（配置页 + 监听）
              ↓ 127.0.0.1:8787/notify
         qq-bot → NapCat → QQ 群
```

8787 只需本机访问，**不必**对公网开放；只需在安全组放行 **8790**。

### 步骤

1. 确保 ECS 上 [qq-bot](../qq-bot/) 与 NapCat 已运行（`/opt/qq-bot`）
2. 上传本目录到 ECS，例如 `/opt/torn-toolbox-desktop`
3. 在 ECS 上：

```bash
cd /opt/torn-toolbox-desktop
cp config.ecs.example.json config.json
nano config.json   # 填 tornApiKey、adminToken、notify.qq.token（与 qq-bot 一致）
sed -i 's/\r$//' deploy-ecs.sh   # 若从 Windows 上传需去 CRLF
chmod +x deploy-ecs.sh
./deploy-ecs.sh
```

4. 阿里云安全组 → 入方向 → TCP **8790**（建议限制来源 IP）
5. 浏览器访问：

```
http://123.56.235.12:8790/?token=你的adminToken
```

首次带 `?token=` 访问后会写入 Cookie，之后同一浏览器可直接打开 `http://IP:8790/`。

### ECS 配置要点

| 字段 | ECS 推荐值 |
|------|------------|
| `server.host` | `0.0.0.0` |
| `server.openBrowser` | `false` |
| `server.adminToken` | 强随机字符串（配置页访问密码） |
| `undercut.autoStart` | `true`（pm2 重启后自动恢复监听） |
| `notify.desktop` | `false`（服务器无桌面通知） |
| `notify.qq.url` | `http://127.0.0.1:8787/notify` |

### 常用命令

```bash
pm2 logs torn-toolbox
pm2 restart torn-toolbox
pm2 status
```

### 不想开放公网时

SSH 隧道（与本地 8790 体验一致）：

```bash
ssh -L 8790:127.0.0.1:8790 root@123.56.235.12
```

然后本机打开 `http://127.0.0.1:8790/`（若设置了 adminToken 仍要带 `?token=`）。
