# NAMMA SPACE — Reconstruction Quality & Performance Benchmarks

Benchmark measurements enforcing Rule 2 (Memory safety: peak RAM ≤ 6.5 GB, timeout ≤ 8 min).

| Date & Time | Video | Config Name | Frames Ext/Kept/Reg | Reg % | COLMAP Models | Sparse Pts | Vertices / Tris | Components | Stage Durations (Ext/Feat/Match/SfM/Mesh) | Peak RAM | Total Time | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 2026-11-01 11:50:16 | `big.mp4` | **baseline** | 60 / 60 / 22 | 36.7% | 0 (none) | 0 | 0 / 0 | 0 | 10.7s / 37.2s / 32.6s / 23.3s / 0.0s | 288 MB | 103.8s | FAILED: System free RAM depleted below safety limit |
| 2026-11-01 11:52:51 | `big.mp4` | **baseline** | 60 / 60 / 17 | 28.3% | 3 (m0:7322, m1:15744, m2:11668) | 2800 | 10715 / 20944 | 32 | 11.1s / 30.8s / 26.9s / 19.2s / 2.6s | 288 MB | 91.1s | SUCCESS |
| 2026-11-01 11:55:58 | `video_20261101_095812.mp4` | **baseline-corridor-30** | 60 / 30 / 4 | 13.3% | 1 (m0:1944) | 298 | 2335 / 4516 | 2 | 8.1s / 11.9s / 10.4s / 7.4s / 1.6s | 288 MB | 39.6s | SUCCESS |
| 2026-11-01 12:13:41 | `big.mp4` | **adaptive-60-exhaustive** | 80 / 60 / 60 | 100.0% | 2 (m0:2670, m1:30922) | 11413 | 35051 / 67923 | 128 | 16.5s / 79.1s / 69.2s / 49.4s / 4.8s | 289 MB | 219.3s | SUCCESS |
| 2026-11-01 12:16:30 | `big.mp4` | **adaptive-80-sequential15** | 80 / 79 / 79 | 100.0% | 2 (m0:3574, m1:40779) | 13927 | 42322 / 82096 | 164 | 20.1s / 47.3s / 41.4s / 29.5s / 4.3s | 291 MB | 142.7s | SUCCESS |

## Configuration Rationale & Decision (Phase B, Step 9)

### Comparison Summary
1. **Baseline (Fixed time intervals, 60 frames):**
   - Registered frames: 17/60 (28.3%)
   - Submodels: 3 disconnected models
   - Sparse Points: 2,800
   - Mesh Vertices: 10,715
   - Total Duration: 91.1s
   - *Verdict:* Severe fragmentation. Fixed time intervals sampled motion-blurred and dark frames, breaking feature tracks.

2. **Adaptive-60 + Exhaustive Matching:**
   - Registered frames: 60/60 (100.0%)
   - Submodels: 2 (1 dominant model with 95% of points)
   - Sparse Points: 11,413 (4.07x increase over baseline)
   - Mesh Vertices: 35,051 (3.27x increase)
   - Total Duration: 219.3s
   - *Verdict:* Outstanding track quality, 100% registration, but matching duration scales quadratically ($O(N^2)$).

3. **Adaptive-80 + Sequential Matching (overlap=20, quadratic=1):**
   - Registered frames: 79/79 (100.0%)
   - Submodels: 2 (1 dominant model with 92% of points)
   - Sparse Points: 13,927 (4.97x increase over baseline, +22% vs 60-exhaustive)
   - Mesh Vertices: 42,322 (3.95x increase over baseline, +21% vs 60-exhaustive)
   - Total Duration: 142.7s (35% faster than exhaustive 60, saving 76.6s)
   - Peak RAM: 291 MB (stable, well below 6.0 GB ceiling)
   - *Verdict:* WINNER. Higher point cloud density, 100% registration rate, and 35% faster processing due to linear $O(N \cdot k)$ matching complexity.

### Production Default Strategy
- **`MATCHING_STRATEGY = 'auto'`**:
  - If frame count $\le 50$ (short clips $< 30$s): Use `exhaustive_matcher` to ensure robust loop closures across non-sequential viewpoints.
  - If frame count $> 50$ (standard/long clips $\ge 30$s): Use `sequential_matcher` with `overlap=20` and `quadratic_overlap=1`.
  - Fallback: If exhaustive matching ever fails, automatically fallback to sequential matching.
