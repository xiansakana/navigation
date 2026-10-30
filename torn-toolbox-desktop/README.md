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
| `company.autoStart` | `true`（点「开始监听」后会写入配置；pm2 重启后自动恢复） |
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


## 市场自身调价误报修复

市场比较先使用完整的自身 `/user/itemmarket` 快照：非堆叠物品按 `item.uid` 与公共 `item_details.uid` 排除自身；堆叠物品按价格汇总自身 `amount`，从公共价格档数量中一次性扣除。多个自身价位一起参与排除，同价其他卖家余量仍算竞争数量。`available` 是库存剩余量，不用于抵扣在售数量。

官方公共市场的堆叠挂单只有价格和数量，不提供卖家 ID，且为全局缓存，不能绝对证明两个接口读取时刻的实时归属。新市场提醒需至少跨 60 秒（或更长的官方 cache_delay），自身挂单快照和竞争低价均稳定，并看到 `cache_timestamp` 前进；重复同一缓存不算复核。自身当前挂单必须在读取的前 100 条公共记录中按 UID/价格或价格/数量得到核验；未出现、数量不足或无缓存时间时保持待核验，不强行推送。极高价挂单不在前 100 条时可能延迟或不产生提醒。自己改价、撤单或候选消失会重置/撤销待核验。

候选状态同现有 activeKeys/alerts 一起持久化到 worker SQLite，Key 改变时失效。已确认的活跃压价继续去重；旧消息不重发、不清空。新市场通知会比原来晚至少一个缓存窗口，另加扫描排队时间。Bazaar 继续按 player_id 排除自己，不增加该等待。

通知开关、渠道、目标及 @ 仍只在通知管理 → 业务提醒配置，不复制到业务页。回归测试 `src/undercut-self-price.test.js` 覆盖多价位自身挂单、UID、自调价错位、同价竞争余量、缓存不推进、缓存缺失和真正竞争低价。

字段依据：[Torn 官方 OpenAPI](https://www.torn.com/swagger/openapi.json) 的 UserItemMarketListing / ItemMarketListingStackable / ItemMarketListingNonstackable / ItemMarket。
