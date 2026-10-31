# Start Redis Server bound strictly to 127.0.0.1:6379
$toolsDir = "C:\Users\parth\Desktop\namma F\namma\backend\tools\redis"
$serverExe = Join-Path $toolsDir "redis-server.exe"
$cliExe = Join-Path $toolsDir "redis-cli.exe"

$existing = Get-Process -Name "redis-server" -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "[Redis] Already running with PID $($existing.Id)."
} else {
    Write-Host "[Redis] Starting redis-server on 127.0.0.1:6379..."
    Start-Process -FilePath $serverExe -ArgumentList "--bind 127.0.0.1 --port 6379" -WorkingDirectory $toolsDir -WindowStyle Hidden
    Start-Sleep -Seconds 2
}

# Verify with PING
$response = & $cliExe -h 127.0.0.1 -p 6379 PING
Write-Host "[Redis] Verification response: $response"
if ($response -eq "PONG") {
    Write-Host "[Redis] READY and responding to PING on 127.0.0.1:6379."
} else {
    Write-Error "[Redis] Failed to receive PONG response."
}
