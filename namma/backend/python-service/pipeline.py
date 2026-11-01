import os
import sys

# Prevent OpenBLAS/OMP thread exhaustion and memory allocation failures on constrained 8GB Windows machines
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")

import glob
import json
import shutil
import subprocess
import urllib.request
from pathlib import Path
import numpy as np
import cv2
from PIL import Image

def report_stage(stage, progress, message, callback_url=None, project_id=None, job_id=None):
    print(f"[Stage] {stage.upper()} ({progress}%): {message}")
    if callback_url and project_id:
        try:
            payload = json.dumps({
                "projectId": str(project_id),
                "jobId": str(job_id) if job_id else None,
                "stage": stage,
                "progress": progress,
                "message": message
            }).encode("utf-8")
            req = urllib.request.Request(
                callback_url,
                data=payload,
                headers={"Content-Type": "application/json"},
                method="POST"
            )
            with urllib.request.urlopen(req, timeout=2):
                pass
        except Exception:
            pass

class InsufficientQualityException(Exception):
    def __init__(self, code, reason, suggestion=None):
        super().__init__(reason)
        self.code = code
        self.title = "Reconstruction Quality Issue"
        self.reason = reason
        self.suggestion = suggestion or "Record the area again while moving slowly with steady overlapping camera angles."

class ServerProcessingException(Exception):
    def __init__(self, reason, log_path=None, suggestion=None):
        super().__init__(reason)
        self.code = "SERVER_PROCESSING_ERROR"
        self.title = "Server processing error"
        self.reason = reason
        self.log_path = log_path
        self.suggestion = suggestion or (
            f"Check server log at: {log_path}" if log_path else "Check server logs for diagnostic output."
        )

BACKEND_ROOT = Path(__file__).resolve().parent.parent

ACTIVE_PROCESSES = {}  # job_id -> list of subprocess.Popen

def register_process(job_id, proc):
    if not job_id:
        return
    if job_id not in ACTIVE_PROCESSES:
        ACTIVE_PROCESSES[job_id] = []
    ACTIVE_PROCESSES[job_id].append(proc)

def unregister_process(job_id, proc):
    if job_id in ACTIVE_PROCESSES:
        try:
            ACTIVE_PROCESSES[job_id].remove(proc)
            if not ACTIVE_PROCESSES[job_id]:
                del ACTIVE_PROCESSES[job_id]
        except ValueError:
            pass

def kill_job_processes(job_id):
    killed = 0
    if job_id in ACTIVE_PROCESSES:
        for proc in list(ACTIVE_PROCESSES[job_id]):
            try:
                proc.terminate()
                proc.kill()
                killed += 1
            except Exception:
                pass
        del ACTIVE_PROCESSES[job_id]
    print(f"[ProcessManager] Terminated {killed} processes for job {job_id}")
    return killed

def format_process_error(bin_name, returncode, stdout, stderr, log_path=None):
    hex_code = hex(returncode if returncode >= 0 else returncode + (1 << 32))
    known_codes = {
        "0xc0000005": "STATUS_ACCESS_VIOLATION (Crash: Memory Access Violation)",
        "0xc0000409": "STATUS_STACK_BUFFER_OVERRUN (Crash: Stack Buffer Overrun / OOM)",
        "0xc000013a": "STATUS_CONTROL_C_EXIT (Process terminated)",
    }
    code_desc = known_codes.get(hex_code.lower(), f"Exit code {returncode} ({hex_code})")

    all_lines = ((stderr or "") + "\n" + (stdout or "")).splitlines()
    error_lines = []
    for line in all_lines:
        line_clean = line.strip()
        if not line_clean:
            continue
        # Skip pure COLMAP progress lines
        if line_clean.startswith("I202") and any(k in line_clean for k in ["Processed file", "Creating SIFT", "Features:"]):
            continue
        lower_line = line_clean.lower()
        if any(kw in lower_line for kw in ["check failed", "error", "fatal", "exception", "abort", "crash", "segmentation"]):
            error_lines.append(line_clean)
        elif line_clean.startswith("E202") or line_clean.startswith("F202"):
            error_lines.append(line_clean)

    if error_lines:
        detail = " | ".join(error_lines[:2])
    else:
        # Check for thread warning or last non-progress line
        warnings = [l.strip() for l in all_lines if l.strip().startswith("W202") and "feature_extraction.cc" in l]
        if warnings:
            detail = warnings[0]
        else:
            non_info = [l.strip() for l in all_lines if l.strip() and not (l.strip().startswith("I202") and "Processed file" in l.strip())]
            detail = non_info[-1] if non_info else "Process exited abnormally."

    msg = f"{bin_name} failed [{code_desc}]: {detail}"
    return msg

def run_command(cmd, job_id=None, timeout=300, log_path=None, env=None, check=True):
    """
    Executes an external command safely using subprocess.Popen with shell=False.
    All arguments are converted to str from pathlib.Path with NO shell quoting.
    Tracks active process for cancellation by job_id.
    Logs stdout/stderr to disk if log_path is provided.
    Raises ServerProcessingException if check=True and process returns non-zero.
    """
    clean_cmd = []
    for arg in cmd:
        if isinstance(arg, Path):
            clean_cmd.append(str(arg.resolve()))
        elif isinstance(arg, str):
            clean_cmd.append(arg)
        else:
            clean_cmd.append(str(arg))

    proc_env = (env.copy() if env else os.environ.copy())
    bin_path = Path(clean_cmd[0])
    if bin_path.is_file():
        bin_dir = str(bin_path.parent.resolve())
        proc_env["PATH"] = f"{bin_dir}{os.pathsep}{proc_env.get('PATH', '')}"
        plugins_dir = bin_path.parent.parent / "plugins"
        if plugins_dir.is_dir():
            proc_env["QT_PLUGIN_PATH"] = str(plugins_dir.resolve())

    cmd_str_preview = " ".join(clean_cmd)
    print(f"[Subprocess] Executing (shell=False): {cmd_str_preview[:200]}...")
    if log_path:
        os.makedirs(os.path.dirname(log_path), exist_ok=True)
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(f"\n--- [CMD] {cmd_str_preview} ---\n")

    try:
        proc = subprocess.Popen(
            clean_cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            shell=False,
            env=proc_env
        )
    except Exception as e:
        err_msg = f"Failed to spawn process '{clean_cmd[0]}': {e}"
        if log_path:
            with open(log_path, "a", encoding="utf-8") as f:
                f.write(f"[SPAWN_ERROR] {err_msg}\n")
        raise ServerProcessingException(err_msg, log_path=str(log_path) if log_path else None)

    if job_id:
        register_process(job_id, proc)

    try:
        stdout, stderr = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.communicate()
        timeout_msg = f"Command '{Path(clean_cmd[0]).name}' timed out after {timeout} seconds."
        if log_path:
            with open(log_path, "a", encoding="utf-8") as f:
                f.write(f"[TIMEOUT] {timeout_msg}\n")
        raise ServerProcessingException(timeout_msg, log_path=str(log_path) if log_path else None)
    finally:
        if job_id:
            unregister_process(job_id, proc)

    if log_path:
        with open(log_path, "a", encoding="utf-8") as f:
            if stdout:
                f.write(stdout)
            if stderr:
                f.write(stderr)
            f.write(f"\n[EXIT_CODE] {proc.returncode}\n")

    if check and proc.returncode != 0:
        bin_label = f"{Path(clean_cmd[0]).name} {clean_cmd[1] if len(clean_cmd) > 1 and not clean_cmd[1].startswith('-') else ''}".strip()
        msg = format_process_error(bin_label, proc.returncode, stdout, stderr, log_path=log_path)
        raise ServerProcessingException(msg, log_path=str(log_path) if log_path else None)

    class CompletedResult:
        def __init__(self, out, err, code):
            self.stdout = out
            self.stderr = err
            self.returncode = code

    return CompletedResult(stdout, stderr, proc.returncode)

