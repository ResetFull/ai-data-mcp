. (Join-Path $PSScriptRoot 'service-common.ps1')

$task = Get-ScheduledTask -TaskName $script:DataMcpTaskName -ErrorAction SilentlyContinue
if ($null -ne $task) {
    Stop-ScheduledTask -TaskName $script:DataMcpTaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $script:DataMcpTaskName -Confirm:$false
}
Stop-DataMcpServiceProcesses
Write-Output 'AI-Data-MCP service removed. External configuration and the shared DATA_MCP_HTTP_TOKEN were preserved.'
