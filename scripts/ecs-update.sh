#!/bin/bash
# 在 ECS 上更新 navigation 仓库并重启服务
# 用法: ./scripts/ecs-update.sh [--skip-pull] [--only undercut,company,qq-bot,portal,napcat,stock-manage,siyuan,siyuan-share,piclist]
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SKIP_PULL=false
ONLY=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --skip-pull) SKIP_PULL=true; shift ;;
        --only) ONLY="$2"; shift 2 ;;
        *) echo "未知参数: $1"; exit 1 ;;
    esac
done

should_run() {
    local name="$1"
    [[ -z "$ONLY" ]] && return 0
    echo ",$ONLY," | grep -q ",$name,"
}

git_pull_with_retry() {
    local attempt max=3 delay=5
    for attempt in $(seq 1 "$max"); do
        echo "==> git pull (尝试 $attempt/$max)"
        if git pull --ff-only; then
            return 0
        fi
        if [[ "$attempt" -lt "$max" ]]; then
            echo "git pull 失败，${delay}s 后重试..."
            sleep "$delay"
            delay=$((delay * 2))
        fi
    done
    echo ""
    echo "错误: 无法从 GitHub 拉取代码（国内网络访问 GitHub 443 不稳定）。"
    echo "可选方案:"
    echo "  1. 本机 D:\\code\\navigation 执行: .\\scripts\\ecs-deploy-from-local.ps1"
    echo "  2. 稍后在 ECS 上重试: ./scripts/ecs-update.sh"
    echo "  3. 改用 SSH: git remote set-url origin git@github.com:xiansakana/navigation.git"
    return 1
}

if [[ "$SKIP_PULL" != true ]]; then
    git_pull_with_retry
else
    echo "==> 跳过 git pull（代码已由本机同步）"
fi

if should_run qq-bot; then
    echo "==> qq-bot"
    cd "$ROOT/qq-bot"
    npm install --production
    if pm2 describe qq-bot >/dev/null 2>&1; then
        pm2 restart qq-bot
    else
        echo "qq-bot 未运行，请先配置 config.json 并执行 ./deploy-ecs.sh"
    fi
fi

if should_run undercut || should_run company; then
    echo "==> torn-toolbox-desktop"
    cd "$ROOT/torn-toolbox-desktop"
    npm install --production
    if [ -f config.json ] && { [ ! -f config.undercut.json ] || [ ! -f config.company.json ]; }; then
        node scripts/migrate-config.mjs
    fi
fi

if should_run undercut; then
    if pm2 describe torn-undercut >/dev/null 2>&1; then
        pm2 restart torn-undercut
    elif pm2 describe torn-toolbox >/dev/null 2>&1; then
        echo "检测到旧进程 torn-toolbox，请运行 torn-toolbox-desktop/deploy-ecs.sh 完成迁移"
    else
        echo "torn-undercut 未运行，请先配置 config.undercut.json 并执行 ./deploy-ecs.sh"
    fi
fi

if should_run company; then
    if pm2 describe torn-company >/dev/null 2>&1; then
        pm2 restart torn-company
    else
        echo "torn-company 未运行，请先配置 config.company.json 并执行 ./deploy-ecs.sh"
    fi
fi

if should_run portal; then
    echo "==> portal"
    if [ -f "$ROOT/scripts/sync-portal-proxy-services.py" ]; then
        python3 "$ROOT/scripts/sync-portal-proxy-services.py" || true
    fi
    if [ -f "$ROOT/scripts/sync-share-site-url.py" ]; then
        python3 "$ROOT/scripts/sync-share-site-url.py" || true
    fi
    cd "$ROOT/portal"
    npm install --production
    if pm2 describe portal >/dev/null 2>&1; then
        pm2 restart portal
    else
        echo "portal 未运行，请先配置 config.json 并执行 ./deploy-ecs.sh"
    fi
fi

if should_run stock-manage; then
    echo "==> stock-manage"
    cd "$ROOT/stock-manage"
    npm install --production
    if pm2 describe stock-manage >/dev/null 2>&1; then
        TRUST_PROXY=1 pm2 restart stock-manage --update-env
    else
        echo "stock-manage 未运行，请先配置 config.json 并执行 ./deploy-ecs.sh"
    fi
fi

if should_run siyuan; then
    echo "==> siyuan"
    cd "$ROOT/siyuan"
    docker compose up -d
fi

if should_run siyuan-share; then
    echo "==> siyuan-share"
    if [ -f "$ROOT/scripts/sync-share-site-url.py" ]; then
        python3 "$ROOT/scripts/sync-share-site-url.py" || true
    fi
    if [ -f "$ROOT/scripts/sync-share-registration.py" ]; then
        python3 "$ROOT/scripts/sync-share-registration.py" || true
    fi
    cd "$ROOT/siyuan-share"
    bash deploy-ecs.sh
fi

if should_run piclist; then
    echo "==> piclist"
    if [ -f "$ROOT/scripts/fix-piclist-uploader.py" ]; then
        python3 "$ROOT/scripts/fix-piclist-uploader.py" || true
    fi
    if [ -f "$ROOT/scripts/fix-piclist-b2-endpoint.py" ]; then
        python3 "$ROOT/scripts/fix-piclist-b2-endpoint.py" || true
    fi
    cd "$ROOT/piclist"
    bash deploy-ecs.sh
    if [ -f "$ROOT/scripts/sync-piclist-rename.py" ]; then
        python3 "$ROOT/scripts/sync-piclist-rename.py" || true
    fi
    if [ -f "$ROOT/scripts/sync-siyuan-picgo-external.py" ] && [ -f "$ROOT/piclist/.env" ]; then
        # shellcheck disable=SC1091
        set -a && source "$ROOT/piclist/.env" && set +a
        python3 "$ROOT/scripts/sync-siyuan-picgo-external.py" || true
    fi
    if [ -f "$ROOT/scripts/patch-siyuan-picgo-paste.py" ]; then
        python3 "$ROOT/scripts/patch-siyuan-picgo-paste.py" || true
    fi
fi

if should_run napcat; then
    echo "==> napcat"
    if [ -d /opt/napcat ]; then
        cd /opt/napcat && docker compose restart napcat
    else
        echo "未找到 /opt/napcat，跳过 NapCat 重启"
    fi
fi

pm2 save 2>/dev/null || true
echo "==> 更新完成"
pm2 status 2>/dev/null || true
