# NAMMA SPACE — IMPLEMENTATION PLAN (`docs/IMPLEMENTATION_PLAN.md`)
**Competition:** Techfest 2026-27 (IIT Bombay)  
**Challenge:** End-to-end Pipeline: Indoor Smartphone Video → 3D Walkthrough + POI Search + Pathfinding  
**Auditor:** Antigravity Senior Full-Stack & Computer Vision Pair Engineer  
**Date:** October 31, 2026  
**Status:** PHASE 0 COMPLETED — WAITING FOR USER APPROVAL  

---

## 1. System Audit & Hardware Detection

### 1.1 Detected Hardware & Host Environment
- **Operating System:** Windows 11 Home Single Language (Version 10.0.26300, x64)
- **CPU / RAM:** 8 GB Total Visible RAM (~7.68 GB, **~950 MB Free** at idle)
- **GPU:** **Intel(R) UHD Graphics (Integrated GPU)** — **NO NVIDIA GPU, NO CUDA**
- **Disk Space:**
  - `C:\`: **34.46 GB free** (out of 196.5 GB)
  - `D:\`: **126.89 GB free** (out of 126.9 GB)
- **Node.js:** `v24.16.0` (Verified)
- **Python:** `Python 3.13.0` (Verified)
- **Package Manager:** `winget v1.29.380` available

### 1.2 Toolchain & Service Audit

| Component | Status | Port / Path | Action Required |
| :--- | :--- | :--- | :--- |
| **MongoDB** | **RUNNING** | Port `27017` (Windows Service: `MongoDB Server`) | Ready for use. No changes needed. |
| **Redis** | **NOT RUNNING** | Port `6379` (`ECONNREFUSED`) | Install/run Redis on Windows (winget `redis-windows-fork` or lightweight runner). |
| **FFmpeg** | **NOT IN PATH** | Command `ffmpeg` not found | Install via winget (`Gyan.FFmpeg.Essentials`) or standalone binaries. |
| **COLMAP** | **NOT IN PATH** | macOS Homebrew path in code | Install Windows release binary or use CPU fallback & pre-baked scene. |
| **Docker** | **NOT INSTALLED** | N/A | Must run services directly on Windows without Docker. |
| **Python Service** | **BROKEN VENV** | macOS Unix venv (`bin/python`) | Recreate Windows virtual environment or install dependencies in Python 3.13. |

---

## 2. Realistic Reconstruction Performance & Honest Estimates

### 2.1 The Hard Truth About Hardware Capabilities
1. **No CUDA Acceleration:**
   COLMAP with CUDA uses GPU SIFT extraction and matching, taking ~10–20 seconds for 60 frames. On this machine, **COLMAP will run 100% on CPU** using single/multi-threaded CPU SIFT.
2. **RAM Bottleneck (8 GB Total, ~1 GB Free):**
   Heavy Poisson surface meshing (`depth=9`) or unconstrained matching on 100+ frames can trigger Windows page-file thrashing or `MemoryError`.
3. **Multi-Worker Reality on 1 Laptop:**
   Increasing worker concurrency to 2+ on this laptop will **degrade** performance rather than speed it up, because COLMAP CPU and OpenCV will contend for the same CPU cores and limited RAM.
4. **Honest Time Estimates on This Machine:**
   - **Video Probing & Quality Filtering (FFmpeg + OpenCV):** ~5–12 seconds
   - **COLMAP SIFT Feature Extraction (CPU, 60 frames @ 1280px):** ~30–50 seconds
   - **COLMAP Sequential Feature Matching (CPU):** ~20–40 seconds
   - **COLMAP Incremental Mapper (SfM):** ~25–60 seconds
   - **Open3D Normal Estimation & Meshing (Poisson depth 8 / Ball Pivoting):** ~10–25 seconds
   - **GLB Export & Bounding Box:** ~3–5 seconds
   - **Total Reconstruction Time per job:** **~90 to 180 seconds (~1.5 to 3 minutes)**
5. **Mitigation Strategy (Guaranteed Stage Reliability):**
   - Enforce hard limits via environment variables: `MAX_FRAMES=60`, `MAX_IMAGE_SIZE=1280`, `FRAME_FPS=2`.
   - Implement early rejection before COLMAP runs (reject videos with no motion, extreme blur, or darkness in < 5 seconds).
   - Implement **Demo Mode** featuring the pre-baked model (`sample_digital_twin`), guaranteeing instant (< 1 second) loading if live processing takes too long or fails on stage.

---

## 3. What Exists vs. What Is Broken or Missing

### 3.1 Existing & Functional
- **MongoDB Database Models:** `User`, `Project`, and `ReconstructionJob` are cleanly defined with Mongoose.
- **Backend API Skeleton:** Express with Helmet, CORS, Morgan, JWT authentication, and file upload endpoints.
- **FastAPI Python Engine:** `pipeline.py` implements complete frame extraction, blur filtering, COLMAP SfM, and Open3D/Trimesh meshing.
- **Frontend 3D Viewer:** `DigitalTwinViewer.web.js` has a Three.js scene setup with orbital navigation and GLTF loading.
- **Pre-baked 3D Models:** Reconstructed GLB models and sample videos already exist in `storage/` and `uploads/`.

### 3.2 Broken or Misconfigured
- **Redis Connection:** BullMQ cannot enqueue or process jobs because Redis is down.
- **Python Virtual Environment:** macOS Unix binaries cannot execute on Windows.
- **Port Conflict:** Node backend calls `http://127.0.0.1:5002`, but `main.py` runs on `8000`.
- **Hardcoded macOS Paths:** `COLMAP_PATH=/opt/homebrew/bin/colmap` fails on Windows.
- **Worker Duplication:** `backend/src/server.js` boots the worker in-process, preventing clean standalone scaling.

