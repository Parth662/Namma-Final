# Namma Space — Photorealistic 3D Digital Twin Platform

Namma Space reconstructs real-world physical locations into immersive, walk-through 3D digital twins from standard mobile camera video footage using photogrammetry, Open3D surface meshing, BullMQ job queues, and Three.js.

---

## Architecture Overview

```
                      +-----------------------------+
                      |   Expo React Native Web     |
                      |   (DigitalTwinViewer, Three)  |
                      +--------------+--------------+
                                     |
                                HTTP / Socket.IO
                                     v
                      +-----------------------------+
                      |       Node.js Express       |
                      |     (Auth, Projects, API)   |
                      +--------------+--------------+
                                     |
                     +---------------+---------------+
                     |                               |
                     v                               v
             +---------------+               +---------------+
             | Redis 5 / 6   |               | MongoDB       |
             | (BullMQ Queue)|               | (Metadata)    |
             +-------+-------+               +---------------+
                     |
                     v
             +---------------+
             | Node Worker   |
             +-------+-------+
                     | HTTP POST /api/reconstruct
                     v
+-----------------------------------------------------------+
|               Python 3D Photogrammetry Engine             |
|   (FastAPI, OpenCV blur filter, COLMAP SfM, Open3D, GLB)  |
+-----------------------------------------------------------+
```

---

## System Requirements (Windows 11 / x64)

- **Operating System:** Windows 10/11 x64
- **Node.js:** v18+ or v20+
- **Python:** 3.10 to 3.13 (with 64-bit C++ runtime)
- **MongoDB:** Local on `mongodb://127.0.0.1:27017`
- **Redis:** Local on `127.0.0.1:6379` (included in `backend/tools/redis`)
- **FFmpeg:** Installed via Winget (`winget install Gyan.FFmpeg`)
- **COLMAP:** Windows no-CUDA build (included in `backend/tools/colmap`)

---

## Clean Machine Setup (PowerShell)

### 1. Toolchain Setup
Run the automated setup scripts in PowerShell (Run as Administrator or Developer Mode):
```powershell
# 1. Install / link FFmpeg
powershell -ExecutionPolicy Bypass -File scripts/setup-ffmpeg.ps1

# 2. Download and unpack native Windows Redis
powershell -ExecutionPolicy Bypass -File scripts/setup-redis.ps1

# 3. Download and unpack Windows COLMAP (no CUDA)
powershell -ExecutionPolicy Bypass -File scripts/setup-colmap.ps1

# 4. Create Python venv and install dependencies
powershell -ExecutionPolicy Bypass -File scripts/setup-python-venv.ps1
```

### 2. Install Node Dependencies
```powershell
cd namma/backend
npm install

cd ../frontend
npm install
```

### 3. Environment Configuration
Copy `.env.example` to `.env` in `namma/backend`:
```powershell
cp namma/backend/.env.example namma/backend/.env
```

---

## Running the Development Stack

### Orchestrated Launch (Recommended)
```powershell
powershell -ExecutionPolicy Bypass -File scripts/dev.ps1
```
Or to run a stack health check without starting background processes:
```powershell
powershell -ExecutionPolicy Bypass -File scripts/dev.ps1 -CheckOnly
```

### Manual Individual Services
1. **Start Redis:**
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts/start-redis.ps1
   ```
2. **Start Python 3D Engine (Port 5002):**
   ```powershell
   cd namma/backend/python-service
   venv\Scripts\python.exe main.py
   ```
3. **Start Node API Server (Port 5001):**
   ```powershell
   cd namma/backend
   npm run dev
   ```
4. **Start Reconstruction Worker:**
   ```powershell
   cd namma/backend
   npm run worker
   ```
5. **Start Frontend (Port 8081):**
   ```powershell
   cd namma/frontend
   npm run web
   ```

---

## Offline Demo Mode & Pre-Baked Digital Twin

For rapid offline testing and zero-overhead demonstrations without running COLMAP:
1. **Seed Offline Demo Scene & POIs:**
   ```powershell
   node scripts/seed-demo.js
   ```
   This populates MongoDB with the **Namma Space Innovation Quad** pre-baked model (`scene.glb`), 7 realistic spatial POIs, and precomputed 2D navigation grid.
2. **Access Offline Demo:**
   - API: `GET http://localhost:5001/api/demo` (unauthenticated)
   - Frontend: Click **"🎮 Try Demo Mode"** in the viewer header to instantly explore the 3D twin, 2D mini-map, and walking routes.

---

## Running the Automated Test Suites

```powershell
# 1. Python Floor Alignment, Occupancy Grid & A* Pathfinding Unit Tests
$env:PYTHONPATH = "namma\backend\python-service"; & "namma\backend\python-service\venv\Scripts\python.exe" -m unittest namma/backend/python-service/tests/test_navigation.py

# 2. Phase 1 & 2 Core Platform Integration Tests
node namma/backend/test_phase1_phase2.js

# 3. Phase 4 Navigation, Line-of-Sight Smoothing, and Scale Calibration Tests
node namma/backend/test_phase4_navigation.js

# 4. Phase 5 Points of Interest (POIs) CRUD & Ranked Text Search Tests
node namma/backend/test_phase5_poi.js
```

---

## Memory-Safe Development & Testing

When running on resource-constrained devices (e.g. 8 GB RAM integrated graphics):
- Set `MOCK_RECONSTRUCTION=1` or submit video paths containing `mock` or `temp_test`.
- The engine will serve pre-baked high-fidelity 3D digital twins (`sample_digital_twin/final/scene.glb`) instantaneously without maxing CPU or RAM.
- Real photogrammetry reconstruction can be performed on demand with reduced frame count (`MAX_FRAMES=30`, `scale=960:-1`).
