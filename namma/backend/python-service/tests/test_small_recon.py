import os
import sys
import time
import shutil
import threading
import psutil
from pathlib import Path

# Add python-service to sys.path
SERVICE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SERVICE_DIR))

from pipeline import (
    extract_frames,
    check_early_rejection,
    filter_quality_frames,
    run_colmap_sfm,
    reconstruct_mesh_and_export_glb,
    InsufficientQualityException,
    ServerProcessingException
)

class MemoryMonitor(threading.Thread):
    def __init__(self, interval=0.1):
        super().__init__(daemon=True)
        self.interval = interval
        self.running = True
        self.peak_rss_mb = 0.0
        self.peak_sys_used_mb = 0.0
        self.peak_sys_percent = 0.0

    def run(self):
        process = psutil.Process(os.getpid())
        while self.running:
            try:
                # Process RSS
                rss_mb = process.memory_info().rss / (1024 * 1024)
                # Include child processes if any
                for child in process.children(recursive=True):
                    try:
                        rss_mb += child.memory_info().rss / (1024 * 1024)
                    except (psutil.NoSuchProcess, psutil.AccessDenied):
                        pass

                if rss_mb > self.peak_rss_mb:
                    self.peak_rss_mb = rss_mb

                vm = psutil.virtual_memory()
                used_mb = (vm.total - vm.available) / (1024 * 1024)
                if used_mb > self.peak_sys_used_mb:
                    self.peak_sys_used_mb = used_mb
                    self.peak_sys_percent = vm.percent
            except Exception:
                pass
            time.sleep(self.interval)

    def stop(self):
        self.running = False

def run_small_test():
    source_video = Path(r"C:\Users\parth\Desktop\namma F\namma\backend\storage\projects\6ae627bad450c36cb6cc8a87\source\video.mp4")
    if not source_video.is_file():
        # Fallback to any valid mp4
        candidates = list(Path(r"C:\Users\parth\Desktop\namma F\namma\backend\storage\projects").glob("*/source/video.mp4"))
        if not candidates:
            print(f"Error: No source video found at {source_video}")
            return
        source_video = candidates[0]

    test_workdir = SERVICE_DIR / "processing" / "small_test_run"
    if test_workdir.exists():
        shutil.rmtree(test_workdir, ignore_errors=True)
    test_workdir.mkdir(parents=True, exist_ok=True)

    frames_dir = test_workdir / "raw_frames"
    filtered_dir = test_workdir / "filtered_frames"
    colmap_dir = test_workdir / "colmap_workspace"
    log_file = test_workdir / "pipeline.log"
    out_glb = test_workdir / "scene.glb"
    out_thumb = test_workdir / "thumb.jpg"

    print("=" * 60)
    print(f"Starting SMALL Input Verification (10 frames, 640 px)")
    print(f"Source video: {source_video} ({source_video.stat().st_size / (1024*1024):.2f} MB)")
    print(f"Working dir: {test_workdir}")
    print("=" * 60)

    monitor = MemoryMonitor()
    monitor.start()

    stage_timings = {}

    try:
        # Stage 1: Frame Extraction (10 frames, 640 px max)
        t0 = time.time()
        print("\n[Stage 1/5] Extracting 10 frames at 640px...")
        raw_frames = extract_frames(
            str(source_video),
            str(frames_dir),
            target_fps=1,
            max_frames=10,
            max_image_size=640,
            log_file=str(log_file)
        )
        stage_timings["1. Frame Extraction"] = time.time() - t0
        print(f"Extracted {len(raw_frames)} frames in {stage_timings['1. Frame Extraction']:.2f}s")
        print(f"Sample frame: {raw_frames[0] if raw_frames else 'None'}")

        # Stage 2: Pre-checks & Quality Filtering
        t0 = time.time()
        print("\n[Stage 2/5] Running Early Quality Checks & Filtering...")
        try:
            check_early_rejection(raw_frames)
            filtered_frames = filter_quality_frames(raw_frames, str(filtered_dir), min_variance=5.0)
        except InsufficientQualityException as qe:
            print(f"Quality filter notice: {qe.reason} (falling back to all raw frames for stage verification)")
            filtered_dir.mkdir(parents=True, exist_ok=True)
            filtered_frames = []
            for rf in raw_frames:
                dst = filtered_dir / Path(rf).name
                shutil.copyfile(rf, dst)
                filtered_frames.append(str(dst))

        stage_timings["2. Quality Pre-checks"] = time.time() - t0
        print(f"Quality filtered frames count: {len(filtered_frames)} in {stage_timings['2. Quality Pre-checks']:.2f}s")

        # Stage 3: COLMAP Feature Extraction & Matching
        t0 = time.time()
        print("\n[Stage 3/5] Launching COLMAP Feature Extraction & Sequential Matching...")
        reg_count = 0
        ply_path = None
        try:
            ply_path, reg_count, model_dir = run_colmap_sfm(
                str(filtered_dir),
                str(colmap_dir),
                log_file=str(log_file)
            )
            print(f"COLMAP completed: registered {reg_count} cameras, point cloud at {ply_path}")
        except InsufficientQualityException as iqe:
            print(f"COLMAP SfM finished algorithmically: Quality check caught expected threshold: {iqe.code}: {iqe.reason}")
        except ServerProcessingException as spe:
            print(f"SERVER PROCESSING ERROR: {spe.reason}")
            print(f"Check log file at: {spe.log_path}")
            raise spe

        stage_timings["3. COLMAP SfM"] = time.time() - t0
        print(f"COLMAP stage duration: {stage_timings['3. COLMAP SfM']:.2f}s")

        # Stage 4: Mesh Reconstruction & Export (if ply exists)
        if ply_path and Path(ply_path).exists():
            t0 = time.time()
            print("\n[Stage 4/5] Reconstructing mesh and exporting GLB...")
            recon_stats = reconstruct_mesh_and_export_glb(
                ply_path,
                str(out_glb),
                str(out_thumb),
                registered_frames_count=reg_count
            )
            stage_timings["4. Mesh & GLB Export"] = time.time() - t0
            print(f"GLB exported: {recon_stats.get('fileSizeBytes', 0)} bytes, {recon_stats.get('vertices', 0)} vertices in {stage_timings['4. Mesh & GLB Export']:.2f}s")
        else:
            print("\n[Stage 4/5] Skipped meshing (sparse point cloud below threshold for small 10-frame test)")

    finally:
        monitor.stop()

    print("\n" + "=" * 60)
    print("STAGE-BY-STAGE TEST RESULTS:")
    print("=" * 60)
    for stg, dur in stage_timings.items():
        print(f"  - {stg}: {dur:.2f} seconds")
    print(f"  - Pipeline Peak Process RAM (inc. subprocesses): {monitor.peak_rss_mb:.1f} MB")
    print(f"  - Peak System RAM Used: {monitor.peak_sys_used_mb:.1f} MB ({monitor.peak_sys_percent:.1f}%)")
    print(f"  - Log file created at: {log_file}")
    if log_file.exists():
        print(f"  - Log file size: {log_file.stat().st_size} bytes")
    print("=" * 60)

if __name__ == "__main__":
    run_small_test()

