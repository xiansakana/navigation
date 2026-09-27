# ECS 部署（navigation 仓库）

本仓库为 ECS 服务栈（portal / qq-bot / torn-toolbox / stock-manage / qqq-dip）。Torn 浏览器脚本在 [xiansakana-torn-scripts](https://github.com/xiansakana/xiansakana-torn-scripts)。

**ECS 路径：** `/opt/navigation`

---

## 一、ECS Remote SSH 开发（主流程）

通过 Cursor/VS Code Remote SSH 连接 ECS，在 `/opt/navigation` 直接编辑和测试。ECS 工作区是唯一主工作区，本地副本只用于查看、备份或辅助验证。

```bash
ssh root@<ECS公网IP>
cd /opt/navigation
git status
```

## 二、ECS 提交与部署

```bash
ssh root@<ECS公网IP>
cd /opt/navigation
git add <本次变更的文件>
git commit -m "描述"
git push origin main
revision=$(git rev-parse HEAD)
./scripts/ecs-update.sh --expected-sha "$revision" --only portal
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

正常情况下直接在 ECS Remote SSH 会话中提交并部署：

```bash
cd /opt/navigation
revision=$(git rev-parse HEAD)
git push origin main
./scripts/ecs-update.sh --expected-sha "$revision" --only portal
```

将 `portal` 换成实际受影响服务列表；共享代码变更应包含所有受影响服务。脚本会核对部署提交与 `$revision` 一致。只有已提交的代码可以声明与生产一致。

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

在 `portal/config.json` 的 `services` 增加卡片；新服务放在本仓库根目录（与 `qq-bot` 平级），独立端口 + pm2，仅 portal :80 对外。

---

## 七、访问

```
http://<ECS公网IP>/
```

安全组只需放行 **80**；8790 / 8791 / 8787 / 6099 绑定 `127.0.0.1`。
