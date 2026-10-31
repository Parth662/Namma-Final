# Specification vs. Actual Codebase Audit (`docs/SPEC_VS_CODE.md`)
**Project:** Namma Space (IIT Bombay Techfest 2026-27 Challenge)  
**Audit Date:** October 31, 2026  
**Auditor:** Antigravity Engineering Agent  

---

## 1. Executive Summary

This document details every architectural, structural, and behavioral difference between the prompt specification (Section 2 & guidelines) and the actual files found in the provided workspace (`c:\Users\parth\Desktop\namma F\namma`).

As mandated by Rule 5: **"Trust the code, tell me about the difference."**

---

## 2. Component-by-Component Comparison

| Area | Prompt Specification (Section 2) | Actual Code in Zip | Impact / Action Required |
| :--- | :--- | :--- | :--- |
| **Frontend Framework** | Standard React + React Three Fiber / Three.js web application. | Cross-platform **Expo (SDK 58) / React Native Web** application using `react-native-web`, `react-native-webview`, and vanilla `three.js`. | Keep Expo/React Native Web structure. Extend `DigitalTwinViewer.web.js` with Orbit + First-Person walkthrough controls rather than introducing an incompatible framework. |
| **Auth UI (`<AuthPage />`)** | Section 1 references an existing Login/Register page exposing `<AuthPage onLogin={...} onRegister={...} onGoogle={...} />`. | **`AuthPage` does not exist anywhere in the code.** `App.js` directly mounts `<CameraScreen />` in a container view. `CameraScreen.js` auto-registers a temporary surveyor account (`surveyor_<timestamp>@digitaltwin.app`) upon capture upload. | Implement `<AuthPage>` component matching the specified props API and wire it to Express auth routes with session persistence in `App.js`. |
| **Python Engine Framework** | Section 0 states: *"Keep its stack... Do not swap in FastAPI, Postgres or another framework unless I approve it."* | The Python reconstruction engine in `backend/python-service/main.py` is **already built using FastAPI** (`FastAPI`, `CORSMiddleware`, Pydantic models). | Retain and extend FastAPI in `backend/python-service`. Do not rewrite in Flask. |
| **Python Engine Port** | Section 2.1 & 6E state the Python engine runs at `http://127.0.0.1:5002/api/reconstruct`. | `python-service/main.py` runs on port **8000** (`uvicorn.run(app, host="0.0.0.0", port=8000)`), while `backend/.env` and `environment.js` point to port **5002**. | Align ports: configure `main.py` and `backend/.env` to use `PORT 5002` (configurable via `PORT` or `PYTHON_ENGINE_PORT`). |
| **Python Environment & OS Paths** | Expected to run locally on the developer's machine. | `python-service/venv` is a **macOS virtual environment** (`venv/bin/python`, missing Windows `Scripts\python.exe`). `.env` and `pipeline.py` hardcode macOS Homebrew paths (`/opt/homebrew/bin/colmap`). | Windows requires a fresh Windows virtual environment or global Python 3.13 packages, and dynamic path resolution for Windows executables (`colmap.exe`, `ffmpeg.exe`). |
| **BullMQ Worker Lifecycle** | Section 2.3 & 6D: BullMQ worker should run as an isolated process separate from API server (`npm run worker`). | `backend/src/server.js` calls `startReconstructionWorker()` directly on server boot, while `reconstruction.worker.js` also has a standalone entrypoint. Running both would create redundant worker consumers. | Refactor `server.js` to decouple the worker unless explicitly started, allowing standalone `npm run worker` execution. |
| **Progress & Stage Reporting** | Section 6B specifies Socket.IO events: `queue:position`, `job:stage`, `job:completed`, `job:failed` with exact stage names: `uploaded → queued → probing → frames → features → matching → sfm → meshing → export → completed`. | Backend currently emits only `reconstruction_progress` with stages `FRAME ANALYSIS` (15%) and `DIGITAL TWIN READY` (100%). Frontend ignores Socket.IO and **polls** `GET /api/projects/:id/status`. | Update backend worker to emit the required Socket.IO events and stage taxonomy; update frontend with a real Socket.IO consumer stepper screen. |
| **Navigation & POI Stack** | Sections 7 & 8 specify RANSAC floor alignment, calibration (`metersPerUnit`), occupancy grid, A* pathfinder, and MongoDB `pois` collection. | None of these endpoints, schemas, or algorithms exist in the zip. | Implement navigation algorithms in Python engine and expose endpoints via Node API (`/api/projects/:id/calibrate`, `/navgrid`, `/path`, `/pois`). |
| **Pre-baked Demo Models** | Section 4.4 requires a pre-baked demo scene for 100% demo reliability. | The workspace **already includes** real reconstructed GLBs in `storage/projects/sample_digital_twin/final/scene.glb` (207 KB) and `storage/projects/6ae4d0269f5dd7264fb8c79e/final/scene.glb` (704 KB) plus thumbnails and raw MP4 video uploads. | Use existing `sample_digital_twin` as the pre-baked demo scene for the instant "Demo Mode" fallback button. |

---

## 3. Package Script & Security Audit

- **`backend/package.json`**:
  - Scripts: `start`, `dev`, `worker`, `test`.
  - Lifecycle scripts: **No `preinstall`, `postinstall`, or `prepare` scripts.**
  - Dependencies: `bcryptjs`, `bullmq`, `cors`, `dotenv`, `express`, `helmet`, `ioredis`, `jsonwebtoken`, `mongoose`, `morgan`, `multer`, `socket.io`.
  - Security finding: No obfuscation or suspicious dependencies. All dependencies match standard production libraries.
- **`frontend/package.json`**:
  - Scripts: `start`, `android`, `ios`, `web`.
  - Lifecycle scripts: **No `preinstall`, `postinstall`, or `prepare` scripts.**
  - Dependencies: Expo SDK 58, React 19.3.0, React Native 0.88.1, Three 0.186.1, Leaflet 1.9.4.

---

## 4. Environment Variables Audit

| Variable | In `.env` | In `environment.js` | Status / Correction Needed |
| :--- | :--- | :--- | :--- |
| `PORT` | 5001 | 5000 (fallback) | API is on 5001. Frontend expects 5001. Keep 5001. |
| `MONGODB_URI` | `mongodb://127.0.0.1:27017/digital_twin_db` | Same | Verified working with local MongoDB service. |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Same | Redis not currently running; BullMQ fails until Redis is active. |
| `PYTHON_SERVICE_URL` | `http://127.0.0.1:5002` | Same | `main.py` defaults to 8000. Needs update to 5002. |
| `COLMAP_PATH` | `/opt/homebrew/bin/colmap` | `/opt/homebrew/bin/colmap` | Invalid on Windows. Needs Windows binary or dynamic resolution. |
| `MAX_IMAGE_SIZE`, `MAX_FRAMES`, `FRAME_FPS`, `WORKER_CONCURRENCY` | Not present | Not present | Must be added for Section 6 hardening. |
