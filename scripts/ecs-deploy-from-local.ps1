# Sync navigation repo to ECS when git pull on ECS is unreliable.
# Usage:
#   git push
#   .\scripts\ecs-deploy-from-local.ps1
#   .\scripts\ecs-deploy-from-local.ps1 -Only undercut,company

param(
    [string]$Only = ""
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path $PSScriptRoot -Parent
$Key = Join-Path $env:USERPROFILE ".ssh\ecs_torn"
$SshTarget = "root@123.56.235.12"
$RemoteRoot = "/opt/navigation"

$Dirs = @("portal", "qq-bot", "torn-toolbox-desktop", "scripts")

Write-Host "==> Sync to ECS: ${SshTarget}:${RemoteRoot}"
foreach ($dir in $Dirs) {
    $localPath = Join-Path $RepoRoot $dir
    if (-not (Test-Path $localPath)) {
        Write-Warning "Skip missing directory: $dir"
        continue
    }
    Write-Host "  - $dir"
    scp -i $Key -r $localPath "${SshTarget}:${RemoteRoot}/"
}

$onlyArg = ""
if ($Only) {
    $onlyArg = " --only $Only"
}

Write-Host "==> Restart services (skip ECS git pull)"
ssh -i $Key $SshTarget "cd $RemoteRoot; find . -name '*.sh' -exec sed -i 's/\r$//' {} +; chmod +x scripts/*.sh portal/deploy-ecs.sh qq-bot/deploy-ecs.sh torn-toolbox-desktop/deploy-ecs.sh; bash scripts/ecs-update.sh --skip-pull$onlyArg"

Write-Host "==> Deploy done"
