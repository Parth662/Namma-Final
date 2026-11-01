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
- [ ] **Step 5:** Adaptive keyframe selection (~4 fps, ≤ 960 px, drop dark/blurry, keep when feature match < 60%, 0.25-2s gap, cap at MAX_FRAMES, non-black first frame).
- [ ] **Step 6:** Configurable matching strategy (sequential vs exhaustive automatic selection).
- [ ] **Step 7:** Offline vocabulary tree evaluation.
- [ ] **Step 8:** Benchmark on `big.mp4` (60 frames + exhaustive, 80 frames + sequential overlap 15, baseline).
- [ ] **Step 9:** Keep best config as default and document rationale in `docs/BENCHMARKS.md`.

## Phase C — Mapper & Partial-Result Honesty
- [ ] **Step 10:** Tune mapper thresholds for difficult features.
- [ ] **Step 11:** Multi-model handling (keep largest, test merger/alignment, report discarded points).
- [ ] **Step 12:** Partial-result honesty (<40% registered or >1 large piece -> mark `partial`, clear UI tips, disable nav until shell succeeds).

## Phase D — Output & Viewer
- [ ] **Step 13:** Viewer default layer: coloured point cloud with size slider, toggles for Mesh & Shell, auto-frame, proper lighting, Flat/Unlit.
- [ ] **Step 14:** Meshing: Poisson depth 8-9, conservative density trimming, remove tiny disconnected components.
- [ ] **Step 15:** Export `metrics.json` per project, UI metrics panel showing real values, source label, inferred %.

## Phase E — Structural Shell & Floor Plan
- [ ] **Step 16:** Plane detection (RANSAC: floor, ceiling, vertical walls with Manhattan alignment & fallback).
- [ ] **Step 17:** 2D floor plan with Shapely (wall lines, unary_union, polygonize, make_valid, area, perimeter, measured vs inferred).
- [ ] **Step 18:** Shell geometry extrusion (floor-plan edges extruded to ceiling, flat wall panels, export `shell.glb`).
- [ ] **Step 19:** Viewer toggle Mesh / Points / Shell, "Inferred" badge on shell elements.
- [ ] **Step 20:** Export `floorplan.geojson` in local metric coordinates.
- [ ] **Step 21:** Guards & unit tests (synthetic box, L-shaped, noisy, missing wall).

## Phase F — Navigation on the Floor Plan
- [ ] **Step 22:** Walkable area from floor polygon minus obstacles inflated by agent radius.
- [ ] **Step 23:** POI snapping and validation with Shapely.
- [ ] **Step 24:** A* validation inside walkable polygon; tests.

## Phase G — Optional: Place the Twin on Leaflet Map
- [ ] **Step 25:** Optional `geo` anchor `{lat, lng, headingDegrees}` with PATCH endpoint and pin/slider UI.
- [ ] **Step 26:** Convert local metres to WGS84 with `pyproj` and render on Leaflet.
- [ ] **Step 27:** Document limits in `docs/GEO.md`.

## Phase H — Optional: Remote GPU Engine
- [ ] **Step 28:** Remote engine support (`RECON_ENGINE_URL` + `ENGINE_API_KEY`).
- [ ] **Step 29:** `docs/COLAB_ENGINE.md` & `colab/engine_server.py`.
- [ ] **Step 30:** Research evaluation on MVS / depth estimation.
- [ ] **Step 31:** Provider switch in config and health check.

## Phase I — Quality, Docs, Safety
- [ ] **Step 32:** Unit & integration test pass, benchmark summary with screenshots.
- [ ] **Step 33:** Docs: `docs/CAPTURE_GUIDE.md`, update architecture/README/etc.
- [ ] **Step 34:** Security pass (auth, ownership, path sanitization).
- [ ] **Step 35:** Final report.
