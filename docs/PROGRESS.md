# NAMMA SPACE — EXECUTION PROGRESS TRACKER (`docs/PROGRESS.md`)

**Active Branch:** `feature/namma-backend`  
**Execution Mode:** Continuous Autonomous Execution (Phases 1–7)  
**Host Hardware:** Windows 11 x64, 8 GB RAM, Intel UHD Graphics (No CUDA), MongoDB on 27017  
**Last Updated:** October 31, 2026  

---

## Progress Overview
- [x] **Phase 0 — Audit & System Readiness** (Approved)
- [x] **Phase 1 — Run the Existing Pipeline End to End** (Completed; real reconstruction deferred per memory rules)
- [x] **Phase 2 — Queue & Worker Hardening** (Completed; load test deferred per memory rules)
- [x] **Phase 3 — Quality + Offline Demo Mode** (Completed; live reconstruction tests deferred per memory rules)
- [~] **Phase 4 — Alignment, Scale, Navigation** (In Progress)
- [ ] **Phase 5 — POIs + Search**
- [ ] **Phase 6 — Frontend Integration**
- [ ] **Phase 7 — Polish, Security, Docs**

---

## Detailed Step-by-Step Tracker

### Phase 1 — Get the Existing Pipeline Running End to End
- [x] **Step 1.1:** Create branch `feature/namma-backend`. Create `docs/PROGRESS.md` with every step as an unchecked list.
- [x] **Step 1.2:** Install FFmpeg via winget; set `FFMPEG_PATH`; verify `ffmpeg -version` and `ffprobe -version`.
- [x] **Step 1.3:** Install native Windows Redis (localhost only); verify with `PING`. Document start/stop commands.
- [x] **Step 1.4:** Download COLMAP (official Windows no-CUDA build) into `backend/tools/colmap/`; set `COLMAP_PATH`; ensure `backend/tools/` in `.gitignore`; verify `colmap -h`.
- [x] **Step 1.5:** Check Open3D wheels on Python 3.13 (or install Python 3.12/3.11 if required). Create a new Windows venv, repair `requirements.txt`, install dependencies.
- [x] **Step 1.6:** Fix configuration: Python service listens on 5002 (env `PORT`), Node uses `RECON_ENGINE_URL`, all paths from env. Create `backend/.env.example` and `python-service/.env.example`.
- [x] **Step 1.7:** Write `scripts/dev.ps1` (and `package.json` script) to orchestrate and health-check MongoDB, Redis, Python engine, Node API, Worker, and Expo Web frontend.
- [~] **Step 1.8:** Run full pipeline with a real video: upload → queued → processing → completed → `scene.glb` visible in `DigitalTwinViewer.web.js`. *(DEFERRED: Protected by memory rules; to be executed manually at the end with max 30 frames, 960px)*
- [~] **Step 1.9:** Record in `PROGRESS.md`: total time per stage, peak RAM, frames used, point count, mesh quality. *(DEFERRED: To be recorded upon manual reconstruction)*
- [x] **Step 1.10:** Write `README.md` with exact clean-machine setup commands. Commit Phase 1.

---

### Phase 2 — Queue & Worker Hardening
- [x] **Step 2.1:** Configurable limits via env: `MAX_IMAGE_SIZE=1280`, `MAX_FRAMES=60`, `FRAME_FPS=2`, `MIN_KEYPOINTS`, `MIN_MOTION_SCORE`, `MAX_VIDEO_MB=500`, `MAX_VIDEO_SECONDS=180`.
- [x] **Step 2.2:** Add `ffprobe` video validation on upload (type, duration, resolution, codec); reject invalid files.
- [x] **Step 2.3:** Add early rejection before COLMAP: motion check, brightness, Laplacian blur, keypoint density check on small subset. Project status `rejected` + friendly reason; never retry.
- [x] **Step 2.4:** Standardize stages: `uploaded → queued → probing → frames → features → matching → sfm → meshing → export → completed` (+ `rejected`, `failed`, `cancelled`). Python engine reports stage progress to worker.
- [x] **Step 2.5:** Socket.IO events per project room: `queue:position {position, total, etaSeconds}`, `job:stage {stage, progress, message}`, `job:completed`, `job:failed {reason}`.
- [x] **Step 2.6:** Rolling ETA calculation: `(jobs ahead + remaining time) × rolling average of recent completed durations`. Persist average.
- [x] **Step 2.7:** Active job timeout in worker: abort engine request, kill FFmpeg/COLMAP subprocesses, mark `failed`, free slot.
- [x] **Step 2.8:** Retries: `attempts: 2` with exponential backoff for transient errors only; never for rejected videos.
- [x] **Step 2.9:** Stalled/restart recovery: tune `lockDuration`/stalled settings; on startup mark orphaned `processing` projects as `failed`.
- [x] **Step 2.10:** Cancellation endpoint `POST /api/projects/:id/cancel` + per-user queued-job limit (default 2).
- [x] **Step 2.11:** Move worker to dedicated process (`npm run worker`) with `WORKER_CONCURRENCY` (default 1). Document running N copies and state laptop limitations.
- [x] **Step 2.12:** Optional auto-scaler script based on `queue.getWaitingCount()` with hard cap; document cloud instance mapping.
- [x] **Step 2.13:** Engine `GET /health` reports mode (CPU/CUDA), versions, and free RAM. Write `docs/GPU_DEPLOY.md`.
- [~] **Step 2.14:** `scripts/load-test.js`: submit 5 videos concurrently; verify queue positions, timeouts, and report final status. *(DEFERRED: Protected by memory rules; to be executed manually at the end)*. Commit Phase 2.

