. (Join-Path $PSScriptRoot 'service-common.ps1')

$health = Get-DataMcpHealth
if ($null -ne $health -and $health.status -eq 'ok') {
    Write-Output "Data MCP service is already healthy. PID=$($health.pid)"
    exit 0
}

$task = Get-ScheduledTask -TaskName $script:DataMcpTaskName -ErrorAction SilentlyContinue
if ($null -eq $task) {
    throw "Scheduled task '$script:DataMcpTaskName' is not installed. Run npm run service:install."
}
Start-ScheduledTask -TaskName $script:DataMcpTaskName
$health = Wait-DataMcpHealth
Write-Output "Data MCP service started. PID=$($health.pid)"
