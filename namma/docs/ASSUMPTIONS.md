# Project Assumptions (`docs/ASSUMPTIONS.md`)
**Project:** Namma Space (IIT Bombay Techfest 2026-27 Challenge)  
**Date:** October 31, 2026  

---

## 1. Architectural & Technology Assumptions

1. **Frontend Framework Choice:**
   - The prompt mentioned a React + R3F web app, but the actual repository contains an **Expo / React Native Web** project with `Screens/CameraScreen.js`, `Screens/DigitalTwinViewer.web.js` (Three.js WebGL canvas), and `Screens/GeospatialMapScreen.web.js` (Leaflet).
   - **Assumption:** We preserve and extend the existing React Native Web + Three.js viewer codebase, implementing `<AuthPage>` in React Native Web syntax so it works seamlessly in both mobile and web builds.

2. **Python Service Framework:**
   - `python-service/main.py` is already implemented using **FastAPI** with Pydantic request models.
   - **Assumption:** We keep FastAPI as the source of truth for the Python engine and align the ports to `5002` to match Node's `PYTHON_SERVICE_URL`.

3. **Redis on Windows:**
   - Redis is not natively installed or running on port 6379, causing BullMQ queue connection failures.
   - **Assumption:** For local execution on this Windows machine without Docker/WSL, we can run a lightweight native Windows Redis server (e.g. `taizod1024.redis-windows-fork` via winget, or a portable `redis-server.exe`, or `redis-memory-server` in development mode) so BullMQ and the worker operate seamlessly.

4. **Hardware & COLMAP Execution:**
   - The detected hardware is an Intel UHD Graphics laptop (8 GB RAM, no NVIDIA GPU, no CUDA).
   - **Assumption:** Live COLMAP runs on this machine will run in CPU mode with strict caps (`MAX_IMAGE_SIZE=1280`, `MAX_FRAMES=40-60`, `FRAME_FPS=2`) to prevent CPU starvation and out-of-memory crashes.
   - **Demo Guarantee:** Because COLMAP on CPU takes 60-180 seconds and sparse SfM may produce noisy meshes under suboptimal lighting, the **pre-baked demo scene** (`storage/projects/sample_digital_twin/final/scene.glb`) will be immediately loadable via a prominent "Demo Mode" button in the UI, guaranteeing that the stage presentation will never fail.

5. **Authentication & Public Projects:**
   - The challenge requires public access for stage demos while protecting owner edits.
   - **Assumption:** Demo projects will be marked `isPublic: true` allowing viewers to inspect models, search POIs, and calculate navigation routes without requiring authentication.
