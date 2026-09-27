# 紧急例外：仅在用户明确授权时使用 SCP；常规部署必须 git push + ECS git pull。
# 注意：不同步各服务的 config.json，避免本机开发配置覆盖 ECS 生产配置（含 torn-toolbox hub 结构）
# Usage:
#   git push origin main
#   ssh root@123.56.235.12 "cd /opt/navigation && ./scripts/ecs-update.sh"
# 经用户明确授权的紧急 SCP:
#   .\scripts\ecs-deploy-from-local.ps1 -AllowEmergencyScp
param(
    [string]$Only = "",
    [switch]$AllowEmergencyScp
)

$ErrorActionPreference = "Stop"

if (-not $AllowEmergencyScp) {
    throw "SCP 部署仅限用户明确授权的紧急例外。常规流程请先 git push，再由 ECS git pull。"
}

$RepoRoot = Split-Path $PSScriptRoot -Parent
$Key = Join-Path $env:USERPROFILE ".ssh\ecs_torn"
$SshTarget = "root@123.56.235.12"
$RemoteRoot = "/opt/navigation"

$Dirs = @("portal", "qq-bot", "torn-toolbox-desktop", "stock-manage", "qqq-dip", "scripts", "shared")

$ExcludeConfigNames = @("config.json", "config.undercut.json", "config.company.json")

function Sync-DirExcludingConfigs {
    param(
        [string]$LocalDir,
        [string]$RemoteDir
    )
    $temp = Join-Path $env:TEMP ("ecs-deploy-" + [guid]::NewGuid().ToString("n"))
    New-Item -ItemType Directory -Path $temp -Force | Out-Null
    try {
        $null = robocopy $LocalDir $temp /E /XF $ExcludeConfigNames /NFL /NDL /NJH /NJS /NC /NS
        if ($LASTEXITCODE -ge 8) {
            throw "robocopy failed with exit code $LASTEXITCODE"
        }
        scp -i $Key -r "$temp\*" "${SshTarget}:${RemoteDir}/"
    } finally {
        Remove-Item -Recurse -Force $temp -ErrorAction SilentlyContinue
    }
}

Write-Host "==> Sync to ECS: ${SshTarget}:${RemoteRoot} (config.json excluded)"
foreach ($dir in $Dirs) {
    $localPath = Join-Path $RepoRoot $dir
    if (-not (Test-Path $localPath)) {
        Write-Warning "Skip missing directory: $dir"
        continue
    }
    Write-Host "  - $dir"
    Sync-DirExcludingConfigs -LocalDir $localPath -RemoteDir (Join-Path $RemoteRoot $dir)
}

$onlyArg = ""
if ($Only) {
    $onlyArg = " --only $Only"
}

Write-Host "==> Restart services (skip ECS git pull)"
ssh -i $Key $SshTarget "cd $RemoteRoot; find . -name '*.sh' -exec sed -i 's/\r$//' {} +; chmod +x scripts/*.sh portal/deploy-ecs.sh qq-bot/deploy-ecs.sh torn-toolbox-desktop/deploy-ecs.sh stock-manage/deploy-ecs.sh qqq-dip/deploy-ecs.sh; bash scripts/ecs-update.sh --skip-pull$onlyArg"

Write-Host "==> Deploy done"
