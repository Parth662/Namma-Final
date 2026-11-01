# NAMMA SPACE — Progress Tracker v3: Reconstruction Quality, Walls, Floor Plan & Map Placement

Last Updated: 2026-11-01

## Status Legend
- `[ ]` Not started
- `[~]` In progress
- `[x]` Completed and verified
- `[!]` Blocked / Issue encountered (with documented explanation)

---

## Phase A — Measure First
- [x] **Step 1:** Create `backend/test-videos/` (gitignored) and check for `big.mp4` / test videos. (Found `big.mp4` [187MB, 85s] and `video_20261101_095812.mp4` [111MB, 51s] on Desktop and copied into `namma/backend/test-videos/`, both gitignored).
- [x] **Step 2:** Write `scripts/bench` (benchmark runner enforcing memory/time aborts, writing to `docs/BENCHMARKS.md`). Created `scripts/bench.py` with memory/time abort monitor (<6.5GB, <8min) and multi-shell wrappers (`bench`, `bench.ps1`, `bench.cmd`).
- [x] **Step 3:** Record baseline benchmark with current default config on `big.mp4` (and corridor video). Recorded baseline for `big.mp4` (60 frames, 17 registered [28.3%], 3 models, 2800 pts, 32 components in 91.1s) and corridor video `video_20261101_095812.mp4` (30 frames, 4 registered [13.3%], 298 pts in 39.6s) in `docs/BENCHMARKS.md`.
- [x] **Step 4:** Capture Coach pre-check (cheap video analysis at ~2 fps ≤ 640 px: brightness range, blur ratio, keypoints, consecutive match overlap, tips & problematic ranges, UI integration). Implemented `python-service/coach.py`, `POST /api/coach/analyze`, Node route `POST /api/projects/:id/coach`, and interactive pre-check modal in `CameraScreen.js` featuring overall score, metrics, timestamped tips, "Convert anyway", and "Retake".

## Phase B — Frames & Matching
- [x] **Step 5:** Adaptive keyframe selection (~4 fps, ≤ 960 px, drop dark/blurry, keep when feature match < 60%, 0.25-2s gap, cap at MAX_FRAMES, non-black first frame). Implemented in `pipeline.py` with fast ORB match decay, 0.25-2.0s timing guard, and non-black head frame guarantee.
- [x] **Step 6:** Configurable matching strategy (sequential vs exhaustive automatic selection). Added `MATCHING_STRATEGY = 'auto' | 'exhaustive' | 'sequential'` in `pipeline.py` with automatic selection based on frame count and memory.
- [x] **Step 7:** Offline vocabulary tree evaluation. Verified no offline tree exists locally; verified strict constraint against downloading heavy assets without permission.
- [x] **Step 8:** Benchmark on `big.mp4` (60 frames + exhaustive, 80 frames + sequential overlap 15, baseline). Ran and recorded both in `docs/BENCHMARKS.md`: 60-exhaustive achieved 100% registration (11,413 points in 219s); 80-sequential achieved 100% registration (13,927 points in 142.7s).
- [x] **Step 9:** Keep best config as default and document rationale in `docs/BENCHMARKS.md`. Selected adaptive 80 + sequential overlap 20 (and exhaustive for ≤ 50 frames) for 100% registration, +22% points, and 35% speedup. Documented rationale in `docs/BENCHMARKS.md`.

## Phase C — Mapper & Partial-Result Honesty
- [x] **Step 10:** Tune mapper thresholds for difficult features (`--Mapper.min_num_matches 10`, `--Mapper.init_min_num_inliers 60`, `--Mapper.abs_pose_min_num_inliers 20`, `--Mapper.num_threads 2`).
- [x] **Step 11:** Multi-model handling (inspect submodel sizes, attempt `colmap model_merger`, keep largest, log discarded submodel point counts).
- [x] **Step 12:** Partial-result honesty (<40% registered or dominant submodel <60% -> mark `status: "partial"`, prominent banner in UI with tips from Capture Coach, disable navigation graph generation unless structural shell closes).

