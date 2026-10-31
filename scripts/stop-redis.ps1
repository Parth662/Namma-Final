# Stop background redis-server process cleanly
$proc = Get-Process -Name "redis-server" -ErrorAction SilentlyContinue
if ($proc) {
    Write-Host "[Redis] Stopping redis-server PID $($proc.Id)..."
    Stop-Process -Id $proc.Id -Force
    Write-Host "[Redis] Stopped successfully."
} else {
    Write-Host "[Redis] No running redis-server process found."
}
