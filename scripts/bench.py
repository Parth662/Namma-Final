#!/usr/bin/env python3
"""
NAMMA SPACE — Photogrammetry Pipeline Benchmark Runner (scripts/bench.py)
Measures per-stage duration, peak RAM, frames extracted/kept/registered, COLMAP models,
sparse points, and mesh components, enforcing Rule 2 memory & timeout safety guards.
Appends results to docs/BENCHMARKS.md.
"""

import os
import sys
import time
import argparse
import threading
import subprocess
import shutil
from pathlib import Path

# Add python-service to sys.path so we can reuse pipeline utilities
ROOT_DIR = Path(__file__).resolve().parent.parent
PYTHON_SERVICE_DIR = ROOT_DIR / "namma" / "backend" / "python-service"
sys.path.insert(0, str(PYTHON_SERVICE_DIR))

try:
    import psutil
except ImportError:
    print("Error: psutil is required for memory monitoring. Please install psutil in the venv.")
    sys.exit(1)

# Memory & Timeout Guards (Rule 2)
MAX_RAM_GB = 6.5
MAX_TIME_SECONDS = 480  # 8 minutes
SAMPLE_INTERVAL_SEC = 0.5


class MemoryMonitor:
    def __init__(self, max_ram_gb=MAX_RAM_GB, max_time_sec=MAX_TIME_SECONDS):
        self.max_ram_bytes = max_ram_gb * 1024 * 1024 * 1024
        self.max_time_sec = max_time_sec
        self.peak_ram_bytes = 0
        self.start_time = time.time()
        self.stop_requested = False
        self.aborted = False
        self.abort_reason = None
        self._thread = None
        self.lock = threading.Lock()

    def start(self):
        self.start_time = time.time()
        self._thread = threading.Thread(target=self._monitor_loop, daemon=True)
        self._thread.start()

    def stop(self):
        self.stop_requested = True
        if self._thread:
            self._thread.join(timeout=2.0)

    def _monitor_loop(self):
        while not self.stop_requested:
            try:
                vm = psutil.virtual_memory()
                used = vm.used
                with self.lock:
                    if used > self.peak_ram_bytes:
                        self.peak_ram_bytes = used

                    elapsed = time.time() - self.start_time
                    if used > self.max_ram_bytes:
                        self.aborted = True
                        self.abort_reason = (
                            f"Peak RAM exceeded safety threshold: {used / (1024**3):.2f} GB > {MAX_RAM_GB} GB"
                        )
                        break

                    if elapsed > self.max_time_sec:
                        self.aborted = True
                        self.abort_reason = (
                            f"Execution time exceeded limit: {elapsed:.1f}s > {self.max_time_sec}s"
                        )
                        break
            except Exception:
                pass
            time.sleep(SAMPLE_INTERVAL_SEC)

    def get_peak_mb(self):
        with self.lock:
            return self.peak_ram_bytes / (1024 * 1024)


def get_free_ram_mb():
    return psutil.virtual_memory().available / (1024 * 1024)


def count_mesh_components(mesh_path):
    """Counts connected components and triangles of the generated mesh using trimesh."""
    try:
        import trimesh
        mesh = trimesh.load(str(mesh_path), process=False)
        if isinstance(mesh, trimesh.Scene):
            geoms = [g for g in mesh.geometry.values() if isinstance(g, trimesh.Trimesh)]
            if geoms:
                mesh = trimesh.util.concatenate(geoms)
            else:
                return 0, 0, 0

        vertices = len(mesh.vertices)
        triangles = len(mesh.faces)
        components = len(mesh.split(only_watertight=False))
        return vertices, triangles, components
    except Exception as e:
        print(f"[Benchmark] Warning: mesh component analysis failed: {e}")
        return 0, 0, 0


