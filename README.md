# navigation

ECS 服务导航与自托管应用（portal 统一入口 :80）。

## 目录

| 目录 | 说明 |
|------|------|
| `portal/` | 服务导航、登录、反代 |
| `qq-bot/` | QQ 通知桥接 → NapCat |
| `torn-toolbox-desktop/` | Torn 压价助手 + 公司监听（独立进程） |
| `scripts/` | ECS 部署与运维脚本 |

Torn 浏览器用户脚本在独立仓库 [xiansakana-torn-scripts](https://github.com/xiansakana/xiansakana-torn-scripts)。

## 部署

见 [DEPLOY-ECS.md](./DEPLOY-ECS.md)。

```powershell
# 本机（仓库根目录）
git push
.\scripts\ecs-deploy-from-local.ps1
```

```bash
# ECS
cd /opt/navigation
./scripts/ecs-update.sh
```
