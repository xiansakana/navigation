param(
  [string]$ConfigPath = (Join-Path $PSScriptRoot '../portal/knowledge-worker.config.json'),
  [string]$NodePath = (Get-Command node.exe -ErrorAction Stop).Source,
  [string]$LogDirectory = (Join-Path $env:LOCALAPPDATA 'Navigation/knowledge-worker')
)
$ErrorActionPreference = 'Stop'
$workerRoot = Split-Path $PSScriptRoot -Parent
$workerConfig = (Resolve-Path -LiteralPath $ConfigPath).Path
$workerMutex = New-Object System.Threading.Mutex($false, 'Local\NavigationKnowledgeWorker')
if (-not $workerMutex.WaitOne(0)) { exit 0 }
try {
  New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null
  while ($true) {
    $workerLog = Join-Path $LogDirectory ((Get-Date -Format 'yyyy-MM-dd') + '.log')
    # Node inherits the user's login, CUDA libraries and private configuration.
    & $NodePath (Join-Path $workerRoot 'scripts/knowledge-worker.mjs') $workerConfig *>> $workerLog
    Start-Sleep -Seconds 15
  }
} finally {
  $workerMutex.ReleaseMutex()
  $workerMutex.Dispose()
}
