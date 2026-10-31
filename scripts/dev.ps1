# ==============================================================================
# NAMMA SPACE — Unified Development Stack Orchestrator (scripts/dev.ps1)
# Launches & health-checks MongoDB, Redis, Python 3D Engine, Node API, Worker, & Expo
# ==============================================================================

param (
    [switch]$CheckOnly = $false,
    [switch]$NoFrontend = $false,
    [switch]$MockReconstruction = $true
)

$ErrorActionPreference = "Continue"
$rootDir = Split-Path -Parent $PSScriptRoot
$backendDir = Join-Path $rootDir "namma\backend"
$pythonDir = Join-Path $backendDir "python-service"
$frontendDir = Join-Path $rootDir "namma\frontend"
$redisBin = Join-Path $backendDir "tools\redis\redis-server.exe"
$redisCli = Join-Path $backendDir "tools\redis\redis-cli.exe"
$pythonExe = Join-Path $pythonDir "venv\Scripts\python.exe"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "       NAMMA SPACE - 3D DIGITAL TWIN SYSTEM DEV STACK     " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. MongoDB Check
Write-Host ""
Write-Host "[1/6] Checking MongoDB (127.0.0.1:27017)... " -NoNewline
try {
    $tcp = New-Object System.Net.Sockets.TcpClient
    $tcp.Connect("127.0.0.1", 27017)
    $tcp.Close()
    Write-Host "[ONLINE]" -ForegroundColor Green
} catch {
    Write-Host "[OFFLINE]" -ForegroundColor Red
    Write-Warning "MongoDB is not running on 127.0.0.1:27017. Please start the MongoDB service."
}

# 2. Redis Check & Start
Write-Host "[2/6] Checking Redis (127.0.0.1:6379)... " -NoNewline
$redisRunning = $false
try {
    $tcp = New-Object System.Net.Sockets.TcpClient
    $tcp.Connect("127.0.0.1", 6379)
    $tcp.Close()
    $redisRunning = $true
    Write-Host "[ONLINE]" -ForegroundColor Green
} catch {
    Write-Host "[OFFLINE]" -ForegroundColor Yellow
}

if ((-not $redisRunning) -and (-not $CheckOnly)) {
    if (Test-Path $redisBin) {
        Write-Host "      Starting Redis background server..." -ForegroundColor Cyan
        Start-Process -FilePath $redisBin -ArgumentList "--bind 127.0.0.1 --port 6379" -WindowStyle Hidden
        Start-Sleep -Seconds 2
        try {
            $tcp = New-Object System.Net.Sockets.TcpClient
            $tcp.Connect("127.0.0.1", 6379)
            $tcp.Close()
            Write-Host "      Redis is now ONLINE." -ForegroundColor Green
        } catch {
            Write-Warning "Failed to start Redis automatically."
        }
    } else {
        Write-Warning "Redis binary not found at $redisBin."
    }
}

# 3. Python Reconstruction Engine Check
Write-Host "[3/6] Checking Python 3D Engine (127.0.0.1:5002)... " -NoNewline
$pyRunning = $false
try {
    $res = Invoke-RestMethod -Uri "http://127.0.0.1:5002/health" -Method Get -TimeoutSec 2 -ErrorAction Stop
    if ($res.status -eq "ok") {
        $pyRunning = $true
        Write-Host "[ONLINE]" -ForegroundColor Green
    }
} catch {
    Write-Host "[OFFLINE]" -ForegroundColor Yellow
}

$pyProc = $null
if ((-not $pyRunning) -and (-not $CheckOnly)) {
    if (Test-Path $pythonExe) {
        Write-Host "      Starting Python FastAPI Engine (PORT 5002)..." -ForegroundColor Cyan
        $env:PORT = "5002"
        $env:HOST = "127.0.0.1"
        if ($MockReconstruction) {
            $env:MOCK_RECONSTRUCTION = "1"
            Write-Host "      [MEMORY-SAFE] Mock / Pre-baked mode active" -ForegroundColor Magenta
        }
        $pyProc = Start-Process -FilePath $pythonExe -ArgumentList "main.py" -WorkingDirectory $pythonDir -PassThru -WindowStyle Hidden
        Start-Sleep -Seconds 3
        try {
            $res = Invoke-RestMethod -Uri "http://127.0.0.1:5002/health" -Method Get -TimeoutSec 3 -ErrorAction Stop
            Write-Host "      Python 3D Engine is now ONLINE." -ForegroundColor Green
        } catch {
            Write-Warning "Python service started awaiting startup..."
        }
    } else {
        Write-Warning "Python venv not found at $pythonExe."
    }
}

