# Manage the named connector independently of both existing Quick Tunnels.
param(
    [ValidateSet('Configure', 'Start', 'Status')][string]$Action = 'Status',
    [string]$Cloudflared = "$env:LOCALAPPDATA\personal-hot\cloudflared.exe",
    [int[]]$Ports = @(3002)
)
$ErrorActionPreference = 'Stop'
$taskNewsTunnelRoot = Join-Path (Split-Path $PSScriptRoot -Parent) '.runtime\cloudflare'
$taskNewsTunnelPrivate = Join-Path $taskNewsTunnelRoot 'private'
$taskNewsTunnelTokenFile = Join-Path $taskNewsTunnelPrivate 'tunnel-token.txt'
$taskNewsTunnelStateFile = Join-Path $taskNewsTunnelRoot 'connector.json'

function Get-NewsTunnelTokenId([string]$Value) {
    try {
        if ($Value.Length -lt 40 -or $Value.Length -gt 4096 -or $Value -notmatch '^[A-Za-z0-9+/=]+$') { throw 'invalid' }
        $taskPayload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Value)) | ConvertFrom-Json
        $taskId = [Guid]::Parse($taskPayload.t)
        if ($taskPayload.a -notmatch '^[a-fA-F0-9]{32}$' -or !$taskPayload.s -or $taskId -eq [Guid]::Empty) { throw 'invalid' }
        return $taskId.ToString()
    } catch { throw 'Invalid tunnel token. Paste only the token, not the installation command.' }
}

