# Independent, temporary validation tunnel. Never stop or reconfigure any existing tunnels.
param([string]$Cloudflared = "$env:LOCALAPPDATA\personal-hot\cloudflared.exe")
$ErrorActionPreference = "Stop"
$taskNewsRepo = Split-Path $PSScriptRoot -Parent
$taskNewsRuntime = Join-Path $taskNewsRepo ".runtime"
$taskNewsState = Join-Path $taskNewsRuntime "data\operations\reading-tunnel.json"
if (!(Test-Path -LiteralPath $Cloudflared)) { throw "cloudflared executable not found" }
if (Test-Path -LiteralPath $taskNewsState) {
    $taskNewsSaved = Get-Content -LiteralPath $taskNewsState -Raw | ConvertFrom-Json
    $taskNewsRunning = Get-Process -Id $taskNewsSaved.pid -ErrorAction SilentlyContinue
    if ($taskNewsRunning -and $taskNewsRunning.Path -eq $Cloudflared -and $taskNewsRunning.StartTime.ToUniversalTime().ToString("o") -eq $taskNewsSaved.started) {
        Write-Output "The independent reading tunnel is already running; inspect its existing log."
        exit 0
    }
}
$taskNewsCheck = $null
for ($taskNewsAttempt = 0; $taskNewsAttempt -lt 10; $taskNewsAttempt++) {
    try { $taskNewsCheck = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:3002/daily/preview/ai" -TimeoutSec 2; break }
    catch { Start-Sleep -Milliseconds 500 }
}
if ($taskNewsCheck.StatusCode -ne 200) { throw "The loopback reading listener is not ready" }
$taskNewsOut = Join-Path $taskNewsRuntime "logs\reading-cloudflared.out.log"
$taskNewsErr = Join-Path $taskNewsRuntime "logs\reading-cloudflared.err.log"
$taskNewsProcess = Start-Process -FilePath $Cloudflared -ArgumentList @("--no-autoupdate", "tunnel", "--url", "http://127.0.0.1:3002", "--protocol", "quic") -WindowStyle Hidden -RedirectStandardOutput $taskNewsOut -RedirectStandardError $taskNewsErr -PassThru
$taskNewsProcess.PriorityClass = "BelowNormal"
New-Item -ItemType Directory -Force -Path (Split-Path $taskNewsState -Parent) | Out-Null
@{ pid=$taskNewsProcess.Id; started=$taskNewsProcess.StartTime.ToUniversalTime().ToString("o"); purpose="temporary reading preview" } | ConvertTo-Json | Set-Content -LiteralPath $taskNewsState -Encoding UTF8
Write-Output "Independent temporary reading tunnel started. PID=$($taskNewsProcess.Id). Address is in reading-cloudflared.err.log."