# 4. Node Backend API Check
Write-Host "[4/6] Checking Node Backend API (127.0.0.1:5001)... " -NoNewline
$nodeRunning = $false
try {
    $res = Invoke-RestMethod -Uri "http://127.0.0.1:5001/api/health" -Method Get -TimeoutSec 2 -ErrorAction Stop
    if ($res.status -eq "ok") {
        $nodeRunning = $true
        Write-Host "[ONLINE]" -ForegroundColor Green
    }
} catch {
    Write-Host "[OFFLINE]" -ForegroundColor Yellow
}

$nodeProc = $null
if ((-not $nodeRunning) -and (-not $CheckOnly)) {
    Write-Host "      Starting Node Backend API (PORT 5001)..." -ForegroundColor Cyan
    $nodeProc = Start-Process -FilePath "node" -ArgumentList "src/server.js" -WorkingDirectory $backendDir -PassThru -WindowStyle Hidden
    Start-Sleep -Seconds 3
    try {
        $res = Invoke-RestMethod -Uri "http://127.0.0.1:5001/api/health" -Method Get -TimeoutSec 3 -ErrorAction Stop
        Write-Host "      Node Backend API is now ONLINE." -ForegroundColor Green
    } catch {
        Write-Warning "Node Backend started awaiting startup..."
    }
}

# 5. Reconstruction Worker Check
Write-Host "[5/6] Checking Reconstruction Worker... " -NoNewline
$workerProc = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -match "node" -and $_.CommandLine -match "reconstruction.worker.js" }
if ($workerProc) {
    Write-Host "[ONLINE]" -ForegroundColor Green
} else {
    Write-Host "[OFFLINE]" -ForegroundColor Yellow
    if (-not $CheckOnly) {
        Write-Host "      Starting Reconstruction Worker process..." -ForegroundColor Cyan
        $workerProc = Start-Process -FilePath "node" -ArgumentList "src/workers/reconstruction.worker.js" -WorkingDirectory $backendDir -PassThru -WindowStyle Hidden
        Start-Sleep -Seconds 2
        Write-Host "      Worker started." -ForegroundColor Green
    }
}

# 6. Expo Web Frontend Check
Write-Host "[6/6] Checking Expo Web Frontend (127.0.0.1:8081)... " -NoNewline
$expoRunning = $false
try {
    $tcp = New-Object System.Net.Sockets.TcpClient
    $tcp.Connect("127.0.0.1", 8081)
    $tcp.Close()
    $expoRunning = $true
    Write-Host "[ONLINE]" -ForegroundColor Green
} catch {
    Write-Host "[OFFLINE]" -ForegroundColor Yellow
}

$expoProc = $null
if ((-not $expoRunning) -and (-not $CheckOnly) -and (-not $NoFrontend)) {
    Write-Host "      Starting Expo Web Frontend..." -ForegroundColor Cyan
    $expoProc = Start-Process -FilePath "npx.cmd" -ArgumentList "expo start --web" -WorkingDirectory $frontendDir -PassThru -WindowStyle Minimized
    Write-Host "      Expo Web Frontend launched." -ForegroundColor Green
}

Write-Host ""
Write-Host "----------------------------------------------------------" -ForegroundColor Cyan
if ($CheckOnly) {
    Write-Host "Health check completed." -ForegroundColor Cyan
} else {
    Write-Host "All stack services are initialized." -ForegroundColor Green
    Write-Host "Node API:     http://127.0.0.1:5001"
    Write-Host "Python API:   http://127.0.0.1:5002"
    Write-Host "Expo Web:     http://127.0.0.1:8081"
}
Write-Host "----------------------------------------------------------" -ForegroundColor Cyan
Write-Host ""
