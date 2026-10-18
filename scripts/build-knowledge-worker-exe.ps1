$ErrorActionPreference = 'Stop'
$workerRoot = Split-Path $PSScriptRoot -Parent
$source = Join-Path $PSScriptRoot 'windows-worker/Installer.cs'
$outputDirectory = Join-Path $workerRoot 'portal/assets/knowledge-worker'
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$compiler = Join-Path $env:SystemRoot 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$exe = Join-Path $outputDirectory 'bootstrap.exe'
& $compiler /nologo /target:winexe /platform:anycpu /optimize+ /utf8output /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll /r:System.Web.Extensions.dll ("/out:" + $exe) $source
if ($LASTEXITCODE -ne 0) { throw 'EXE compilation failed' }
$sourceBytes = [Text.Encoding]::UTF8.GetBytes(([IO.File]::ReadAllText($source)).Replace("`r`n", "`n"))
$sourceHash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($sourceBytes)).Replace('-','').ToLower()
$manifest = @{ sourceSha256=$sourceHash; sha256=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLower() }
[IO.File]::WriteAllText((Join-Path $outputDirectory 'bootstrap.json'), ($manifest | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
Write-Output 'Windows installer bootstrap compiled and checksummed.'
