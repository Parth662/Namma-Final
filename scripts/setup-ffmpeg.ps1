# Helper to register FFmpeg in User PATH
$bin = "C:\Users\parth\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg.Essentials_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0.1-essentials_build\bin"
$p = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not $p.Contains($bin)) {
    [Environment]::SetEnvironmentVariable("Path", "$p;$bin", "User")
    Write-Host "[PATH] Added FFmpeg to User PATH"
}

# Output verification
& "$bin\ffmpeg.exe" -version | Select-Object -First 2
& "$bin\ffprobe.exe" -version | Select-Object -First 2
