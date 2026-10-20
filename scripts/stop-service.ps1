. (Join-Path $PSScriptRoot 'service-common.ps1')

$task = Get-ScheduledTask -TaskName $script:DataMcpTaskName -ErrorAction SilentlyContinue
if ($null -ne $task -and $task.State -ne 'Ready') {
    Stop-ScheduledTask -TaskName $script:DataMcpTaskName
}
Stop-DataMcpServiceProcesses

$deadline = [DateTime]::UtcNow.AddSeconds(10)
do {
    if ($null -eq (Get-DataMcpHealth)) {
        Write-Output 'Data MCP service stopped.'
        exit 0
    }
    Start-Sleep -Milliseconds 250
} while ([DateTime]::UtcNow -lt $deadline)

throw 'Data MCP service did not stop within 10 seconds.'
