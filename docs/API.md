# NAMMA SPACE — REST API Reference

All requests requiring authentication accept a Bearer JWT token in the `Authorization: Bearer <token>` header.

---

## 1. Projects & Assets

### `POST /api/projects`
Creates a new space reconstruction project.
- **Auth:** Required
- **Body:** `{ "name": "Bedroom 102", "description": "Master bedroom", "locationName": "Building A" }`

### `GET /api/projects`
Lists all projects owned by the authenticated user.
- **Auth:** Required

### `GET /api/projects/:id`
Retrieves a project's details, status, and metadata.
- **Auth:** Required (or public if demo)

### `GET /api/projects/:id/model`
Fetches 3D model asset URLs (`scene.glb`, `shell.glb`, `floorplan.geojson`, `metrics.json`, `thumbnail.jpg`) and bounding box.
- **Auth:** Required (or public if demo)
- **Response:**
  ```json
  {
    "projectId": "6ae...",
    "status": "completed",
    "isPartial": false,
    "model": {
      "format": "glb",
      "url": "/storage/projects/6ae.../final/scene.glb",
      "shellUrl": "/storage/projects/6ae.../final/shell.glb",
      "floorplanUrl": "/storage/projects/6ae.../final/floorplan.geojson",
      "metricsUrl": "/storage/projects/6ae.../final/metrics.json"
    },
    "geo": { "lat": 12.9716, "lng": 77.5946, "headingDegrees": 45 },
    "bounds": { "minX": -2.4, "minY": 0.0, "minZ": -1.8, "maxX": 2.4, "maxY": 2.5, "maxZ": 1.8 }
  }
  ```

---

## 2. Capture Coach & Pre-check

### `POST /api/projects/:id/coach`
Evaluates uploaded video quality before queueing heavy photogrammetry.
- **Auth:** Required
- **Response:**
  ```json
  {
    "success": true,
    "score": 88,
    "status": "good",
    "metrics": {
      "averageBrightness": 92.5,
      "averageSharpness": 405.8,
      "averageKeypoints": 475.3,
      "averageMotionScore": 0.205,
      "blurryFrameRatio": 0.05
    },
    "tips": [
      { "timeRange": "00:12 - 00:16", "type": "motion_blur", "message": "Fast camera rotation detected; moving slower helps feature tracking." }
    ],
    "hopeless": false
  }
  ```

---

## 3. Structural Shell & Floor Plan

### `GET /api/projects/:id/floorplan`
Returns 2D room boundary polygon with area, perimeter, and measured vs inferred wall segments.
- **Query Params:** `?wgs84=true` (transforms metric coordinates into planetary WGS84 `[lng, lat]` using project's geo anchor)
- **Response:** GeoJSON `FeatureCollection` in local meters or WGS84 coordinates.

### `GET /api/projects/:id/metrics`
Returns photogrammetry and structural metrics for the reconstruction.
- **Response:**
  ```json
  {
    "registeredFrames": 79,
    "totalExtractedFrames": 80,
    "registeredRatio": 0.9875,
    "sparsePoints": 13927,
    "meshVertices": 42322,
    "meshTriangles": 82096,
    "meshComponents": 3,
    "detectedPlanes": { "floor": true, "ceiling": false, "walls": 4 },
    "shell": { "area_sqm": 18.4, "perimeter_m": 17.6, "ceiling_height_m": 2.6, "inferred_percentage": 0.0 },
    "source": "photogrammetry",
    "status": "completed"
  }
  ```

---

## 4. Geographic Placement

### `PATCH /api/projects/:id/geo`
Sets or updates the planetary coordinate anchor and True North rotation.
- **Auth:** Required
- **Body:**
  ```json
  {
    "lat": 12.9716,
    "lng": 77.5946,
    "headingDegrees": 45.0
  }
  ```

---

## 5. Navigation & Pathfinding

### `GET /api/projects/:id/navgrid`
Returns the 2D occupancy grid, walkable area boundaries, and mini-map wall segments.

### `GET /api/projects/:id/path?from=x,y,z&to=x,y,z`
Calculates 8-connected A* obstacle-free path with line-of-sight smoothing.
- **Response:**
  ```json
  {
    "found": true,
    "distanceMeters": 6.4,
    "walkingEtaSeconds": 4.9,
    "walkingEtaFormatted": "00:05",
    "path": [{ "x": -2.0, "y": 0.0, "z": 1.0 }, { "x": 1.5, "y": 0.0, "z": -1.2 }]
  }
  ```

---

## 6. Points of Interest (POIs)

### `GET /api/projects/:id/pois`
Lists all POIs in the space. Filter by `?q=` or `?category=`.

### `POST /api/projects/:id/pois`
Creates a new POI marker anchored in 3D metric coordinates. Automatically snaps to walkable floor area.
- **Body:** `{ "name": "Desk 1", "category": "workstation", "position": { "x": 1.2, "y": 0.4, "z": -0.8 } }`