def run_tracked_process(cmd, job_id=None, timeout=300):
    return run_command(cmd, job_id=job_id, timeout=timeout, check=False)

def get_ffmpeg_bin():
    env_path = os.environ.get("FFMPEG_PATH")
    if env_path and os.path.isfile(env_path):
        return str(Path(env_path).resolve())
    found = shutil.which("ffmpeg")
    if found:
        return str(Path(found).resolve())
    gyan_path = Path(r"C:\Users\parth\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg.Essentials_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0.1-essentials_build\bin\ffmpeg.exe")
    if gyan_path.is_file():
        return str(gyan_path.resolve())
    return "ffmpeg"

def get_ffprobe_bin():
    env_path = os.environ.get("FFPROBE_PATH")
    if env_path and os.path.isfile(env_path):
        return str(Path(env_path).resolve())
    found = shutil.which("ffprobe")
    if found:
        return str(Path(found).resolve())
    gyan_path = Path(r"C:\Users\parth\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg.Essentials_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0.1-essentials_build\bin\ffprobe.exe")
    if gyan_path.is_file():
        return str(gyan_path.resolve())
    return "ffprobe"

def get_video_duration(video_path):
    """Measures video duration in seconds via OpenCV with ffprobe fallback."""
    try:
        cap = cv2.VideoCapture(str(video_path))
        if cap.isOpened():
            fps = cap.get(cv2.CAP_PROP_FPS)
            count = cap.get(cv2.CAP_PROP_FRAME_COUNT)
            cap.release()
            if fps > 0 and count > 0:
                dur = float(count) / float(fps)
                if dur > 0.1:
                    return dur
    except Exception:
        pass
    try:
        ffprobe_bin = get_ffprobe_bin()
        cmd = [
            ffprobe_bin, "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            str(video_path)
        ]
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=10)
        dur = float(res.stdout.strip())
        if dur > 0.1:
            return dur
    except Exception:
        pass
    return 0.0

def extract_frames(video_path, output_dir, target_fps=None, max_frames=None, max_image_size=None, job_id=None, log_file=None):
    """
    Extract high-quality frames from the uploaded video using ffmpeg directly:
    - For videos longer than ~30s: raises extracted frame count to 50-60 (max 960 px).
    - Drops near-black frames and the blurriest 20% by Laplacian variance.
    - Spreads selected frames evenly in time across the entire video.
    """
    out_dir = Path(output_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    ffmpeg_bin = get_ffmpeg_bin()
    vpath = Path(video_path).resolve()

    duration = get_video_duration(vpath)
    print(f"[FFmpeg] Video duration measured: {duration:.2f}s")

    # Adaptive keyframe selection (4 fps candidates, max 960 px, capped at MAX_FRAMES, default 80)
    cand_fps = float(os.environ.get("FRAME_FPS", 4.0))
    max_frames_cap = int(max_frames or os.environ.get("MAX_FRAMES", 80))

    max_size = int(max_image_size or os.environ.get("MAX_IMAGE_SIZE", 960))

    # Scale filter guarantees neither width nor height exceeds max_size (960px)
    scale_filter = f"scale={max_size}:{max_size}:force_original_aspect_ratio=decrease"
    out_pattern = out_dir / "cand_%04d.png"

    cmd = [
        ffmpeg_bin, "-y",
        "-i", str(vpath),
        "-vf", f"fps={cand_fps:.2f},{scale_filter}",
        "-q:v", "2",
        str(out_pattern)
    ]
    run_command(cmd, job_id=job_id, timeout=120, log_path=log_file, check=False)
    cand_files = sorted([str(p) for p in out_dir.glob("cand_*.png")])

    if len(cand_files) < 4:
        cmd_fallback = [
            ffmpeg_bin, "-y",
            "-i", str(vpath),
            "-vf", scale_filter,
            "-q:v", "2",
            str(out_pattern)
        ]
        run_command(cmd_fallback, job_id=job_id, timeout=120, log_path=log_file, check=False)
        cand_files = sorted([str(p) for p in out_dir.glob("cand_*.png")])

    if len(cand_files) < 4:
        raise InsufficientQualityException(
            "INSUFFICIENT_RECONSTRUCTION_QUALITY",
            f"Only {len(cand_files)} frames could be extracted from the video.",
            "Record at least 5 to 15 seconds continuously orbiting the room or subject."
        )

    # 1. Filter out near-black and blurry candidate frames
    valid_candidates = []
    total_cands = len(cand_files)
    effective_dur = max(duration, float(total_cands) / max(1.0, cand_fps))

    for idx, fpath in enumerate(cand_files):
        img = cv2.imread(fpath)
        if img is None:
            continue
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        mean_lum = float(np.mean(gray))
        max_lum = float(np.max(gray))
        # Drop near-black or unexposed frames (first frame is never black)
        if mean_lum < 20.0 or max_lum < 40.0:
            continue
        var = float(cv2.Laplacian(gray, cv2.CV_64F).var())
        # Drop severely blurred frames
        if var < 35.0:
            continue
        approx_time = (float(idx) / float(total_cands)) * effective_dur
        valid_candidates.append({
            "path": fpath,
            "idx": idx,
            "time": approx_time,
            "sharpness": var,
            "gray": gray,
        })

    if len(valid_candidates) < 4:
        raise InsufficientQualityException(
            "REJECTED_TOO_DARK",
            "Video contains mostly near-black or severely blurry frames.",
            "Please record in better lighting conditions and move more smoothly."
        )

    # 2. Adaptive Keyframe Selection using feature match decay
    # Keep frame only when feature matches with last kept frame fall below ~60%
    # Constraints: min gap 0.25s, max gap 2.0s, cap at MAX_FRAMES (default 80)
    orb = cv2.ORB_create(nfeatures=500)
    bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)

    selected = []
    first_cand = valid_candidates[0]
    kp0, des0 = orb.detectAndCompute(first_cand["gray"], None)
    first_cand["des"] = des0
    first_cand["num_kp"] = len(kp0) if kp0 else 0
    selected.append(first_cand)
    last_kept = first_cand

    for curr in valid_candidates[1:]:
        if len(selected) >= max_frames_cap:
            break

        dt = curr["time"] - last_kept["time"]
        if dt < 0.25:
            # Min gap 0.25s
            continue

        kp, des = orb.detectAndCompute(curr["gray"], None)
        curr["des"] = des
        num_kp = len(kp) if kp else 0
        curr["num_kp"] = num_kp

        if dt >= 2.0:
            # Max gap 2.0s reached; keep to avoid track fragmentation
            selected.append(curr)
            last_kept = curr
            continue

        # Calculate feature match overlap with last kept frame
        if last_kept.get("des") is not None and des is not None and len(last_kept["des"]) > 10 and len(des) > 10:
            try:
                matches = bf.match(last_kept["des"], des)
                match_ratio = len(matches) / max(1, num_kp)
            except Exception:
                match_ratio = 1.0
        else:
            match_ratio = 0.0

        # Keep frame only when overlap falls below 60%
        if match_ratio < 0.60:
            selected.append(curr)
            last_kept = curr

    # If adaptive selection yielded fewer than 25 frames on a longer video, backfill sharpest candidates
    if len(selected) < min(30, len(valid_candidates)) and len(valid_candidates) > len(selected):
        selected_indices = set(s["idx"] for s in selected)
        remaining = [c for c in valid_candidates if c["idx"] not in selected_indices]
        remaining.sort(key=lambda c: c["sharpness"], reverse=True)
        need = min(max_frames_cap - len(selected), len(remaining))
        selected.extend(remaining[:need])
        selected.sort(key=lambda c: c["time"])

    selected.sort(key=lambda c: c["time"])

    # Rename to clean frame_%04d.png and delete unselected candidates
    final_extracted = []
    selected_paths = set(s["path"] for s in selected)
    for i, s in enumerate(selected):
        final_path = out_dir / f"frame_{i + 1:04d}.png"
        shutil.copyfile(s["path"], str(final_path))
        final_extracted.append(str(final_path))

    for p in cand_files:
        try:
            os.remove(p)
        except OSError:
            pass

    print(f"[AdaptiveFrames] Extracted {len(final_extracted)} adaptively-selected keyframes (cand_fps={cand_fps}, cap={max_frames_cap}, duration={duration:.1f}s)")
    return final_extracted

