$ErrorActionPreference = 'Stop'

$script:DataMcpTaskName = 'AI-Data-MCP'
$script:DataMcpHost = '127.0.0.1'
$script:DataMcpPort = 17890
$script:DataMcpHealthUrl = "http://${script:DataMcpHost}:${script:DataMcpPort}/health"
$script:DataMcpPluginRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$script:DataMcpEntryPoint = [IO.Path]::GetFullPath((Join-Path $script:DataMcpPluginRoot 'dist\index.js'))
$script:DataMcpBackgroundLauncher = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'run-service.vbs'))

function Get-DataMcpHealth {
    try {
        $health = Invoke-RestMethod -Uri $script:DataMcpHealthUrl -Method Get -TimeoutSec 2
        $version = (Get-Content -LiteralPath (Join-Path $script:DataMcpPluginRoot 'package.json') -Raw | ConvertFrom-Json).version
        if ($health.name -eq 'data-mcp-server' -and $health.version -eq $version) {
            return $health
        }
        return $null
    }
    catch {
        return $null
    }
}

function Wait-DataMcpHealth {
    param([int]$TimeoutSeconds = 20)

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $health = Get-DataMcpHealth
        if ($null -ne $health -and $health.status -eq 'ok') {
            return $health
        }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)

    throw "Data MCP did not become healthy within $TimeoutSeconds seconds."
}

function Get-DataMcpServiceProcesses {
    return @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
        $commandLine = $_.CommandLine
        -not [string]::IsNullOrWhiteSpace($commandLine) -and
        $commandLine.IndexOf($script:DataMcpEntryPoint, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $commandLine -match '(?i)(?:^|\s)--transport=http(?:\s|$)'
    })
}

function Stop-DataMcpServiceProcesses {
    foreach ($process in Get-DataMcpServiceProcesses) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
}
