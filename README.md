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

## 首页博客

首页博客以时间线展示文字和图片动态。管理员在「权限管理 → 角色」给角色分配「首页博客」下的查看、发布或管理权限；发布权限可编辑和删除自己的文章，管理权限可编辑和删除全部文章。游客默认没有博客权限，可以按需单独授予查看权限。文章和图片保存在共享 SQLite 的 `blog_posts`、`blog_images` 表中，按 Portal 用户 ID 记录作者；单篇最多 10000 字和 4 张图片，每张图片最多 5MB。支持 JPG、PNG、WebP、GIF；浏览器会尝试把其他可解码的手机照片转换为 JPG。

Torn 浏览器用户脚本在独立仓库 [xiansakana-torn-scripts](https://github.com/xiansakana/xiansakana-torn-scripts)。

## 部署

见 [DEPLOY-ECS.md](./DEPLOY-ECS.md)。

```bash
# 通过 Cursor/VS Code Remote SSH 连接 ECS 后，在服务器上执行
cd /opt/navigation
git status
git add <本次变更的文件>
git commit -m "描述"
git push origin main
revision=$(git rev-parse HEAD)
./scripts/ecs-update.sh --expected-sha "$revision" --only portal
```

`--only` 按实际受影响服务调整。提交前必须确认没有把配置、数据库、日志或运行时文件加入 Git；拉取或校验失败时停止并排查，不改用 SCP。详细流程见 [DEPLOY-ECS.md](./DEPLOY-ECS.md)。