def check_early_rejection(frames_list):
    """
    Performs fast pre-checks before running expensive COLMAP SfM:
    1. Brightness check
    2. Motion/parallax check between consecutive frames
    3. Global blur check (Laplacian variance)
    4. Keypoint density check (ORB)
    """
    if len(frames_list) < 4:
        raise InsufficientQualityException(
            "REJECTED_TOO_SHORT",
            f"Video yielded only {len(frames_list)} frames. A minimum of 4 frames is required.",
            "Record at least 5 to 15 seconds orbiting the location."
        )

    min_brightness = float(os.environ.get("MIN_BRIGHTNESS", 15.0))
    min_variance = float(os.environ.get("MIN_VARIANCE", 15.0))
    min_motion = float(os.environ.get("MIN_MOTION_SCORE", 0.03))
    min_keypoints = int(os.environ.get("MIN_KEYPOINTS", 80))

    step = max(1, len(frames_list) // 12)
    sample_paths = [frames_list[i] for i in range(0, len(frames_list), step)][:12]

    grays = []
    orb = cv2.ORB_create(nfeatures=500)
    keypoint_counts = []
    blur_scores = []
    brightness_scores = []

    for fpath in sample_paths:
        img = cv2.imread(fpath)
        if img is None:
            continue
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        grays.append(gray)
        brightness_scores.append(float(np.mean(gray)))
        blur_scores.append(float(cv2.Laplacian(gray, cv2.CV_64F).var()))
        kps = orb.detect(gray, None)
        keypoint_counts.append(len(kps))

    if not grays:
        raise InsufficientQualityException("REJECTED_CORRUPTED", "Failed to read extracted frames from video.", "Check video encoding.")

    # 1. Brightness Check
    avg_brightness = float(np.mean(brightness_scores))
    if avg_brightness < min_brightness:
        raise InsufficientQualityException(
            "REJECTED_TOO_DARK",
            f"Video is too dark (average brightness: {avg_brightness:.1f} < {min_brightness}).",
            "Record the area in better lighting conditions."
        )

    # 2. Blur Check
    blurry_count = sum(1 for b in blur_scores if b < min_variance)
    if blurry_count > (len(blur_scores) * 0.75):
        avg_blur = float(np.mean(blur_scores))
        raise InsufficientQualityException(
            "REJECTED_BLURRY_FOOTAGE",
            f"Video contains excessive motion blur (average sharpness: {avg_blur:.1f}).",
            "Hold the phone steady and move slowly without sudden jerky camera movements."
        )

    # 3. Keypoint Density Check
    avg_keypoints = float(np.mean(keypoint_counts))
    if avg_keypoints < min_keypoints:
        raise InsufficientQualityException(
            "REJECTED_FEATURELESS",
            f"Scenes lack sufficient visual texture (average keypoints: {avg_keypoints:.1f} < {min_keypoints}).",
            "Avoid recording blank, single-color walls or featureless ground."
        )

    # 4. Motion / Static Check
    motion_scores = []
    for i in range(1, len(grays)):
        diff = cv2.absdiff(grays[i-1], grays[i])
        motion_scores.append(float(np.mean(diff)) / 255.0)

    avg_motion = float(np.mean(motion_scores)) if motion_scores else 0.0
    if avg_motion < min_motion:
        raise InsufficientQualityException(
            "REJECTED_STATIC_FOOTAGE",
            f"Camera position remained static (motion score: {avg_motion:.3f} < {min_motion}). 3D reconstruction requires camera translation/orbiting.",
            "Walk slowly around the perimeter of the room to provide parallax between viewpoints."
        )

    print(f"[PreCheck] Early quality check PASSED: brightness={avg_brightness:.1f}, blur={np.mean(blur_scores):.1f}, keypoints={avg_keypoints:.1f}, motion={avg_motion:.3f}")
    return True

def filter_quality_frames(frames_list, output_filtered_dir, min_variance=15.0, min_brightness=20.0, max_frames=60):
    """
    Filters out near-black, blurry, duplicate, and low-texture frames before COLMAP.
    - Near-black / dark frames: dropped if mean brightness < 20 or max pixel < 40
    - Blurry frames: dropped if Laplacian variance < 15
    - Low-texture frames: dropped if fast ORB keypoints < 50 (skipped, not fatal)
    - Duplicate frames: dropped if histogram correlation > 0.995
    - Sub-samples to at most max_frames (default 30) for safe memory usage
    """
    out_dir = Path(output_filtered_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    accepted = []
    prev_hist = None
    orb = cv2.ORB_create(nfeatures=500)

    for fpath in frames_list:
        p = Path(fpath)
        img = cv2.imread(str(p))
        if img is None:
            print(f"[Filter] Could not read frame {p.name}, skipping")
            continue
        
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        brightness = float(np.mean(gray))
        max_pixel = float(np.max(gray))

        # 1. Reject black / near-black frames
        if brightness < min_brightness or max_pixel < 40.0:
            print(f"[Filter] Dropping near-black frame {p.name} (mean={brightness:.1f}, max={max_pixel:.1f})")
            continue

        # 2. Reject blurry frames (Laplacian variance)
        var = float(cv2.Laplacian(gray, cv2.CV_64F).var())
        if var < min_variance:
            print(f"[Filter] Dropping blurry frame {p.name} (sharpness={var:.1f} < {min_variance})")
            continue

        # 3. Reject low-texture frames (skipped, not fatal)
        kps = orb.detect(gray, None)
        if len(kps) < 50:
            print(f"[Filter] Skipping low-feature frame {p.name} (keypoints={len(kps)} < 50)")
            continue

        # 4. Reject duplicate / static frames
        hist = cv2.calcHist([gray], [0], None, [64], [0, 256])
        cv2.normalize(hist, hist)
        if prev_hist is not None:
            similarity = cv2.compareHist(prev_hist, hist, cv2.HISTCMP_CORREL)
            if similarity > 0.995:
                print(f"[Filter] Skipping duplicate frame {p.name} (similarity={similarity:.3f})")
                continue
        
        prev_hist = hist
        dest_path = out_dir / p.name
        shutil.copyfile(str(p), str(dest_path))
        accepted.append(str(dest_path))

    # Fallback: if blur filtering was slightly too aggressive but frames are valid,
    # select evenly spaced original non-black frames
    if len(accepted) < 4 and len(frames_list) >= 4:
        print("[Filter] Quality filtering left < 4 frames; evaluating fallback non-black frames...")
        non_black = []
        for fpath in frames_list:
            img = cv2.imread(fpath)
            if img is not None:
                g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
                if np.mean(g) >= 15.0 and np.max(g) >= 30.0:
                    non_black.append(fpath)
        if len(non_black) >= 4:
            step = max(1, len(non_black) // 20)
            for idx in range(0, len(non_black), step):
                src_p = Path(non_black[idx])
                dst_p = out_dir / f"fallback_{idx:04d}_{src_p.name}"
                shutil.copyfile(str(src_p), str(dst_p))
                accepted.append(str(dst_p))

    # Cap accepted frames at max_frames (e.g. 30) for safe memory usage
    if len(accepted) > max_frames:
        print(f"[Filter] Sub-sampling {len(accepted)} accepted frames down to max_frames={max_frames}")
        step = len(accepted) / max_frames
        indices = set(int(i * step) for i in range(max_frames))
        kept = []
        for idx, fpath in enumerate(accepted):
            if idx in indices and len(kept) < max_frames:
                kept.append(fpath)
            else:
                try:
                    os.remove(fpath)
                except OSError:
                    pass
        accepted = kept

    print(f"[Filter] Accepted {len(accepted)} high-quality frames for 3D reconstruction")
    if len(accepted) < 4:
        raise InsufficientQualityException(
            "INSUFFICIENT_RECONSTRUCTION_QUALITY",
            f"Only {len(accepted)} quality frames remained after dropping black, blurry, or low-texture frames.",
            "Record slowly with smooth camera movement, rich surface detail, and ample lighting."
        )

    return accepted

def resolve_colmap_bin(colmap_bin=None):
    if colmap_bin and os.path.isfile(colmap_bin) and not colmap_bin.lower().endswith(".bat"):
        return str(Path(colmap_bin).resolve())

    env_col = os.environ.get("COLMAP_PATH")
    candidates = [
        env_col,
        str(BACKEND_ROOT / "tools" / "colmap" / "bin" / "colmap.exe"),
        str(BACKEND_ROOT / "tools" / "colmap" / "colmap.exe"),
        shutil.which("colmap"),
        "/opt/homebrew/bin/colmap",
        "/usr/local/bin/colmap",
        "/usr/bin/colmap",
    ]
    for c in candidates:
        if not c:
            continue
        c_path = Path(c)
        if c_path.is_file():
            if c_path.suffix.lower() == ".bat":
                bin_candidate = c_path.parent / "bin" / "colmap.exe"
                if bin_candidate.is_file():
                    return str(bin_candidate.resolve())
                root_candidate = c_path.parent / "colmap.exe"
                if root_candidate.is_file():
                    return str(root_candidate.resolve())
            else:
                return str(c_path.resolve())

    found = shutil.which("colmap")
    if found:
        return str(Path(found).resolve())

    raise ServerProcessingException("COLMAP binary not found on this system. Please verify COLMAP installation.")

def run_colmap_sfm(image_dir, workspace_dir, colmap_bin=None, job_id=None, log_file=None):
    """
    Executes COLMAP Structure from Motion (Feature extraction, sequential matching, mapper)
    to estimate camera poses and reconstruct sparse 3D geometry.
    """
    colmap_bin = resolve_colmap_bin(colmap_bin)
    print(f"[COLMAP] Using verified binary: {colmap_bin}")

    ws_dir = Path(workspace_dir).resolve()
    ws_dir.mkdir(parents=True, exist_ok=True)
    database_path = ws_dir / "database.db"
    sparse_path = ws_dir / "sparse"
    sparse_path.mkdir(parents=True, exist_ok=True)

    img_dir = Path(image_dir).resolve()

    colmap_env = os.environ.copy()
    colmap_env["OMP_NUM_THREADS"] = "1"

    # 1. Feature Extraction (SIFT) — single thread on CPU prevents STATUS_ACCESS_VIOLATION / OOM crashes on Windows
    cmd_extract = [
        colmap_bin, "feature_extractor",
        "--database_path", str(database_path),
        "--image_path", str(img_dir),
        "--ImageReader.single_camera", "1",
        "--ImageReader.camera_model", "SIMPLE_RADIAL",
        "--FeatureExtraction.use_gpu", "0",
        "--FeatureExtraction.num_threads", "1",
        "--FeatureExtraction.max_image_size", "960",
        "--SiftExtraction.max_num_features", "4000",
        "--SiftExtraction.peak_threshold", "0.003",
        "--SiftExtraction.edge_threshold", "10",
    ]
    res = run_command(cmd_extract, job_id=job_id, timeout=600, log_path=log_file, env=colmap_env, check=False)
    print(f"[COLMAP] feature_extractor returncode={res.returncode}")
    if res.returncode != 0:
        err_msg = format_process_error("COLMAP feature_extractor", res.returncode, res.stdout, res.stderr, log_path=log_file)
        raise ServerProcessingException(err_msg, log_path=str(log_file) if log_file else None)

    # 2. Configurable Matching Strategy (sequential vs exhaustive automatic selection)
    matching_strategy = os.environ.get("MATCHING_STRATEGY", "auto").lower()
    exhaustive_max_frames = int(os.environ.get("EXHAUSTIVE_MAX_FRAMES", 70))

    image_count = len(list(img_dir.glob("*.png"))) + len(list(img_dir.glob("*.jpg")))
    try:
        import psutil
        free_ram_mb = psutil.virtual_memory().available / (1024 * 1024)
    except Exception:
        free_ram_mb = 1000.0

    use_exhaustive = False
    if matching_strategy == "exhaustive":
        use_exhaustive = True
        print(f"[COLMAP] Explicitly configured EXHAUSTIVE matching (frames={image_count})")
    elif matching_strategy == "sequential":
        use_exhaustive = False
        print(f"[COLMAP] Explicitly configured SEQUENTIAL matching (frames={image_count}, overlap=20)")
    else:  # "auto"
        # Choose exhaustive when frames <= EXHAUSTIVE_MAX_FRAMES (default 70) and free RAM allows
        if image_count <= exhaustive_max_frames and free_ram_mb > 500.0:
            use_exhaustive = True
            print(f"[COLMAP] Auto-selected EXHAUSTIVE matching (frames={image_count} <= {exhaustive_max_frames}, free_ram={free_ram_mb:.0f}MB)")
        else:
            use_exhaustive = False
            print(f"[COLMAP] Auto-selected SEQUENTIAL matching (frames={image_count}, overlap=20, quadratic=1)")

    matched = False
    if use_exhaustive:
        cmd_match = [
            colmap_bin, "exhaustive_matcher",
            "--database_path", str(database_path),
            "--FeatureMatching.use_gpu", "0",
            "--FeatureMatching.num_threads", "2",
            "--ExhaustiveMatching.block_size", "50",
        ]
        res = run_command(cmd_match, job_id=job_id, timeout=600, log_path=log_file, env=colmap_env, check=False)
        print(f"[COLMAP] exhaustive_matcher returncode={res.returncode}")
        if res.returncode == 0:
            matched = True
        else:
            print("[COLMAP] Exhaustive matcher failed, falling back to sequential matcher...")

    if not matched:
        cmd_match = [
            colmap_bin, "sequential_matcher",
            "--database_path", str(database_path),
            "--FeatureMatching.use_gpu", "0",
            "--FeatureMatching.num_threads", "2",
            "--SequentialMatching.num_threads", "2",
            "--SequentialMatching.overlap", "20",
            "--SequentialMatching.quadratic_overlap", "1",
        ]
        res = run_command(cmd_match, job_id=job_id, timeout=600, log_path=log_file, env=colmap_env, check=False)
        print(f"[COLMAP] sequential_matcher returncode={res.returncode}")
        if res.returncode == 0:
            matched = True
        else:
            err_msg = format_process_error("COLMAP feature matching", res.returncode, res.stdout, res.stderr, log_path=log_file)
            raise ServerProcessingException(err_msg, log_path=str(log_file) if log_file else None)

    # 3. Incremental Mapper — relaxed thresholds for indoor/mobile video, capped at 2 threads
    cmd_mapper = [
        colmap_bin, "mapper",
        "--database_path", str(database_path),
        "--image_path", str(img_dir),
        "--output_path", str(sparse_path),
        "--Mapper.num_threads", "2",
        "--Mapper.min_num_matches", "10",
        "--Mapper.init_min_num_inliers", "60",
        "--Mapper.abs_pose_min_num_inliers", "20",
        "--Mapper.abs_pose_min_inlier_ratio", "0.1",
        "--Mapper.max_extra_param", "1",
    ]
    res = run_command(cmd_mapper, job_id=job_id, timeout=1200, log_path=log_file, env=colmap_env, check=False)
    print(f"[COLMAP] mapper returncode={res.returncode}")
    if res.returncode != 0:
        err_msg = format_process_error("COLMAP incremental mapper", res.returncode, res.stdout, res.stderr, log_path=log_file)
        raise ServerProcessingException(err_msg, log_path=str(log_file) if log_file else None)

    # Find all reconstructed submodels in sparse/ and evaluate registered stats
    subdirs = [d for d in sparse_path.iterdir() if d.is_dir()]
    if not subdirs:
        raise InsufficientQualityException(
            "INSUFFICIENT_RECONSTRUCTION_QUALITY",
            "Structure-from-Motion could not register camera poses. Try recording in a well-lit area with more texture (avoid plain white walls).",
            "Move the camera slowly in a wide arc around the subject, keeping it in frame at all times."
        )

    import struct
    def read_submodel_header(d):
        dp = Path(d)
        img_c = 0
        pts_c = 0
        img_bin = dp / "images.bin"
        pts_bin = dp / "points3D.bin"
        if img_bin.is_file():
            try:
                with open(img_bin, "rb") as f:
                    img_c = struct.unpack("<Q", f.read(8))[0]
            except Exception:
                pass
        if pts_bin.is_file():
            try:
                with open(pts_bin, "rb") as f:
                    pts_c = struct.unpack("<Q", f.read(8))[0]
            except Exception:
                pass
        return {"path": str(dp), "name": dp.name, "images": img_c, "points": pts_c}

    submodel_stats = [read_submodel_header(d) for d in subdirs]
    submodel_stats.sort(key=lambda s: s["images"], reverse=True)

    total_submodel_images = sum(s["images"] for s in submodel_stats)
    total_submodel_points = sum(s["points"] for s in submodel_stats)

    model_dir = submodel_stats[0]["path"]
    discarded_stats = []
    discarded_points_total = 0

    # Step 11: Multi-model handling (attempt model_merger if multiple submodels exist)
    if len(submodel_stats) > 1:
        merged_candidate = ws_dir / "merged_model"
        cmd_merge = [
            colmap_bin, "model_merger",
            "--input_path1", submodel_stats[0]["path"],
            "--input_path2", submodel_stats[1]["path"],
            "--output_path", str(merged_candidate),
            "--max_reproj_error", "64",
        ]
        res_merge = run_command(cmd_merge, job_id=job_id, timeout=60, log_path=log_file, env=colmap_env, check=False)
        if res_merge.returncode == 0 and (merged_candidate / "images.bin").is_file():
            print(f"[COLMAP] Successfully merged submodels '{submodel_stats[0]['name']}' and '{submodel_stats[1]['name']}' into unified model")
            model_dir = str(merged_candidate)
        else:
            print(f"[COLMAP] Model merger unsuccessful. Kept dominant submodel '{submodel_stats[0]['name']}' ({submodel_stats[0]['images']} images, {submodel_stats[0]['points']} pts)")
            for discarded in submodel_stats[1:]:
                discarded_stats.append(discarded)
                discarded_points_total += discarded["points"]
            print(f"[COLMAP] Discarded {len(discarded_stats)} submodel(s) with total {discarded_points_total} points")

    best_score = read_submodel_header(model_dir)["points"]
    if best_score <= 8:
        raise InsufficientQualityException(
            "INSUFFICIENT_RECONSTRUCTION_QUALITY",
            "Structure-from-Motion could not recover 3D points from this footage. Insufficient parallax or feature overlap between viewpoints.",
            "Capture the scene by moving your camera smoothly in an arc around the subject with 60%+ overlap between angles."
        )

    # 4. Convert model to PLY and TXT for inspection
    ply_path = ws_dir / "points3D.ply"
    cmd_convert_ply = [
        colmap_bin, "model_converter",
        "--input_path", str(model_dir),
        "--output_path", str(ply_path),
        "--output_type", "PLY"
    ]
    run_command(cmd_convert_ply, job_id=job_id, timeout=120, log_path=log_file, env=colmap_env, check=True)

    txt_dir = ws_dir / "txt"
    txt_dir.mkdir(parents=True, exist_ok=True)
    cmd_convert_txt = [
        colmap_bin, "model_converter",
        "--input_path", str(model_dir),
        "--output_path", str(txt_dir),
        "--output_type", "TXT"
    ]
    run_command(cmd_convert_txt, job_id=job_id, timeout=120, log_path=log_file, env=colmap_env, check=True)

    # 5. Validate registered cameras and 3D points
    images_txt = txt_dir / "images.txt"
    registered_count = 0
    if images_txt.is_file():
        with open(images_txt, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                if line.startswith("#"):
                    continue
                parts = line.strip().split()
                if len(parts) >= 10 and any(p.lower().endswith((".png", ".jpg", ".jpeg", ".webp")) for p in parts):
                    registered_count += 1

    print(f"[COLMAP] Registered camera poses: {registered_count}")

    if registered_count < 3:
        raise InsufficientQualityException(
            "INSUFFICIENT_RECONSTRUCTION_QUALITY",
            f"Only {registered_count} camera poses could be successfully registered in 3D space.",
            "Record a continuous loop around the location without sudden turns or blurred motion."
        )

    sfm_stats = {
        "submodels": submodel_stats,
        "discarded": discarded_stats,
        "discardedPoints": discarded_points_total,
        "totalSubmodelImages": total_submodel_images,
        "totalSubmodelPoints": total_submodel_points
    }

    return str(ply_path), registered_count, str(model_dir), sfm_stats

def reconstruct_mesh_and_export_glb(ply_path, output_glb_path, thumbnail_path, registered_frames_count=0, **kwargs):
    """
    Generates a dense surface mesh using Open3D and Trimesh,
    applies real photogrammetric vertex colors, centers the scene, and exports a valid GLB asset.
    """
    if not os.path.exists(ply_path) or os.path.getsize(ply_path) < 100:
        raise InsufficientQualityException(
            "INSUFFICIENT_RECONSTRUCTION_QUALITY",
            "The photogrammetry point cloud is empty or contains zero reconstructed 3D points.",
            "Record more diverse angles with rich surface detail."
        )

    # Lazy load heavy 3D libraries when mesh reconstruction actually runs
    import open3d as o3d
    import trimesh

    # Load point cloud with Open3D
    pcd = o3d.io.read_point_cloud(ply_path)
    points = np.asarray(pcd.points)
    
    if len(points) < 30:
        raise InsufficientQualityException(
            "INSUFFICIENT_RECONSTRUCTION_QUALITY",
            f"Reconstruction yielded only {len(points)} sparse 3D points, which is insufficient to form an authentic 3D digital twin.",
            "Ensure the camera moves along a baseline trajectory rather than pivoting in a single spot."
        )

    # Remove statistical outliers if cloud is sufficiently dense
    if len(points) >= 40:
        try:
            cl, ind = pcd.remove_statistical_outlier(nb_neighbors=min(20, len(points) - 1), std_ratio=2.0)
            if len(cl.points) >= 15:
                pcd = cl
                points = np.asarray(pcd.points)
        except Exception as e:
            print(f"[Pipeline] Outlier removal skipped: {e}")

    points = np.asarray(pcd.points)
    colors = np.asarray(pcd.colors)

    if len(colors) == 0 or len(colors) != len(points):
        # Default warm architectural tone if colors missing
        colors = np.ones((len(points), 3)) * 0.8

    # Slight brightness boost for indoor captures if overall luminance is dark
    if np.mean(colors) < 0.45:
        colors_boosted = np.clip(colors * 1.35, 0.0, 1.0)
    else:
        colors_boosted = colors

    # Estimate surface normals
    pcd.estimate_normals(search_param=o3d.geometry.KDTreeSearchParamHybrid(radius=0.5, max_nn=30))
    pcd.orient_normals_consistent_tangent_plane(15)

    # Mesh reconstruction via Poisson (depth 8 default for memory safety, conservative trimming at quantile 0.05)
    poisson_depth = int(os.environ.get("POISSON_DEPTH", 8))
    mesh = None
    try:
        if len(points) >= 100:
            poisson_mesh, densities = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(pcd, depth=poisson_depth)
            # Conservative trimming: drop bottom 5% density to preserve room boundary
            densities = np.asarray(densities)
            density_threshold = np.quantile(densities, 0.05)
            vertices_to_remove = densities < density_threshold
            poisson_mesh.remove_vertices_by_mask(vertices_to_remove)
            
            if len(poisson_mesh.triangles) > 50:
                mesh = poisson_mesh
    except Exception as e:
        print(f"[Pipeline] Poisson meshing fallback: {e}")

    # Fallback to Ball Pivoting or convex cluster mesh if Poisson produced an empty mesh
    if mesh is None or len(mesh.triangles) < 50:
        try:
            distances = pcd.compute_nearest_neighbor_distance()
            avg_dist = np.mean(distances) if len(distances) > 0 else 0.1
            radii = [avg_dist * 1.5, avg_dist * 2.5, avg_dist * 4.0]
            mesh = o3d.geometry.TriangleMesh.create_from_point_cloud_ball_pivoting(
                pcd, o3d.utility.DoubleVector(radii)
            )
        except Exception as e:
            print(f"[Pipeline] Ball pivoting fallback: {e}")

    # Build Trimesh geometries
    os.makedirs(os.path.dirname(output_glb_path), exist_ok=True)
    out_dir = Path(output_glb_path).parent
    
    pt_cloud = trimesh.PointCloud(
        vertices=points,
        colors=(np.clip(colors_boosted, 0, 1) * 255).astype(np.uint8)
    )

    n_comp = 1
    if mesh is not None and len(mesh.triangles) > 30:
        v = np.asarray(mesh.vertices)
        f = np.asarray(mesh.triangles)
        pcd_tree = o3d.geometry.KDTreeFlann(pcd)
        c = np.zeros_like(v)
        for i, vert in enumerate(v):
            _, idx, _ = pcd_tree.search_knn_vector_3d(vert, 1)
            c[i] = colors_boosted[idx[0]]
        
        tri_mesh = trimesh.Trimesh(
            vertices=v,
            faces=f,
            vertex_colors=(np.clip(c, 0, 1) * 255).astype(np.uint8),
            process=True
        )

        # Remove tiny disconnected components (< 5% of largest component's triangle count)
        try:
            import scipy.sparse as sp
            import scipy.sparse.csgraph as csgraph
            adj = tri_mesh.face_adjacency
            n_faces = len(tri_mesh.faces)
            if len(adj) > 0:
                mat = sp.coo_matrix((np.ones(len(adj)), (adj[:, 0], adj[:, 1])), shape=(n_faces, n_faces))
                n_comp, labels = csgraph.connected_components(mat, directed=False)
                counts = np.bincount(labels)
                max_c = np.max(counts)
                keep_comp = np.where(counts >= (0.05 * max_c))[0]
                if len(keep_comp) < n_comp:
                    keep_face_mask = np.isin(labels, keep_comp)
                    tri_mesh = tri_mesh.submesh([keep_face_mask], append=True)
                    print(f"[Meshing] Removed {n_comp - len(keep_comp)} tiny disconnected mesh fragments (< 5% of main structure)")
        except Exception as e:
            print(f"[Meshing] Component filtering note: {e}")
    else:
        tri_mesh = pt_cloud

    # Step 5b: Floor-plane alignment and centering via RANSAC
    alignment_meta = {}
    try:
        from navigation.alignment import align_mesh_or_points
        tri_mesh, transform_matrix, alignment_meta = align_mesh_or_points(tri_mesh)
        pt_cloud.apply_transform(transform_matrix)
        print(f"[Pipeline] Geometry floor aligned to y=0 with {alignment_meta.get('floorInliersCount', 0)} inliers")
    except Exception as e:
        print(f"[Pipeline] Alignment warning, falling back to simple centering: {e}")
        bounds = tri_mesh.bounds
        if bounds is not None:
            center = (bounds[0] + bounds[1]) / 2.0
            tri_mesh.apply_translation(-center)
            pt_cloud.apply_translation(-center)

    bounds = tri_mesh.bounds
    if bounds is not None:
        min_b = bounds[0]
        max_b = bounds[1]
    else:
        min_b = np.array([-1.0, 0.0, -1.0])
        max_b = np.array([1.0, 2.0, 1.0])

    # Export to GLB with both surface mesh and authentic point cloud
    scene_glb = trimesh.Scene()
    scene_glb.add_geometry(tri_mesh, node_name="surface_mesh", geom_name="surface_mesh")
    scene_glb.add_geometry(pt_cloud, node_name="point_cloud", geom_name="point_cloud")
    scene_glb.export(output_glb_path, file_type="glb")

    # Step 5c: Structural Shell & Floor Plan Generation (Phase E)
    shell_meta = {}
    shell_success = False
    try:
        from structural_shell import detect_planes_and_build_shell
        shell_res = detect_planes_and_build_shell(np.asarray(pt_cloud.vertices))
        if shell_res["success"]:
            shell_success = True
            shell_meta = shell_res["metrics"]
            # Export shell.glb
            shell_glb_path = out_dir / "shell.glb"
            shell_res["shell_scene"].export(str(shell_glb_path), file_type="glb")
            # Export floorplan.geojson
            floorplan_path = out_dir / "floorplan.geojson"
            with open(floorplan_path, "w", encoding="utf-8") as f:
                json.dump(shell_res["geojson"], f, indent=2)
            print(f"[Pipeline] Structural shell exported ({shell_meta.get('area_sqm')} m², {shell_meta.get('wall_count')} walls, {shell_meta.get('inferred_wall_count')} inferred)")
        else:
            print(f"[Pipeline] Structural shell skipped: {shell_res.get('reason')}")
    except Exception as e:
        print(f"[Pipeline] Structural shell generation warning: {e}")

    # Generate preview thumbnail
    os.makedirs(os.path.dirname(thumbnail_path), exist_ok=True)
    proc_dir = os.path.dirname(os.path.dirname(ply_path))
    filtered_frames = sorted(
        glob.glob(os.path.join(proc_dir, "filtered_frames", "*.png"))
        or glob.glob(os.path.join(proc_dir, "raw_frames", "*.png"))
    )
    if filtered_frames:
        shutil.copyfile(filtered_frames[len(filtered_frames) // 2], thumbnail_path)
    else:
        img = Image.new("RGB", (640, 480), color=(15, 23, 42))
        img.save(thumbnail_path)

    # Validate output
    file_size = os.path.getsize(output_glb_path)
    if file_size < 500:
        raise InsufficientQualityException(
            "GLB_EXPORT_FAILED",
            "Exported 3D GLB file is empty or corrupted.",
            "Please record the location again."
        )

    # Step 5d: Generate 2D navigation occupancy grid
    navgrid_meta = {}
    is_partial = kwargs.get("is_partial", False)
    # Rule 12: Disable navigation graph generation for partial scans unless structural shell closed the floor polygon
    if is_partial and not shell_success:
        navgrid_meta = {
            "navigationReady": False,
            "reason": "Navigation graph disabled on partial scan (floor polygon not closed)"
        }
        print("[Pipeline] Navigation graph disabled for partial scan without closed floor plan")
    else:
        try:
            from navigation.occupancy import generate_occupancy_grid_from_floor_plan, generate_occupancy_grid
            from navigation.minimap import extract_wall_segments

            if shell_success and shell_res.get("floor_polygon") is not None:
                occ_grid, _ = generate_occupancy_grid_from_floor_plan(
                    floor_polygon=shell_res["floor_polygon"],
                    points=np.asarray(pt_cloud.vertices),
                    y_floor=shell_res.get("y_floor", 0.0),
                    resolution=0.05,
                    agent_radius=0.30
                )
            else:
                occ_grid = generate_occupancy_grid(tri_mesh, resolution=0.05, agent_radius=0.25)

            wall_data = extract_wall_segments(occ_grid)

            nav_dir = os.path.join(os.path.dirname(os.path.dirname(output_glb_path)), "navigation")
            os.makedirs(nav_dir, exist_ok=True)
            nav_file = os.path.join(nav_dir, "navgrid.json")

            navgrid_payload = {
                "resolution": occ_grid.resolution,
                "origin": [occ_grid.min_x, occ_grid.min_z],
                "width": occ_grid.width,
                "height": occ_grid.height,
                "bounds": {
                    "minX": occ_grid.min_x,
                    "maxX": occ_grid.max_x,
                    "minZ": occ_grid.min_z,
                    "maxZ": occ_grid.max_z,
                },
                "grid": occ_grid.grid.tolist(),
                "wallSegments": wall_data.get("wallSegments", []),
                "totalSegments": wall_data.get("totalSegments", 0),
            }
            with open(nav_file, "w") as f:
                json.dump(navgrid_payload, f)

            navgrid_meta = {
                "navigationReady": True,
                "resolution": occ_grid.resolution,
                "gridDimensions": [occ_grid.width, occ_grid.height],
                "totalWallSegments": wall_data.get("totalSegments", 0),
            }
            print(f"[Pipeline] Navigation grid generated and saved to {nav_file}")
        except Exception as e:
            print(f"[Pipeline] Navigation grid generation warning: {e}")

    vert_count = len(tri_mesh.vertices) if hasattr(tri_mesh, "vertices") else len(points)
    face_count = len(tri_mesh.faces) if hasattr(tri_mesh, "faces") else 0

    # Step 15: Export metrics.json per project
    metrics_payload = {
        "registeredFrames": registered_frames_count,
        "totalExtractedFrames": kwargs.get("total_extracted_frames", registered_frames_count),
        "registeredRatio": round(kwargs.get("registered_ratio", 1.0), 4),
        "sparsePoints": len(points),
        "meshVertices": vert_count,
        "meshTriangles": face_count,
        "meshComponents": n_comp,
        "detectedPlanes": {
            "floor": shell_success,
            "ceiling": (shell_success and not shell_res.get("ceiling_inferred", True)),
            "walls": shell_meta.get("wall_count", 0) if shell_success else 0
        },
        "shell": shell_meta if shell_success else None,
        "inferredPercentage": shell_meta.get("inferred_percentage", 0.0) if shell_success else 0.0,
        "source": "photogrammetry",
        "status": "partial" if is_partial else "completed"
    }
    try:
        with open(out_dir / "metrics.json", "w", encoding="utf-8") as f:
            json.dump(metrics_payload, f, indent=2)
    except Exception as e:
        print(f"[Pipeline] metrics.json export note: {e}")

    return {
        "success": True,
        "fileSizeBytes": file_size,
        "vertices": vert_count,
        "triangles": face_count,
        "points3D": len(points),
        "registeredFrames": registered_frames_count,
        "boundingBox": {
            "minX": float(min_b[0]),
            "minY": float(min_b[1]),
            "minZ": float(min_b[2]),
            "maxX": float(max_b[0]),
            "maxY": float(max_b[1]),
            "maxZ": float(max_b[2]),
        },
        "alignment": alignment_meta,
        "navigation": navgrid_meta,
        "shell": shell_meta if shell_success else None,
        "shellSuccess": shell_success,
        "metrics": metrics_payload
    }

def run_pipeline(job_id, project_id, video_path, storage_dir, processing_dir, callback_url=None):
    """
    Executes the complete video-to-3D photogrammetric digital twin reconstruction pipeline.
    """
    report_stage("probing", 15, "Probing video structure and inspecting keyframes", callback_url, project_id, job_id)

    proj_proc_dir = Path(processing_dir).resolve() / str(project_id)
    frames_dir = proj_proc_dir / "raw_frames"
    filtered_dir = proj_proc_dir / "filtered_frames"
    colmap_dir = proj_proc_dir / "colmap_workspace"
    log_file_path = proj_proc_dir / "pipeline.log"

    final_model_dir = Path(storage_dir).resolve() / "projects" / str(project_id) / "final"
    preview_dir = Path(storage_dir).resolve() / "projects" / str(project_id) / "preview"
    output_glb_path = final_model_dir / "scene.glb"
    thumbnail_path = preview_dir / "thumbnail.jpg"

    proj_proc_dir.mkdir(parents=True, exist_ok=True)
    frames_dir.mkdir(parents=True, exist_ok=True)
    filtered_dir.mkdir(parents=True, exist_ok=True)
    colmap_dir.mkdir(parents=True, exist_ok=True)
    final_model_dir.mkdir(parents=True, exist_ok=True)
    preview_dir.mkdir(parents=True, exist_ok=True)

    # Step 1: Extract frames from video
    report_stage("frames", 25, "Extracting and filtering high-quality frames", callback_url, project_id, job_id)
    raw_frames = extract_frames(video_path, str(frames_dir), job_id=job_id, log_file=str(log_file_path))

    # Step 1b: Early Rejection Pre-checks (brightness, blur, keypoints, camera motion)
    check_early_rejection(raw_frames)

    # Step 2: Quality & Blur filtering
    filtered_frames = filter_quality_frames(raw_frames, str(filtered_dir), max_frames=len(raw_frames))

    # Step 3 & 4: COLMAP SfM (feature matching, poses, sparse 3D geometry)
    report_stage("features", 45, "Extracting 2D feature points (SIFT)", callback_url, project_id, job_id)
    report_stage("matching", 60, "Matching feature descriptors across camera angles", callback_url, project_id, job_id)
    report_stage("sfm", 75, "Recovering 3D camera poses and sparse structure", callback_url, project_id, job_id)
    ply_path, reg_count, _, sfm_stats = run_colmap_sfm(str(filtered_dir), str(colmap_dir), job_id=job_id, log_file=str(log_file_path))

    # Step 12: Partial-result honesty evaluation
    reg_ratio = float(reg_count) / max(1, len(filtered_frames))
    total_sub_imgs = sfm_stats.get("totalSubmodelImages", reg_count)
    submodel_share = (float(reg_count) / float(total_sub_imgs)) if total_sub_imgs > 0 else 1.0

    is_partial = (reg_ratio < 0.40) or (submodel_share < 0.60)
    pct_mapped = int(round(reg_ratio * 100))
    partial_warning = f"Partial scan ({pct_mapped}% of room mapped)" if is_partial else None
    partial_tip = "Camera traversed featureless walls or moved too quickly. Try recording with slower pacing and higher overlap." if is_partial else None

    # Step 5 & 6: Dense geometry, mesh generation & GLB export
    report_stage("meshing", 85, "Reconstructing 3D surface mesh geometry", callback_url, project_id, job_id)
    report_stage("export", 95, "Exporting and optimizing GLB digital twin", callback_url, project_id, job_id)
    recon_stats = reconstruct_mesh_and_export_glb(
        ply_path, str(output_glb_path), str(thumbnail_path),
        registered_frames_count=reg_count,
        is_partial=is_partial,
        registered_ratio=reg_ratio,
        total_extracted_frames=len(raw_frames)
    )

    stage_status = "partial" if is_partial else "completed"
    report_stage(stage_status, 100, f"3D Digital Twin {'partially' if is_partial else 'successfully'} generated", callback_url, project_id, job_id)

    return {
        "success": True,
        "status": stage_status,
        "isPartial": is_partial,
        "partialWarning": partial_warning,
        "partialTip": partial_tip,
        "registeredRatio": round(reg_ratio, 4),
        "source": "photogrammetry",
        "modelUrl": f"/storage/projects/{project_id}/final/scene.glb",
        "shellUrl": f"/storage/projects/{project_id}/final/shell.glb" if recon_stats.get("shellSuccess") else None,
        "floorplanUrl": f"/storage/projects/{project_id}/final/floorplan.geojson" if recon_stats.get("shellSuccess") else None,
        "metricsUrl": f"/storage/projects/{project_id}/final/metrics.json",
        "thumbnailUrl": f"/storage/projects/{project_id}/preview/thumbnail.jpg",
        "finalModelPath": str(output_glb_path),
        "logPath": str(log_file_path),
        "boundingBox": recon_stats["boundingBox"],
        "metadata": {
            "status": stage_status,
            "registeredFrames": recon_stats["registeredFrames"],
            "totalExtractedFrames": len(raw_frames),
            "registeredRatio": round(reg_ratio, 4),
            "points3D": recon_stats["points3D"],
            "triangles": recon_stats["triangles"],
            "vertices": recon_stats["vertices"],
            "fileSizeBytes": recon_stats["fileSizeBytes"],
            "reconstructionQuality": "COLMAP Structure-from-Motion & Multi-View Stereo",
            "scaleMeters": f"{recon_stats['boundingBox']['maxX'] - recon_stats['boundingBox']['minX']:.1f}m × {recon_stats['boundingBox']['maxY'] - recon_stats['boundingBox']['minY']:.1f}m × {recon_stats['boundingBox']['maxZ'] - recon_stats['boundingBox']['minZ']:.1f}m",
            "alignment": recon_stats.get("alignment", {}),
            "navigation": recon_stats.get("navigation", {}),
            "shell": recon_stats.get("shell"),
            "metrics": recon_stats.get("metrics")
        }
    }