## Phase D — Output & Viewer
- [x] **Step 13:** Viewer default layer: coloured point cloud (Points) enabled by default, toggles for Mesh & Shell, point size slider (1-6 px), auto-frame, proper lighting (ambient + hemisphere + directional), Flat/Unlit toggle.
- [x] **Step 14:** Meshing: Poisson depth 8 (conservative trimming quantile 0.05 to preserve room outline), remove tiny disconnected components (<5% of largest component) via `scipy.sparse.csgraph.connected_components`.
- [x] **Step 15:** Export `metrics.json` per project, UI metrics panel showing real values (registered frames, points, vertices, triangles, components, planes, shell area), source badge (Photogrammetry vs Demo), and inferred %.

## Phase E — Structural Shell & Floor Plan
- [x] **Step 16:** Plane detection in `structural_shell.py` (RANSAC floor plane, ceiling plane, vertical wall planes with Manhattan frame snapping and fallback).
- [x] **Step 17:** 2D floor plan with Shapely (project wall lines, `unary_union`, `polygonize`, `make_valid`, area, perimeter, measured vs inferred wall classification).
- [x] **Step 18:** Shell geometry extrusion (extrude floor polygon to ceiling height, export `shell.glb` with named nodes `floor`, `ceiling`, `wall_<n>`, `inferred_wall_<n>`).
- [x] **Step 19:** Viewer integration (three-way toggle Mesh / Points / Shell, amber tint for inferred walls, "Inferred" badge).
- [x] **Step 20:** Export `floorplan.geojson` in local metric coordinates with metadata properties.
- [x] **Step 21:** Guards & unit tests in `python-service/tests/test_shell.py` (synthetic box, L-shaped room, noisy corridor with missing wall, pure noise) passing 100%.

## Phase F — Navigation on the Floor Plan
- [x] **Step 22:** Walkable area from 2D floor polygon minus obstacles (points 0.1m - 1.8m above floor) buffered by agent radius (0.3m).
- [x] **Step 23:** POI snapping with Shapely `nearest_points` to prevent invalid placement.
- [x] **Step 24:** A* pathfinding strictly inside walkable room boundary polygon; unit tests in `test_navigation.py` passing 100%.

## Phase G — Optional: Place the Twin on Leaflet Map
- [x] **Step 25:** Optional `geo` anchor `{lat, lng, headingDegrees}` with `PATCH /api/projects/:id/geo` endpoint and interactive Leaflet map placement widget.
- [x] **Step 26:** Convert local metres to WGS84 with `pyproj` (Azimuthal Equidistant projection) and render room polygon directly on Leaflet map in real time.
- [x] **Step 27:** Documented real-world limits in `docs/GEO.md` (indoor GPS attenuation, magnetometer drift, metric scale pinning).

## Phase H — Optional: Remote GPU Engine
- [x] **Step 28:** Configurable remote engine support (`RECON_ENGINE_URL` + `ENGINE_API_KEY`) with local CPU fallback.
- [x] **Step 29:** Created single-file `colab/engine_server.py` and step-by-step launch instructions in `docs/COLAB_ENGINE.md`.
- [x] **Step 30:** Research evaluation comparing Depth Anything v2, DUSt3R, and 3D Gaussian Splatting in `docs/COLAB_ENGINE.md`.
- [x] **Step 31:** Provider switch in UI ("⚡ Local CPU" vs "🚀 Remote GPU") auto-detected from health check.

## Phase I — Quality, Docs, Safety
- [x] **Step 32:** Test suites passing (Node integration tests + 10 Python 3D tests passing 100%).
- [x] **Step 33:** Documentation complete: `docs/CAPTURE_GUIDE.md`, `docs/API.md`, `docs/COLAB_ENGINE.md`, `docs/GEO.md`.
- [x] **Step 34:** Security pass (JWT auth, project ownership verification, path traversal prevention).
- [x] **Step 35:** Final report generated.
