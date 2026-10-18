param(
  [string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA 'Navigation/KnowledgeWorker'),
  [string]$PortalUrl = 'https://saoyu.fun',
  [string]$ReuseConfig = '',
  [switch]$CheckOnly,
  [switch]$NoStart
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$bundleRoot = Split-Path $PSScriptRoot -Parent
if (-not $PSBoundParameters.ContainsKey('PortalUrl') -and (Test-Path -LiteralPath (Join-Path $bundleRoot 'worker-pairing.json'))) {
  $PortalUrl = (Get-Content -LiteralPath (Join-Path $bundleRoot 'worker-pairing.json') -Raw -Encoding UTF8 | ConvertFrom-Json).portalUrl
}
$uri = [Uri]$PortalUrl
if ($uri.Scheme -ne 'https' -and -not ($uri.Scheme -eq 'http' -and $uri.Host -in @('localhost','127.0.0.1'))) { throw 'HTTPS portal required.' }
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { throw 'This package requires Windows x64.' }
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if ($CheckOnly) {
  Write-Output ('Windows x64 ready; Node installed: ' + [bool]$nodeCommand)
  Write-Output ('Install location: ' + $InstallDirectory)
  exit 0
}
function Assert-NativeExit([string]$Step) { if ($LASTEXITCODE -ne 0) { throw ($Step + ' failed. Check network access and run setup again.') } }
function Download-File([string]$Url, [string]$Destination) {
  Write-Host ('Downloading ' + ([Uri]$Url).Host + ' ...')
  Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Destination -TimeoutSec 600
}
$appRoot = [IO.Path]::GetFullPath($InstallDirectory)
New-Item -ItemType Directory -Path $appRoot -Force | Out-Null
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls $appRoot /inheritance:r /grant:r ($identity + ':(OI)(CI)F') 'SYSTEM:(OI)(CI)F' | Out-Null
Assert-NativeExit 'Private directory permissions'
$runtime = Join-Path $appRoot 'runtime'
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
$node = if ($nodeCommand) { $nodeCommand.Source } else { '' }
if ($node) { $major = & $node -p 'Number(process.versions.node.split(".")[0])'; if ([int]$major -lt 22) { $node = '' } }
if (-not $node) {
  $nodeArchive = 'node-v22.20.0-win-x64.zip'
  $zip = Join-Path $runtime $nodeArchive
  Download-File ('https://nodejs.org/dist/v22.20.0/' + $nodeArchive) $zip
  $sums = (Invoke-WebRequest -UseBasicParsing -Uri 'https://nodejs.org/dist/v22.20.0/SHASUMS256.txt').Content
  $expected = ($sums -split "`n" | Where-Object { $_.Trim().EndsWith('  ' + $nodeArchive) }) -replace '\s+.*$', ''
  if (-not $expected -or (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLower() -ne $expected.Trim().ToLower()) { throw 'Node download checksum mismatch.' }
  Expand-Archive -LiteralPath $zip -DestinationPath $runtime -Force
  $node = Join-Path $runtime 'node-v22.20.0-win-x64/node.exe'
}
$previous = $null
$configPath = Join-Path $appRoot 'config.json'
$boundDevice = if (Test-Path -LiteralPath $configPath) { Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
if ($ReuseConfig) { $previous = Get-Content -LiteralPath $ReuseConfig -Raw -Encoding UTF8 | ConvertFrom-Json }
elseif (Test-Path -LiteralPath $configPath) { $previous = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json }
$version = (Get-Content -LiteralPath (Join-Path $bundleRoot 'worker-version.json') -Raw | ConvertFrom-Json).version
if ($version -notmatch '^[a-f0-9]{64}$') { throw 'Invalid installer bundle.' }
$releaseRoot = Join-Path $appRoot ('releases/' + $version)
New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
# Copy only the package allowlist; never copy a checkout, credentials or uploads.
$packageFiles = @('package.json','worker-version.json','README.txt','scripts/knowledge-worker.mjs','scripts/start-knowledge-worker.ps1','scripts/install-knowledge-worker.ps1','scripts/setup-knowledge-worker.ps1','scripts/knowledge-worker-launcher.mjs','scripts/knowledge-worker-pair.mjs','scripts/knowledge-worker-setup.cmd','portal/src/knowledge-model.js','portal/src/knowledge-visual-evidence.js','portal/src/knowledge-download.js','portal/workers/video_evidence.py','portal/workers/video_runtime.py','portal/workers/requirements.txt')
foreach ($file in $packageFiles) {
  $destination = Join-Path $releaseRoot $file
  New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force | Out-Null
  if ([IO.Path]::GetFullPath((Join-Path $bundleRoot $file)) -ne [IO.Path]::GetFullPath($destination)) { Copy-Item -LiteralPath (Join-Path $bundleRoot $file) -Destination $destination -Force }
}
$config = [ordered]@{ portalUrl=$PortalUrl; token=''; label=$env:COMPUTERNAME; workDir=(Join-Path $appRoot 'cache'); autoUpdate=$true; releaseRoot=$releaseRoot; python=''; ffmpeg=''; asr=@{model='small';device='auto';threads=4;language='zh';modelCache=(Join-Path $appRoot 'models')}; codex=@{binary='';model='';proxyUrl=''} }
if ($boundDevice -and $boundDevice.deviceId -and $boundDevice.portalUrl -eq $PortalUrl) { $config.token = $boundDevice.token; $config.deviceId = $boundDevice.deviceId }
elseif ($previous -and $previous.deviceId -and $previous.portalUrl -eq $PortalUrl) { $config.token = $previous.token; $config.deviceId = $previous.deviceId }
$utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 8), $utf8)
# Redeem short-lived installer authorization before downloading large dependencies.
& $node (Join-Path $releaseRoot 'scripts/knowledge-worker-pair.mjs') $configPath $bundleRoot
Assert-NativeExit 'Device binding'
$config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($previous -and $previous.python -and $previous.ffmpeg -and (Test-Path -LiteralPath $previous.python) -and (Test-Path -LiteralPath $previous.ffmpeg)) {
  $python = $previous.python; $ffmpeg = $previous.ffmpeg
  $config.asr = $previous.asr
} else {
  $pythonBase = Join-Path $runtime 'python311/python.exe'
  if (-not (Test-Path -LiteralPath $pythonBase)) {
    $installer = Join-Path $runtime 'python-3.11.9-amd64.exe'
    Download-File 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe' $installer
    $signature = Get-AuthenticodeSignature -LiteralPath $installer
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notlike '*Python*Foundation*') { throw 'Python installer signature verification failed.' }
    $target = Join-Path $runtime 'python311'
    $process = Start-Process -FilePath $installer -ArgumentList @('/quiet','InstallAllUsers=0',('TargetDir="' + $target + '"'),'PrependPath=0','Include_launcher=0','Include_test=0','Include_pip=1') -WindowStyle Hidden -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw 'Python installation failed.' }
  }
  $venv = Join-Path $runtime 'venv'
  if (-not (Test-Path -LiteralPath (Join-Path $venv 'Scripts/python.exe'))) { & $pythonBase -m venv $venv; Assert-NativeExit 'Python environment' }
  $python = Join-Path $venv 'Scripts/python.exe'
  & $python -m pip install --disable-pip-version-check -r (Join-Path $releaseRoot 'portal/workers/requirements.txt') 'imageio-ffmpeg==0.6.0'
  Assert-NativeExit 'Speech recognition dependencies'
  $gpuCount = & $python -c 'import ctranslate2; print(ctranslate2.get_cuda_device_count())'
  if ([int]$gpuCount -gt 0) {
    & $python -m pip install --disable-pip-version-check 'nvidia-cublas-cu12>=12,<13' 'nvidia-cudnn-cu12>=9,<10'
    Assert-NativeExit 'CUDA inference libraries'
  }
  $ffmpeg = & $python -c 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())'
}
$config.python = $python; $config.ffmpeg = $ffmpeg
$device = & $python (Join-Path $releaseRoot 'portal/workers/video_runtime.py') $config.asr.device
Assert-NativeExit 'GPU / CPU detection'
Write-Host ('Speech recognition device: ' + $device)
$codex = if ($previous -and $previous.codex.binary -and (Test-Path -LiteralPath $previous.codex.binary)) { $previous.codex.binary } else { '' }
if (-not $codex) {
  $command = Get-Command codex.exe -ErrorAction SilentlyContinue
  if ($command) { $codex = $command.Source }
  else { $codex = Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'OpenAI/Codex/bin') -Filter codex.exe -Recurse -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName }
}
if (-not $codex) {
  $npm = Join-Path (Split-Path $node -Parent) 'npm.cmd'
  $prefix = Join-Path $runtime 'codex'
  & $npm install --prefix $prefix '@openai/codex@0.163.0'
  Assert-NativeExit 'Codex CLI installation'
  $codex = Get-ChildItem -LiteralPath (Join-Path $prefix 'node_modules') -Filter codex.exe -Recurse | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $codex) { throw 'Codex native executable not found.' }
$help = (& $codex exec --help 2>&1) -join "`n"
if (-not $help.Contains('--ignore-user-config') -or -not $help.Contains('--ignore-rules')) { throw 'Codex CLI needs an update to support isolated video summarization.' }
$ErrorActionPreference = 'Continue'
& $codex login status 2>$null
$loginExit = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($loginExit -ne 0) { Write-Host 'Complete your Codex account sign-in in the browser.'; & $codex login; Assert-NativeExit 'Codex login' }
$config.codex.binary = $codex
if ($previous -and $previous.codex) { $config.codex.proxyUrl = $previous.codex.proxyUrl; $config.codex.model = $previous.codex.model }
[IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 8), $utf8)
& icacls $configPath /inheritance:r /grant:r ($identity + ':(F)') 'SYSTEM:(F)' | Out-Null
Assert-NativeExit 'Credential permissions'
if (-not $NoStart) {
  & (Join-Path $releaseRoot 'scripts/install-knowledge-worker.ps1') -ConfigPath $configPath -NodePath $node
  Write-Host 'Installed and connected. This computer will start its worker after Windows sign-in.'
} else { Write-Host 'Installation verified; automatic startup was not enabled (NoStart).' }
Write-Host ('Private configuration: ' + $configPath)
