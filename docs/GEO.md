# NAMMA SPACE — Geographic Anchoring & Coordinate Projections

## 1. Overview
Namma Space bridges local photogrammetric 3D reconstructions (defined in local metric coordinates centered at model origin $[0, 0, 0]$ with meters as units) and planetary geospatial coordinates in **WGS84** (EPSG:4326, latitude/longitude degrees).

The twin is anchored by three parameters:
- `lat`: Geographic Latitude in decimal degrees (e.g. `12.9716`)
- `lng`: Geographic Longitude in decimal degrees (e.g. `77.5946`)
- `headingDegrees`: True North azimuth rotation in degrees $[0^\circ, 360^\circ)$ where $0^\circ = \text{North}$, $90^\circ = \text{East}$, $180^\circ = \text{South}$, $270^\circ = \text{West}$.

---

## 2. Mathematical Coordinate Transformation
Local metric coordinates $(x, z)$ on the ground plane are transformed to planetary $(lon, lat)$ coordinates through a two-step transformation:

### Step 1: Heading Rotation
Given heading azimuth angle $\theta = \text{radians}(\text{headingDegrees})$:
$$\begin{bmatrix} x' \\ z' \end{bmatrix} = \begin{bmatrix} \cos\theta & -\sin\theta \\ \sin\theta & \cos\theta \end{bmatrix} \begin{bmatrix} x \\ z \end{bmatrix}$$

### Step 2: Azimuthal Equidistant (AEQD) Projection
We use an **Azimuthal Equidistant projection** (`aeqd`) centered at the project anchor $(\text{lat}_0, \text{lon}_0)$:
$$\text{Proj}_{\text{aeqd}}(\text{lat}_0, \text{lon}_0, \text{datum}=\text{WGS84})$$
Local forward coordinates $(x', z')$ in meters are converted directly into $(\text{lon}, \text{lat})$:
$$(\text{lon}, \text{lat}) = \text{Proj}_{\text{aeqd}}^{-1}(x', z')$$

### Approximation Accuracy
- Over room and building scales ($< 100$ meters from the anchor), the geodesic distortion of the AEQD projection is **less than $0.1\text{ mm}$**.
- This is orders of magnitude more accurate than the photogrammetric reconstruction accuracy ($1$–$2\text{ cm}$) and standard GPS accuracy ($3$–$5\text{ m}$).

---

## 3. Real-World Limitations & Error Budget

### A. Indoor GPS Drift & Attenuation
- **Problem:** Satellite GNSS/GPS signals (L1/L5) cannot penetrate reinforced concrete, metal roofing, or multi-story structures. Indoor smartphone fixes suffer from multipath reflections and dilution of precision (PDOP).
- **Impact:** Raw phone GPS coordinates captured indoors often drift by **$5$ to $25\text{ meters}$**.
- **Mitigation:** Namma Space allows manual pin-placement via the interactive Leaflet map interface, enabling the surveyor to anchor the twin to the exact building outline or room location visible on satellite imagery.

### B. Magnetometer / Compass Inaccuracy
- **Problem:** Phone magnetometers are distorted by indoor structural steel beams, high-voltage wiring, HVAC conduits, and reinforced concrete rebar.
- **Impact:** Electronic compass heading readings inside rooms can be off by **$10^\circ$ to $45^\circ$**.
- **Mitigation:** The surveyor uses the 360° heading slider in the Leaflet Map Placement tool to align the 2D floor plan walls to the building's known exterior walls or street orientation.

### C. Scale Indeterminacy in Monocular Photogrammetry
- **Problem:** Pure monocular SfM (Structure-from-Motion) is scale-invariant (it reconstructs up to an arbitrary scale factor $\lambda$).
- **Mitigation:** Namma Space includes a two-point metric calibration tool (`POST /api/projects/:id/calibrate`) and standard architectural height assumptions (e.g., standard door height $2.0\text{ m}$ / ceiling height $2.6\text{ m}$) to pin scale to true metric meters.