### 3.3 Missing Features (Challenge Deliverables)
- **Authentication Page UI:** `<AuthPage>` component referenced in Section 1 is absent.
- **Honest Queue UX:** BullMQ worker does not report queue position, rolling ETA, or the required 10 stage names over Socket.IO.
- **Job Timeout & Early Rejection:** No runtime cap on stuck COLMAP processes; no ffprobe early motion check.
- **Model Alignment & Scale Calibration:** Model coordinates are uncalibrated; no real-world `metersPerUnit` or RANSAC floor fit.
- **Occupancy Grid & Pathfinding:** No geometry rasterization, 2D navigation grid, or A* pathfinding.
- **POIs Collection & Search:** No `pois` MongoDB collection, no search endpoint, and no interactive 3D placement raycasting.
- **Interactive Walkthrough:** Viewer only supports orbit controls, missing First-Person WASD + collision controls.

---

## 4. Adjusted Phase-by-Phase Roadmap

### Phase 1 — Run the Baseline Pipeline End-to-End
1. Install and start Redis for Windows on port 6379.
2. Install FFmpeg in PATH and verify with `ffmpeg -version`.
3. Set up a functional Python environment on Windows with `fastapi`, `uvicorn`, `open3d`, `trimesh`, `opencv-python`, and `pydantic`.
4. Fix `python-service` port to `5002` and ensure health check passes (`GET /health`).
5. Run existing integration tests (`node test_phase1_phase2.js`) to verify:
   - Health check
   - User register / login
   - Project creation
   - Video upload
   - BullMQ reconstruction queueing & status retrieval
6. Run one real video through the pipeline from upload to `scene.glb` export.
7. Record baseline execution time on this machine.

### Phase 2 — Queue & Worker Hardening (Section 6)
1. **Configurable Limits (Fix 4):**
   Add `.env` options: `MAX_IMAGE_SIZE=1280`, `MAX_FRAMES=60`, `FRAME_FPS=2`, `JOB_TIMEOUT_MS=300000`.
2. **Early Rejection Engine:**
   Create pre-reconstruction validator (duration check, optical flow/motion score, Laplacian blur, keypoint density). Reject hopeless videos in < 5 seconds with friendly explanations.
3. **Queue Telemetry & Honest UX (Fix 5):**
   - Emit Socket.IO room events: `queue:position` `{ position, total, etaSeconds }`, `job:stage` `{ stage, progress, message }`, `job:completed`, `job:failed`.
   - Calculate rolling ETA using recent job durations.
   - Enforce exact stage taxonomy: `uploaded → queued → probing → frames → features → matching → sfm → meshing → export → completed`.
4. **Reliability & Cancellation:**
   - Implement active worker job timeout with subprocess process-tree killing.
   - Implement `POST /api/projects/:id/cancel`.
   - Auto-recover stalled jobs on worker boot.
5. **Worker Decoupling (Fix 2):**
   Remove embedded worker invocation from `server.js` and run as a dedicated process (`npm run worker`).
