# ECS 部署（navigation 仓库）

本仓库为 ECS 服务栈（portal / qq-bot / torn-toolbox / stock-manage）。Torn 浏览器脚本在 [xiansakana-torn-scripts](https://github.com/xiansakana/xiansakana-torn-scripts)。

**ECS 路径：** `/opt/navigation`

---

## 一、本机开发

```powershell
cd D:\code\navigation
git add .
git commit -m "描述"
git push
```

`config.json` 已在各服务 `.gitignore` 中，不会上传密钥。

---

## 二、ECS 首次部署

```bash
cd /opt
git clone git@github.com:xiansakana/navigation.git
cd navigation
```

按顺序配置并 `./deploy-ecs.sh`：`qq-bot` → `torn-toolbox-desktop` → `stock-manage` → `portal`。

详见各目录内 `config.ecs.example.json`。

### 从旧仓库 xiansakana-torn-scripts 迁移

若 ECS 上已有 `/opt/xiansakana-torn-scripts`：

```bash
cd /opt/navigation   # 克隆或本机 scp 完成后
bash scripts/migrate-ecs-from-torn-scripts.sh
```

---

## 三、日常更新

**ECS：**

```bash
cd /opt/navigation
./scripts/ecs-update.sh
```

**本机（GitHub 超时时）：**

```powershell
cd D:\code\navigation
git push
.\scripts\ecs-deploy-from-local.ps1
```

按需重启：

```bash
./scripts/ecs-update.sh --only undercut
./scripts/ecs-update.sh --only company,qq-bot,portal
```

---

## 四、Deploy Key（ECS 拉 GitHub）

```bash
# ~/.ssh/config 见 xiansakana-torn-scripts 文档或旧 DEPLOY-ECS 第四节
cd /opt/navigation
git remote set-url origin git@github.com:xiansakana/navigation.git
```

Deploy Key 需加到 **navigation** 仓库（可与 torn-scripts 共用同一密钥，两个仓库都加 deploy key）。

---

## 五、添加非 Torn 服务

在 `portal/config.json` 的 `services` 增加卡片；新服务放在本仓库根目录（与 `qq-bot` 平级），独立端口 + pm2，仅 portal :80 对外。

---

## 六、访问

```
http://<ECS公网IP>/
```

安全组只需放行 **80**；8790 / 8791 / 8787 / 6099 绑定 `127.0.0.1`。
