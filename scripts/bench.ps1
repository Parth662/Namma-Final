# NAMMA SPACE — Benchmark Wrapper (PowerShell)
param (
    [Parameter(Mandatory=$true)]
    [string]$Video,
    [string]$ConfigName = "baseline",
    [string]$Matching = "",
    [int]$MaxFrames = 0,
    [string]$BenchFile = ""
)

$rootDir = Split-Path -Parent $PSScriptRoot
$pythonExe = Join-Path $rootDir "namma\backend\python-service\venv\Scripts\python.exe"
$benchPy = Join-Path $PSScriptRoot "bench.py"

$cmdArgs = @($benchPy, "--video", $Video, "--config-name", $ConfigName)
if ($Matching) {
    $cmdArgs += @("--matching", $Matching)
}
if ($MaxFrames -gt 0) {
    $cmdArgs += @("--max-frames", $MaxFrames)
}
if ($BenchFile) {
    $cmdArgs += @("--bench-file", $BenchFile)
}

& $pythonExe $cmdArgs

