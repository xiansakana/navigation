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

编辑格式可选择 Markdown，支持源码编辑、实时预览、标题、列表、代码块、表格和图片；源码与清理后的显示内容分开处理。文章可附带手填位置名称或通过浏览器授权获取的经纬度，并在编辑时修改、移除；获取位置不会自动发布。图片在待发布、编辑和已发布状态均可点击页内预览，支持切换、放大与 Esc 关闭。

支持富文本格式（加粗、斜体、下划线、删除线、标题、列表、引用和链接）以及文章标签。输入标签后按回车或点击「添加标签」，已有标签可从输入建议中复用；点击标签可筛选动态。每篇最多 20 个标签，每个最多 30 字。标签随文章保存在共享 SQLite 的 `blog_post_tags` 表中，编辑与删除遵循文章权限。富文本由服务端按允许列表清理后保存，旧纯文本文章无需转换即可继续显示与编辑。粘贴内容以纯文本插入，可再使用工具栏排版。

首页博客以时间线展示文字、图片和视频动态。管理员在「权限管理 → 角色」给角色分配「首页博客」下的查看、发布或管理权限；发布权限可编辑和删除自己的文章，管理权限可编辑和删除全部文章。游客默认没有博客权限，可以按需单独授予查看权限。文章及媒体 URL 和归属信息保存在共享 SQLite 的 `blog_posts`、`blog_media` 表中，按 Portal 用户 ID 记录作者。图片在浏览器统一转换为 JPG，通过 Portal 服务端调用 PicList 上传到 B2，不再限制 4 张或原文件 5MB；视频通过 Portal 服务端使用 PicList 的 B2 配置直接上传，支持 MP4、WebM、MOV，单个 50MB 以内。现有 `blog_images` 中的旧图片仍可读取。B2 媒体 URL 为公开链接，获得链接的人可直接访问。

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