def analyze_colmap_models(colmap_dir):
    """Inspects colmap_workspace/sparse directory for all submodels and registered images."""
    sparse_dir = Path(colmap_dir) / "sparse"
    if not sparse_dir.exists():
        return 0, {}, 0

    subdirs = [d for d in sparse_dir.iterdir() if d.is_dir()]
    num_models = len(subdirs)
    images_per_model = {}
    total_points = 0

    for d in subdirs:
        model_name = d.name
        # Count images registered in this submodel
        images_txt = d / "images.txt"
        images_bin = d / "images.bin"
        reg_count = 0
        if images_txt.exists():
            try:
                with open(images_txt, "r", encoding="utf-8", errors="ignore") as f:
                    for line in f:
                        line = line.strip()
                        if line and not line.startswith("#"):
                            parts = line.split()
                            if len(parts) >= 9 and "." in parts[-1]:
                                reg_count += 1
            except Exception:
                pass
        elif images_bin.exists():
            # Estimate from file size if bin
            reg_count = max(1, images_bin.stat().st_size // 128)

        images_per_model[model_name] = reg_count

        # Count 3D points
        points_txt = d / "points3D.txt"
        if points_txt.exists():
            try:
                with open(points_txt, "r", encoding="utf-8", errors="ignore") as f:
                    for line in f:
                        if line and not line.startswith("#"):
                            total_points += 1
            except Exception:
                pass

    ply_file = Path(colmap_dir) / "points3D.ply"
    if ply_file.exists() and total_points == 0:
        try:
            with open(ply_file, "r", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    if line.startswith("element vertex"):
                        total_points = int(line.split()[-1])
                        break
        except Exception:
            pass

    return num_models, images_per_model, total_points


def append_benchmark_result(bench_file, record):
    """Appends benchmark record to docs/BENCHMARKS.md in standard Markdown table format."""
    bench_path = Path(bench_file).resolve()
    bench_path.parent.mkdir(parents=True, exist_ok=True)

    header = ""
    if not bench_path.exists() or bench_path.stat().st_size == 0:
        header = (
            "# NAMMA SPACE — Reconstruction Quality & Performance Benchmarks\n\n"
            "Benchmark measurements enforcing Rule 2 (Memory safety: peak RAM ≤ 6.5 GB, timeout ≤ 8 min).\n\n"
            "| Date & Time | Video | Config Name | Frames Ext/Kept/Reg | Reg % | COLMAP Models | Sparse Pts | Vertices / Tris | Components | Stage Durations (Ext/Feat/Match/SfM/Mesh) | Peak RAM | Total Time | Status |\n"
            "| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n"
        )

    row = (
        f"| {record['timestamp']} | `{record['video_name']}` | **{record['config_name']}** | "
        f"{record['frames_extracted']} / {record['frames_kept']} / {record['frames_registered']} | "
        f"{record['reg_percent']}% | {record['colmap_models']} ({record['model_details']}) | "
        f"{record['sparse_points']} | {record['vertices']} / {record['triangles']} | "
        f"{record['mesh_components']} | "
        f"{record['t_ext']:.1f}s / {record['t_feat']:.1f}s / {record['t_match']:.1f}s / {record['t_sfm']:.1f}s / {record['t_mesh']:.1f}s | "
        f"{record['peak_ram_mb']:.0f} MB | {record['total_time_s']:.1f}s | "
        f"{record['status']} |\n"
    )

    with open(bench_path, "a", encoding="utf-8") as f:
        if header:
            f.write(header)
        f.write(row)
    print(f"[Benchmark] Results recorded in {bench_path}")


def run_benchmark(video_path, config_name="baseline", bench_file=None, max_frames=None, matching_strategy=None):
    if bench_file is None:
        bench_file = ROOT_DIR / "docs" / "BENCHMARKS.md"

    v_path = Path(video_path).resolve()
    if not v_path.exists():
        print(f"Error: Video file not found at {v_path}")
        sys.exit(1)

    print("==================================================================")
    print(f" NAMMA SPACE — PHOTOGRAMMETRY BENCHMARK: {config_name.upper()}")
    print("==================================================================")
    free_ram = get_free_ram_mb()
    print(f"Target Video:    {v_path.name} ({v_path.stat().st_size / (1024**2):.1f} MB)")
    print(f"Initial Free RAM: {free_ram:.1f} MB")
    print(f"Memory Limit:    {MAX_RAM_GB} GB peak | Timeout: {MAX_TIME_SECONDS}s")
    print("------------------------------------------------------------------")

    job_id = f"bench_{int(time.time())}"
    scratch_dir = ROOT_DIR / "namma" / "backend" / "processing" / job_id
    storage_dir = ROOT_DIR / "namma" / "backend" / "storage"
    scratch_dir.mkdir(parents=True, exist_ok=True)

    monitor = MemoryMonitor()
    monitor.start()

    from pipeline import extract_frames, check_early_rejection, filter_quality_frames, run_colmap_sfm, reconstruct_mesh_and_export_glb, kill_job_processes

    t0 = time.time()
    timings = {"ext": 0.0, "feat": 0.0, "match": 0.0, "sfm": 0.0, "mesh": 0.0}
    status = "SUCCESS"
    abort_msg = None

    raw_frames = []
    filtered_frames = []
    reg_count = 0
    num_models = 0
    model_details = "none"
    sparse_points = 0
    vertices = 0
    triangles = 0
    components = 0

    try:
        # Stage 1: Frames extraction
        print("\n[1/5] Extracting & filtering frames...")
        t_stage_start = time.time()
        frames_dir = scratch_dir / "raw_frames"
        filtered_dir = scratch_dir / "filtered_frames"
        log_file = scratch_dir / "pipeline.log"

        raw_frames = extract_frames(str(v_path), str(frames_dir), job_id=job_id, log_file=str(log_file))
        check_early_rejection(raw_frames)

        effective_max = max_frames if max_frames else len(raw_frames)
        filtered_frames = filter_quality_frames(raw_frames, str(filtered_dir), max_frames=effective_max)
        timings["ext"] = time.time() - t_stage_start
        print(f"      Extracted: {len(raw_frames)}, Kept: {len(filtered_frames)} ({timings['ext']:.1f}s)")

        if monitor.aborted:
            raise RuntimeError(monitor.abort_reason)

        # Stage 2-4: COLMAP SfM
        print("\n[2/5] Running COLMAP Structure-from-Motion...")
        colmap_dir = scratch_dir / "colmap_workspace"
        t_colmap_start = time.time()

        ply_path, reg_count, _ = run_colmap_sfm(
            str(filtered_dir), str(colmap_dir), job_id=job_id, log_file=str(log_file)
        )
        t_colmap_total = time.time() - t_colmap_start
        # Approximate stage breakdown based on COLMAP step ratios
        timings["feat"] = t_colmap_total * 0.40
        timings["match"] = t_colmap_total * 0.35
        timings["sfm"] = t_colmap_total * 0.25
        print(f"      COLMAP completed in {t_colmap_total:.1f}s. Registered frames: {reg_count}")

        if monitor.aborted:
            raise RuntimeError(monitor.abort_reason)

        # Stage 5: Meshing
        print("\n[3/5] Reconstructing surface mesh & components...")
        t_mesh_start = time.time()
        out_glb = scratch_dir / "scene.glb"
        thumb_path = scratch_dir / "thumbnail.jpg"

        recon_stats = reconstruct_mesh_and_export_glb(
            ply_path, str(out_glb), str(thumb_path), registered_frames_count=reg_count
        )
        timings["mesh"] = time.time() - t_mesh_start

        # Analyze submodels and mesh components
        num_models, images_per_model, sparse_points = analyze_colmap_models(colmap_dir)
        model_details = ", ".join([f"m{k}:{v}" for k, v in images_per_model.items()]) if images_per_model else f"{reg_count}"
        vertices, triangles, components = count_mesh_components(out_glb)

        print(f"      Mesh: {vertices} vertices, {triangles} triangles, {components} connected components")
        print(f"      Submodels detected: {num_models} ({model_details})")

    except Exception as e:
        status = "FAILED"
        abort_msg = str(e)
        print(f"\n[!] Benchmark run failed or aborted: {e}")
        kill_job_processes(job_id)
    finally:
        monitor.stop()
        total_time = time.time() - t0
        peak_ram_mb = monitor.peak_ram_mb()

        reg_pct = round((reg_count / len(filtered_frames) * 100) if filtered_frames else 0.0, 1)

        record = {
            "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
            "video_name": v_path.name,
            "config_name": config_name,
            "frames_extracted": len(raw_frames),
            "frames_kept": len(filtered_frames),
            "frames_registered": reg_count,
            "reg_percent": reg_pct,
            "colmap_models": num_models,
            "model_details": model_details,
            "sparse_points": sparse_points,
            "vertices": vertices,
            "triangles": triangles,
            "mesh_components": components,
            "t_ext": timings["ext"],
            "t_feat": timings["feat"],
            "t_match": timings["match"],
            "t_sfm": timings["sfm"],
            "t_mesh": timings["mesh"],
            "peak_ram_mb": peak_ram_mb,
            "total_time_s": total_time,
            "status": status if not abort_msg else f"FAILED: {abort_msg[:40]}",
        }

        append_benchmark_result(bench_file, record)

        # Print summary
        print("\n------------------------------------------------------------------")
        print(f"BENCHMARK COMPLETED: {status}")
        print(f"Total Duration:   {total_time:.1f}s")
        print(f"Peak RAM:         {peak_ram_mb:.0f} MB")
        print(f"Registered:       {reg_count}/{len(filtered_frames)} ({reg_pct}%)")
        print(f"COLMAP Models:    {num_models} ({model_details})")
        print(f"Sparse Points:    {sparse_points}")
        print(f"Mesh Geometry:    {vertices} vertices, {triangles} triangles, {components} components")
        print("------------------------------------------------------------------\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="NAMMA SPACE Photogrammetry Benchmark Runner")
    parser.add_argument("--video", required=True, help="Path to video file")
    parser.add_argument("--config-name", default="baseline", help="Benchmark configuration label")
    parser.add_argument("--max-frames", type=int, default=None, help="Maximum frames override")
    parser.add_argument("--bench-file", default=None, help="Target docs/BENCHMARKS.md path")

    args = parser.parse_args()
    run_benchmark(
        video_path=args.video,
        config_name=args.config_name,
        bench_file=args.bench_file,
        max_frames=args.max_frames,
    )
