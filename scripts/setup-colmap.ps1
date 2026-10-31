$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$toolsDir = "C:\Users\parth\Desktop\namma F\namma\backend\tools\colmap"
if (-not (Test-Path $toolsDir)) {
    New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
}

$colmapExe = Join-Path $toolsDir "colmap.bat"
$colmapBin = Join-Path $toolsDir "bin\colmap.exe"

if (-not (Test-Path $colmapExe) -and -not (Test-Path $colmapBin)) {
    Write-Host "[COLMAP] Fetching release metadata for COLMAP 3.9.1 / 3.8..."
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/colmap/colmap/releases" -Headers @{ "User-Agent" = "Antigravity-Agent" }
    
    # Find Windows no-cuda zip asset
    $targetAsset = $null
    foreach ($rel in $release) {
        foreach ($asset in $rel.assets) {
            if ($asset.name -match "windows.*no-cuda.*\.zip$" -or $asset.name -match "windows.*nocuda.*\.zip$") {
                $targetAsset = $asset
                break
            }
        }
        if ($targetAsset) { break }
    }

    if (-not $targetAsset) {
        # Fallback to direct known 3.8 or 3.9.1 release asset
        Write-Host "[COLMAP] Searching specific tag 3.8..."
        $rel38 = Invoke-RestMethod -Uri "https://api.github.com/repos/colmap/colmap/releases/tags/3.8" -Headers @{ "User-Agent" = "Antigravity-Agent" }
        foreach ($asset in $rel38.assets) {
            if ($asset.name -match "windows-no-cuda") {
                $targetAsset = $asset
                break
            }
        }
    }

    if ($targetAsset) {
        Write-Host "[COLMAP] Selected asset: $($targetAsset.name) ($([math]::Round($targetAsset.size / 1MB, 2)) MB)"
        Write-Host "[COLMAP] Downloading from $($targetAsset.browser_download_url)..."
        $zipFile = Join-Path $toolsDir "colmap.zip"
        Invoke-WebRequest -Uri $targetAsset.browser_download_url -OutFile $zipFile
        Write-Host "[COLMAP] Extracting archive..."
        Expand-Archive -Path $zipFile -DestinationPath $toolsDir -Force
        Remove-Item $zipFile -Force
    } else {
        Write-Error "[COLMAP] Could not locate Windows no-CUDA release zip."
    }
}

# Find colmap executable inside $toolsDir
$found = Get-ChildItem -Path $toolsDir -Recurse -Filter "colmap.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
$batFound = Get-ChildItem -Path $toolsDir -Recurse -Filter "colmap.bat" -ErrorAction SilentlyContinue | Select-Object -First 1

if ($batFound) {
    Write-Host "[COLMAP] Found batch launcher at $($batFound.FullName)"
    & $batFound.FullName -h | Select-Object -First 4
} elseif ($found) {
    Write-Host "[COLMAP] Found executable at $($found.FullName)"
    & $found.FullName -h | Select-Object -First 4
} else {
    Write-Host "[COLMAP] Tools directory contents:"
    Get-ChildItem $toolsDir -Recurse | Select-Object FullName
}