function Protect-NewsTunnelDirectory([string]$Directory) {
    New-Item -ItemType Directory -Force -Path $Directory | Out-Null
    $taskSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $taskAcl = New-Object Security.AccessControl.DirectorySecurity
    # Preserve the existing owner. Setting it again requests WRITE_OWNER, which
    # ordinary accounts may lack on D: even when they can change the DACL.
    $taskAcl.SetAccessRuleProtection($true, $false)
    $taskRule = New-Object Security.AccessControl.FileSystemAccessRule($taskSid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $taskAcl.AddAccessRule($taskRule)
    [IO.Directory]::SetAccessControl($Directory, $taskAcl)
}

function Get-NewsTunnelProcess {
    if (!(Test-Path -LiteralPath $taskNewsTunnelStateFile)) { return $null }
    $taskSaved = Get-Content -LiteralPath $taskNewsTunnelStateFile -Raw | ConvertFrom-Json
    $taskRunning = Get-Process -Id $taskSaved.pid -ErrorAction SilentlyContinue
    if (!$taskRunning -or $taskRunning.Path -ne $Cloudflared -or $taskRunning.StartTime.ToUniversalTime().ToString('o') -ne $taskSaved.started) { return $null }
    $taskCommand = (Get-CimInstance Win32_Process -Filter "ProcessId=$($taskRunning.Id)").CommandLine
    if (!$taskCommand.Contains('--token-file') -or !$taskCommand.Contains($taskNewsTunnelTokenFile)) { return $null }
    return $taskRunning
}

# Dot sourcing exposes the pure token validator for offline checks without running a connector.
if ($MyInvocation.InvocationName -eq '.') { return }

$taskStage = 'check-existing-connector'
try {
    if ($Action -eq 'Configure') {
        if (Get-NewsTunnelProcess) { throw 'The named connector is running. Stop it deliberately before replacing its token.' }
        $taskStage = 'hidden-input'
        $taskSecure = Read-Host 'Paste only the tunnel token (hidden input)' -AsSecureString
        $taskPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($taskSecure)
        try {
            $taskToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($taskPointer).Trim()
            $taskStage = 'validate-token'
            $taskTunnelId = Get-NewsTunnelTokenId $taskToken
            $taskStage = 'protect-token-directory'
            Protect-NewsTunnelDirectory $taskNewsTunnelPrivate
            $taskTemporary = Join-Path $taskNewsTunnelPrivate ([Guid]::NewGuid().ToString() + '.tmp')
            try {
                $taskStage = 'save-token-file'
                [IO.File]::WriteAllText($taskTemporary, $taskToken, (New-Object Text.UTF8Encoding($false)))
                Move-Item -LiteralPath $taskTemporary -Destination $taskNewsTunnelTokenFile -Force
            } finally { if (Test-Path -LiteralPath $taskTemporary) { Remove-Item -LiteralPath $taskTemporary } }
        } finally {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskPointer)
            $taskToken = $null
            $taskSecure.Dispose()
        }
        Write-Output "Token saved with Windows user-only permissions. Tunnel ID: $taskTunnelId. No connector started."
        exit 0
    }
    $taskProcess = Get-NewsTunnelProcess
    if ($Action -eq 'Status') {
        [pscustomobject]@{ configured = (Test-Path -LiteralPath $taskNewsTunnelTokenFile); running = [bool]$taskProcess; pid = $(if ($taskProcess) { $taskProcess.Id } else { $null }) } | ConvertTo-Json -Compress
        exit 0
    }
    if ($taskProcess) { Write-Output "Named connector already running. PID=$($taskProcess.Id)."; exit 0 }
    if (!(Test-Path -LiteralPath $Cloudflared) -or !(Test-Path -LiteralPath $taskNewsTunnelTokenFile)) { throw 'cloudflared or local token file is missing.' }
    $taskStage = 'check-local-listeners'
    foreach ($taskPort in $Ports) {
        $taskSocket = New-Object Net.Sockets.TcpClient
        try {
            $taskConnect = $taskSocket.ConnectAsync('127.0.0.1', $taskPort)
            if (!$taskConnect.Wait(3000) -or !$taskSocket.Connected) { throw "Local listener $taskPort is unavailable." }
        } finally { $taskSocket.Dispose() }
    }
    # Ignore inherited tunnel credentials/settings; all connector inputs are explicit.
    $taskInfo = New-Object Diagnostics.ProcessStartInfo
    $taskInfo.FileName = $Cloudflared
    # A separate hidden Windows console avoids inheriting the caller's terminal pipes.
    $taskInfo.UseShellExecute = $true
    $taskInfo.WindowStyle = 'Hidden'
    $taskLogs = Join-Path $taskNewsTunnelRoot 'logs'
    New-Item -ItemType Directory -Force -Path $taskLogs | Out-Null
    # Routine log rotation is handled by cloudflared (1 MB, up to five backups).
    $taskInfo.Arguments = 'tunnel --no-autoupdate --protocol quic --metrics 127.0.0.1:20302 --loglevel info --log-directory "' + $taskLogs + '" run --token-file "' + $taskNewsTunnelTokenFile + '"'
    $taskSavedEnvironment = @{}
    foreach ($taskVariable in @(Get-ChildItem Env:)) {
        if ($taskVariable.Name -like 'TUNNEL_*' -or $taskVariable.Name -in @('NO_AUTOUPDATE', 'GOMAXPROCS')) {
            $taskSavedEnvironment[$taskVariable.Name] = $taskVariable.Value
            [Environment]::SetEnvironmentVariable($taskVariable.Name, $null, 'Process')
        }
    }
    $taskStage = 'start-connector'
    try {
        [Environment]::SetEnvironmentVariable('GOMAXPROCS', '2', 'Process')
        $taskProcess = [Diagnostics.Process]::Start($taskInfo)
    } finally {
        [Environment]::SetEnvironmentVariable('GOMAXPROCS', $null, 'Process')
        foreach ($taskName in $taskSavedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($taskName, $taskSavedEnvironment[$taskName], 'Process') }
    }
    $taskStage = 'save-connector-state'
    $taskProcess.PriorityClass = 'BelowNormal'
    @{ pid = $taskProcess.Id; started = $taskProcess.StartTime.ToUniversalTime().ToString('o'); purpose = 'personal-hot named connector' } | ConvertTo-Json | Set-Content -LiteralPath $taskNewsTunnelStateFile -Encoding UTF8
    Start-Sleep -Seconds 2
    if ($taskProcess.HasExited) { throw 'Named connector exited. Check its local log; do not share tokens or raw configuration.' }
    Write-Output "Named connector started. PID=$($taskProcess.Id). Existing Quick Tunnels remain running. Check Healthy in Cloudflare."
} catch {
    # Do not render exceptions carrying user input or upstream configuration.
    if ($_.Exception.Message -match '^(Invalid tunnel token|The named connector|cloudflared or local|Local listener|Named connector exited)') { [Console]::Error.WriteLine($_.Exception.Message) }
    else {
        $taskFailure = $_.Exception
        if ($taskFailure.InnerException) { $taskFailure = $taskFailure.InnerException }
        [Console]::Error.WriteLine("Connector action failed at $taskStage ($($taskFailure.GetType().Name), code=$($taskFailure.HResult)). No token is printed.")
    }
    exit 1
}
