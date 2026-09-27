# navigation

ECS 服务导航与自托管应用（portal 统一入口 :80）。

## 目录

| 目录 | 说明 |
|------|------|
| `portal/` | 服务导航、登录、反代 |
| `qq-bot/` | 通知管理服务（QQ / 邮件，QQ 通过 NapCat） |
| `torn-toolbox-desktop/` | Torn 压价助手 + 公司监听（独立进程） |
| `stock-manage/` | 美股持仓管理（:5000，服务端持久化） |
| `qqq-dip/` | QQQ 抄底监控与 QQ 提醒（:5001，独立库） |
| `alist/` | AList 网盘聚合（本机 :5244 → Portal `/alist/`） |
| `scripts/` | ECS 部署与运维脚本 |

Torn 浏览器用户脚本在独立仓库 [xiansakana-torn-scripts](https://github.com/xiansakana/xiansakana-torn-scripts)。

## 部署

见 [DEPLOY-ECS.md](./DEPLOY-ECS.md)。

```powershell
# 本机（仓库根目录）
git push origin main
if ($LASTEXITCODE -ne 0) { throw 'Git push failed; deployment stopped' }
$revision = (git rev-parse HEAD).Trim()
ssh root@123.56.235.12 "cd /opt/navigation && ./scripts/ecs-update.sh --expected-sha $revision --only portal"
```

先确认本地更改已提交且推送成功；`--only` 按实际受影响服务调整。拉取失败时停止并排查，不改用 SCP。详细流程见 [DEPLOY-ECS.md](./DEPLOY-ECS.md)。