6. **Acceptance Test:**
   Build and execute `scripts/load-test.js` uploading 5 videos concurrently and verify position tracking, queue order, timeouts, and early rejection.

### Phase 3 — Reconstruction Quality & Pre-baked Demo Scene
1. Benchmark Poisson depth (8 vs 9), density trimming, and Ball Pivoting on CPU to find the best quality/speed tradeoff.
2. Create **Demo Mode**:
   Seed a permanent demo project using `sample_digital_twin/final/scene.glb` with pre-computed nav grid and sample POIs.
3. Validate that "Demo Mode" loads instantly even if Redis, COLMAP, or the Python engine are completely offline.

### Phase 4 — Navigation Pipeline (Section 7)
1. **Python Navigation Module (`python-service/navigation.py`):**
   - Floor plane detection via RANSAC plane fitting on mesh vertices; orient floor to `y = 0`, up to `+y`.
   - Scale calibration: Store `metersPerUnit` factor.
   - 2D Occupancy Grid: Slice geometry between 0.2m and 1.6m above floor, rasterize into 5 cm grid cells, and inflate obstacles by agent radius (0.25m).
   - 2D Pathfinding: 8-connected A* with path smoothing (string-pulling) returning 3D polyline waypoints, length in meters, and walking ETA.
   - Wall line extraction for clean mini-map display.
2. **Node Endpoints:**
   - `POST /api/projects/:id/calibrate` (two points + real-world distance)
   - `GET /api/projects/:id/navgrid`
   - `GET /api/projects/:id/path?from=x,y,z&to=x,y,z` (or POI IDs)
3. **Automated Unit Tests:**
   Synthetic room geometry, obstacle pathfinding, unreachable target error handling.

### Phase 5 — POIs & Search (Section 8)
1. **Mongoose POI Schema:**
   `pois`: `projectId`, `name`, `category`, `description`, `tags[]`, `position {x,y,z}`, `navPoint {x,y,z}`, `createdBy`.
2. Text index on `name`, `tags`, `category` with regex/prefix fallback.
3. Snap POIs to nearest walkable grid cell (`navPoint`).
4. Endpoints:
   - `POST /api/projects/:id/pois`
   - `GET /api/projects/:id/pois?q=`
   - `PUT /api/projects/:id/pois/:poiId`
   - `DELETE /api/projects/:id/pois/:poiId`

### Phase 6 — Frontend Integration & Auth (Sections 9 & 10)
1. Implement `src/api/client.js` with Bearer auth, token storage, and 401 refresh handling.
2. Implement `<AuthPage>` component (Login / Register forms with inline error banners and Google auth stub) and mount in `App.js`.
3. Build **Processing Stepper Screen**:
   Visual stepper showing current stage, progress percentage, queue position, ETA counter, and Cancel button.
4. Extend `DigitalTwinViewer.web.js`:
   - Dual Camera Modes: **Orbit Mode** and **First-Person Walkthrough** (WASD + pointer lock) with nav grid collision bounds.
   - Interactive POI raycasting: Click on 3D geometry to add/inspect POIs.
   - Glowing navigation path with animated marker and walking ETA.
   - 2D Mini-map overlay.
   - Prominent **Demo Mode** button for guaranteed instant demonstration.

### Phase 7 — Polish, Production & Documentation
1. Performance optimizations (GLB geometry compression, lazy loading).
2. Complete documentation: `README.md`, `docs/ARCHITECTURE.md`, `docs/GPU_DEPLOY.md`.
3. Project cleanup: ensure temporary files in `processing/` are scrubbed upon completion or failure.
4. Comprehensive end-to-end verification of the Stage Demo Script.

---

## 5. Critical Questions Before Starting Phase 1

1. **Redis Installation Preference on Windows:**
   Since Docker is not installed and WSL has no distributions, we can install Redis via `winget install taizod1024.redis-windows-fork` or use a portable `redis-server.exe` in `backend/tools/redis/`. Is it okay to proceed with the native Windows Redis package?
2. **COLMAP Binary Source:**
   Since COLMAP is not on winget, we can fetch the official precompiled Windows CPU zip release (`colmap-windows-no-cuda`) and place it in the project toolchain. Alternatively, do you have COLMAP already installed in a custom directory on your system?
3. **Approval to Proceed:**
   Once you review this audit and plan, please provide your **"Go"** to begin Phase 1 execution.
