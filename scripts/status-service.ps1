. (Join-Path $PSScriptRoot 'service-common.ps1')

$task = Get-ScheduledTask -TaskName $script:DataMcpTaskName -ErrorAction SilentlyContinue
$health = Get-DataMcpHealth
[pscustomobject]@{
    TaskInstalled = $null -ne $task
    TaskState = if ($null -eq $task) { 'NotInstalled' } else { [string]$task.State }
    Healthy = $null -ne $health -and $health.status -eq 'ok'
    Pid = if ($null -eq $health) { $null } else { $health.pid }
    UptimeSeconds = if ($null -eq $health) { $null } else { $health.uptime_seconds }
    Url = "http://${script:DataMcpHost}:${script:DataMcpPort}/mcp"
}
