# 3D Mesh Quality Tuning & Photogrammetry Optimization (`docs/QUALITY.md`)

## 1. Overview

Reconstructing photorealistic, walk-through digital twins on consumer hardware requires balancing geometric fidelity, color accuracy, and memory constraints. This document details the surface reconstruction pipeline and parameter tuning.

---

## 2. Geometry Pipeline & Quality Tuning

```
+---------------------------------------+
|   COLMAP Sparse Point Cloud (PLY)     |
+-------------------+-------------------+
                    |
                    v
+---------------------------------------+
| Statistical Outlier Removal (Open3D)  | (nb_neighbors=20, std_ratio=2.0)
+-------------------+-------------------+
                    |
                    v
+---------------------------------------+
|  Normal Estimation & Tangent Plane    | (KDTree radius=0.5m, max_nn=30)
+-------------------+-------------------+
                    |
                    v
+---------------------------------------+
|   Screened Poisson Surface Meshing    | (Octree depth=8; balances detail vs RAM)
+-------------------+-------------------+
                    |
                    v
+---------------------------------------+
|  Density Trimming (Quantile 5%)       | (Strips hollow non-manifold boundary faces)
+-------------------+-------------------+
                    |
                    v
+---------------------------------------+
| KD-Tree Vertex Color Transfer         | (Preserves authentic photographic colors)
+-------------------+-------------------+
                    |
                    v
+---------------------------------------+
|   Centered GLB Export (Trimesh)       | (Coordinate normalization, Y-up)
+---------------------------------------+
```

---

## 3. Algorithm Comparisons & Fallbacks

| Method | Strengths | Weaknesses | When Applied |
|---|---|---|---|
| **Screened Poisson (depth=8)** | Watertight, smooth surfaces, robust to sparse noise | Can create phantom bubbles in unobserved space | Default when points >= 100 |
| **Quantile Density Trimming (5%)** | Eliminates low-confidence Poisson boundary artifacts | None | Applied after Poisson |
| **Ball Pivoting Algorithm (BPA)** | Conforms tightly to exact point samples | Sensitive to varying point density | Automatic fallback if Poisson yields < 50 triangles |
| **KD-Tree Color Transfer** | Crisp vertex coloring matched to original footage | Limited to vertex density | Always applied before GLB export |

---

## 4. Parameter Recommendations for Quality

1. **Octree Depth:** Depth 8 provides an optimal balance for 8 GB RAM systems (~100,000 – 300,000 faces). Depth 9+ increases memory exponentially and is reserved for dedicated 16 GB+ GPU nodes.
2. **Density Filter Threshold:** 0.05 (5th percentile) reliably removes ballooning artifacts without deleting valid thin walls.
3. **Capture Guidance:** Walk slowly in an arc around the subject with 60%+ visual overlap between consecutive frames. Avoid pivoting in place without translation.