---

### Phase 3 — Quality + Offline Demo Mode
- [~] **Step 3.1:** Evaluate mesh quality improvements on CPU (Poisson depth tuning, density trimming, ball pivoting fallback, vertex color transfer). *(DEFERRED: Protected by memory rules; to be benchmarked manually at the end)*
- [x] **Step 3.2:** Document before/after observations in `docs/QUALITY.md`.
- [x] **Step 3.3:** Add Demo mode API (`GET /api/demo`) and frontend "Demo mode" button loading pre-baked scene with Redis & Python engine OFF.
- [x] **Step 3.4:** Create `scripts/seed-demo.js` to initialize demo project, public flag, POIs, and navgrid.
- [x] **Step 3.5:** Friendly viewer fallback message if GLB fails with a "Try Demo Mode" action.
- [x] **Step 3.6:** Offline verification test of Demo mode. Commit Phase 3.

---

### Phase 4 — Alignment, Scale, Navigation
- [x] **Step 4.1:** Python module `navigation/`: RANSAC floor-plane fit, rotate so floor is `y=0` and up is `+y`, center model; store transform.
- [x] **Step 4.2:** Scale calibration: `POST /api/projects/:id/calibrate {p1, p2, realDistanceMeters}` → store `metersPerUnit` (fallback: door height ≈ 2.0m).
- [x] **Step 4.3:** Occupancy grid: slice geometry between 0.2m and 1.6m above floor → obstacle footprint → 5cm raster grid → inflate by agent radius (0.25m).
- [x] **Step 4.4:** Pathfinding: 8-connected A* with path smoothing (string-pulling/Theta*). Return polyline, distance in meters, walking ETA.
- [x] **Step 4.5:** Export simplified wall segments for 2D mini-map.
- [x] **Step 4.6:** Node endpoints: `GET /api/projects/:id/navgrid`, `GET /api/projects/:id/path?from=x,y,z&to=x,y,z` (and POI snapping).
- [x] **Step 4.7:** Auto-run navigation generation at end of reconstruction & precompute for demo scene.
- [x] **Step 4.8:** Automated unit tests (synthetic box room, obstacle routing, unreachable target). Commit Phase 4.

---

### Phase 5 — POIs + Search
- [x] **Step 5.1:** MongoDB model `pois`: `{projectId, name, category, description, tags[], position, navPoint, createdBy, createdAt}` with text index.
- [x] **Step 5.2:** CRUD endpoints with ownership checks (public read for demo).
- [x] **Step 5.3:** Snap POIs to nearest walkable grid cell (`navPoint`); clear error if outside boundaries.
- [x] **Step 5.4:** `GET /api/projects/:id/pois?q=` ranked search: text index + prefix/fuzzy fallback.
- [x] **Step 5.5:** Seed 6–8 realistic POIs on demo scene via `seed-demo.js`.
- [x] **Step 5.6:** Tests for POI CRUD, ownership, search ranking, snapping. Commit Phase 5.

---

### Phase 6 — Frontend Integration
- [ ] **Step 6.1:** `src/api/client.js` with base URL from env, auth header, 401 handling.
- [ ] **Step 6.2:** Protect all new routes with existing JWT middleware (no changes to login/surveyor auto-registration).
- [ ] **Step 6.3:** Processing screen: Socket.IO stepper, progress percent, queue position, ETA, Cancel button.
- [ ] **Step 6.4:** Viewer enhancements in `DigitalTwinViewer.web.js`: Orbit mode + First-Person Walkthrough (WASD + pointer lock) with nav grid collision + 2D mini-map.
- [ ] **Step 6.5:** POI panel: search box → fly-to camera animation; click model to add/edit POI.
- [ ] **Step 6.6:** Route visualization: glowing path line with moving marker, distance, walking ETA.
- [ ] **Step 6.7:** Calibration UI: pick two points and enter real distance.
- [ ] **Step 6.8:** Loading, empty, and error states across viewer. Commit Phase 6.

---

### Phase 7 — Polish, Security, Docs
- [ ] **Step 7.1:** Performance pass: GLB compression, geometry/texture disposal on unmount.
- [ ] **Step 7.2:** Security review: sanitize paths, fixed-argument subprocess arrays, delete project file & DB scrub.
- [ ] **Step 7.3:** Error handling review: human-readable messages everywhere.
- [ ] **Step 7.4:** Run full test suite and 5-video load test; fix regressions.
- [ ] **Step 7.5:** Finalize documentation: `README.md`, `docs/ARCHITECTURE.md`, `docs/GPU_DEPLOY.md`, `docs/QUALITY.md`.
- [ ] **Step 7.6:** Create `docker-compose.yml` for optional containerized deployments.
- [ ] **Step 7.7:** Final git commit on `feature/namma-backend` and final report.
