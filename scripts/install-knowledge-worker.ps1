param(
  [string]$ConfigPath = (Join-Path $PSScriptRoot '../portal/knowledge-worker.config.json'),
  [string]$NodePath = (Get-Command node.exe -ErrorAction Stop).Source
)
$ErrorActionPreference = 'Stop'
$workerConfig = (Resolve-Path -LiteralPath $ConfigPath).Path
$workerNode = (Resolve-Path -LiteralPath $NodePath).Path
$workerLauncher = Join-Path $PSScriptRoot 'start-knowledge-worker.ps1'
$workerArguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -ConfigPath "{1}" -NodePath "{2}"' -f $workerLauncher, $workerConfig, $workerNode
$workerAction = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument $workerArguments
$workerUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$workerTrigger = New-ScheduledTaskTrigger -AtLogOn -User $workerUser
$workerPrincipal = New-ScheduledTaskPrincipal -UserId $workerUser -LogonType Interactive -RunLevel Limited
$workerSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'Navigation Knowledge GPU Worker' -Action $workerAction -Trigger $workerTrigger -Principal $workerPrincipal -Settings $workerSettings -Description '本机视频知识库 GPU 工作器，登录后自动启动，异常退出自动重试。' -Force | Out-Null
Start-ScheduledTask -TaskName 'Navigation Knowledge GPU Worker'
Write-Output '本机 GPU 工作器已启动，并配置为当前用户登录后自动运行。'
