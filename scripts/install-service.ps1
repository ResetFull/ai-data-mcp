. (Join-Path $PSScriptRoot 'service-common.ps1')

$listeners = @(Get-NetTCPConnection -LocalPort $script:DataMcpPort -State Listen -ErrorAction SilentlyContinue)
$ownedPids = @(Get-DataMcpServiceProcesses | ForEach-Object ProcessId)
if (@($listeners | Where-Object { $_.OwningProcess -notin $ownedPids }).Count -gt 0) {
    throw "The Data MCP port is occupied by another process. Stop or reconfigure that service before installing; no process was stopped."
}

if (-not (Test-Path -LiteralPath $script:DataMcpEntryPoint -PathType Leaf)) {
    throw "Build output not found at '$script:DataMcpEntryPoint'. Run npm run build first."
}
if (-not (Test-Path -LiteralPath $script:DataMcpBackgroundLauncher -PathType Leaf)) {
    throw "Background launcher not found at '$script:DataMcpBackgroundLauncher'."
}

$nodePath = (Get-Command node -CommandType Application -ErrorAction Stop).Source
$wscriptPath = [IO.Path]::GetFullPath((Join-Path $env:WINDIR 'System32\wscript.exe'))
if (-not (Test-Path -LiteralPath $wscriptPath -PathType Leaf)) {
    throw "Windows Script Host not found at '$wscriptPath'."
}
$token = [Environment]::GetEnvironmentVariable('DATA_MCP_HTTP_TOKEN', 'User')
if ([string]::IsNullOrWhiteSpace($token)) {
    $bytes = [byte[]]::new(32)
    $random = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $random.GetBytes($bytes)
    }
    finally {
        $random.Dispose()
    }
    $token = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    [Environment]::SetEnvironmentVariable('DATA_MCP_HTTP_TOKEN', $token, 'User')
}
$env:DATA_MCP_HTTP_TOKEN = $token

$existingTask = Get-ScheduledTask -TaskName $script:DataMcpTaskName -ErrorAction SilentlyContinue
if ($null -ne $existingTask -and $existingTask.State -ne 'Ready') {
    Stop-ScheduledTask -TaskName $script:DataMcpTaskName
}
Stop-DataMcpServiceProcesses

$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction `
    -Execute $wscriptPath `
    -Argument "//B //NoLogo `"$script:DataMcpBackgroundLauncher`" `"$nodePath`" `"$script:DataMcpEntryPoint`"" `
    -WorkingDirectory $script:DataMcpPluginRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -Hidden `
    -StartWhenAvailable

Register-ScheduledTask `
    -TaskName $script:DataMcpTaskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description 'Shared loopback Data MCP service for Codex tasks.' `
    -Force | Out-Null

Start-ScheduledTask -TaskName $script:DataMcpTaskName
$health = Wait-DataMcpHealth
Write-Output "Data MCP service installed and healthy. PID=$($health.pid), URL=http://${script:DataMcpHost}:${script:DataMcpPort}/mcp"
Write-Output 'Restart Codex once so the desktop process inherits DATA_MCP_HTTP_TOKEN.'
