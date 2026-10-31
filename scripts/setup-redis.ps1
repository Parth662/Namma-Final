$ErrorActionPreference = "Stop"

$toolsDir = "C:\Users\parth\Desktop\namma F\namma\backend\tools\redis"
if (-not (Test-Path $toolsDir)) {
    New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
}

$serverExe = Join-Path $toolsDir "redis-server.exe"

if (-not (Test-Path $serverExe)) {
    $zipPath = Join-Path $toolsDir "redis.zip"
    Write-Host "[Redis] Downloading official tporadowski/redis 5.0.14.1 Windows release..."
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri "https://github.com/tporadowski/redis/releases/download/v5.0.14.1/Redis-x64-5.0.14.1.zip" -OutFile $zipPath
    Write-Host "[Redis] Extracting to $toolsDir..."
    Expand-Archive -Path $zipPath -DestinationPath $toolsDir -Force
    Remove-Item $zipPath -Force
}

Write-Host "[Redis] Installed files:"
Get-ChildItem $toolsDir | Select-Object Name
