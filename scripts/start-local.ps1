$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectDir
if (-not ((Test-Path -LiteralPath 'out\index.html') -and (Test-Path -LiteralPath 'storage\vps-release\server.mjs'))) { throw 'Please run npm install, npm run build and npm run build:vps first.' }
$alreadyRunning = $false
try {
  $configResult = Invoke-RestMethod -Uri 'http://127.0.0.1:3002/api/config' -TimeoutSec 2
  $alreadyRunning = $configResult.application -eq 'cet-writing'
} catch {}
if (-not $alreadyRunning) {
  if (Get-NetTCPConnection -LocalPort 3002 -State Listen -ErrorAction SilentlyContinue) { throw 'Port 3002 is occupied by another program.' }
  $nodePath = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
  if (-not $nodePath) { throw 'Node.js 24 or newer is required.' }
  [System.IO.Directory]::CreateDirectory((Join-Path $projectDir 'storage')) | Out-Null
  $appProcess = Start-Process -FilePath $nodePath -ArgumentList @('--env-file-if-exists=.dev.vars','storage/vps-release/server.mjs') -WorkingDirectory $projectDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $projectDir 'storage\local-server.log') -RedirectStandardError (Join-Path $projectDir 'storage\local-server-error.log') -PassThru
  [System.IO.File]::WriteAllText((Join-Path $projectDir 'storage\local-server.pid'), [string]$appProcess.Id)
  for ($attempt=0; $attempt -lt 45; $attempt++) {
    Start-Sleep -Milliseconds 1000
    try { $configResult=Invoke-RestMethod -Uri 'http://127.0.0.1:3002/api/config' -TimeoutSec 1; if ($configResult.application -eq 'cet-writing') { $alreadyRunning=$true; break } } catch {}
  }
}
if (-not $alreadyRunning) { throw 'The local website did not become ready. Check storage/local-server-error.log.' }
Start-Process 'http://127.0.0.1:3002'
Write-Output 'Writing studio is ready at http://127.0.0.1:3002'
