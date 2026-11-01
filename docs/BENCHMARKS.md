# NAMMA SPACE — Reconstruction Quality & Performance Benchmarks

Benchmark measurements enforcing Rule 2 (Memory safety: peak RAM ≤ 6.5 GB, timeout ≤ 8 min).

| Date & Time | Video | Config Name | Frames Ext/Kept/Reg | Reg % | COLMAP Models | Sparse Pts | Vertices / Tris | Components | Stage Durations (Ext/Feat/Match/SfM/Mesh) | Peak RAM | Total Time | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 2026-11-01 11:50:16 | `big.mp4` | **baseline** | 60 / 60 / 22 | 36.7% | 0 (none) | 0 | 0 / 0 | 0 | 10.7s / 37.2s / 32.6s / 23.3s / 0.0s | 288 MB | 103.8s | FAILED: System free RAM depleted below safety li |
| 2026-11-01 11:52:51 | `big.mp4` | **baseline** | 60 / 60 / 17 | 28.3% | 3 (m0:7322, m1:15744, m2:11668) | 2800 | 10715 / 20944 | 32 | 11.1s / 30.8s / 26.9s / 19.2s / 2.6s | 288 MB | 91.1s | SUCCESS |
| 2026-11-01 11:55:58 | `video_20261101_095812.mp4` | **baseline-corridor-30** | 60 / 30 / 4 | 13.3% | 1 (m0:1944) | 298 | 2335 / 4516 | 2 | 8.1s / 11.9s / 10.4s / 7.4s / 1.6s | 288 MB | 39.6s | SUCCESS |
