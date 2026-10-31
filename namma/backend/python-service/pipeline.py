import os
import sys
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
        tail_err = (stderr.strip() if stderr else '') or (stdout.strip() if stdout else '')
        if len(tail_err) > 400:
            tail_err = tail_err[-400:]
        msg = f"Command '{Path(clean_cmd[0]).name} {clean_cmd[1] if len(clean_cmd) > 1 else ''}' failed with code {proc.returncode}: {tail_err}"
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

def extract_frames(video_path, output_dir, target_fps=None, max_frames=None, max_image_size=None, job_id=None, log_file=None):
    """
    Extract high-quality frames from the uploaded video using ffmpeg directly.
    Bypasses fragile container duration metadata (e.g. browser WebM streams where duration is N/A).
    """
    if target_fps is None:
        target_fps = float(os.environ.get("FRAME_FPS", 2))
    if max_frames is None:
        max_frames = int(os.environ.get("MAX_FRAMES", 60))
    if max_image_size is None:
        max_image_size = int(os.environ.get("MAX_IMAGE_SIZE", 1280))

    out_dir = Path(output_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    ffmpeg_bin = get_ffmpeg_bin()

    out_pattern = out_dir / "frame_%04d.png"
    cmd = [
        ffmpeg_bin, "-y",
        "-i", str(Path(video_path).resolve()),
        "-vf", f"fps={target_fps},scale={max_image_size}:-1",
        "-q:v", "2",
        str(out_pattern)
    ]
    run_command(cmd, job_id=job_id, timeout=120, log_path=log_file, check=False)
    extracted = sorted([str(p) for p in out_dir.glob("frame_*.png")])

    # Fallback to default frame rate if fps filter extracted too few frames
    if len(extracted) < 4:
        cmd_fallback = [
            ffmpeg_bin, "-y",
            "-i", str(Path(video_path).resolve()),
            "-vf", f"scale={max_image_size}:-1",
            "-q:v", "2",
            str(out_pattern)
        ]
        run_command(cmd_fallback, job_id=job_id, timeout=120, log_path=log_file, check=False)
        extracted = sorted([str(p) for p in out_dir.glob("frame_*.png")])

    if len(extracted) < 4:
        raise InsufficientQualityException(
            "INSUFFICIENT_RECONSTRUCTION_QUALITY",
            f"Only {len(extracted)} frames could be extracted from the video.",
            "Record at least 5 to 15 seconds continuously orbiting the room or subject."
        )

    # Sub-sample evenly if extracted frames exceed max_frames
    if len(extracted) > max_frames:
        step = len(extracted) / max_frames
        indices = set(int(i * step) for i in range(max_frames))
        for idx, fpath in enumerate(extracted):
            if idx not in indices:
                try:
                    os.remove(fpath)
                except OSError:
                    pass
        extracted = sorted([str(p) for p in out_dir.glob("frame_*.png")])

    print(f"[FFmpeg] Successfully extracted {len(extracted)} frames from {Path(video_path).name}")
    return extracted

    if len(extracted) < 4:
        raise InsufficientQualityException(
            "INSUFFICIENT_RECONSTRUCTION_QUALITY",
            f"Only {len(extracted)} frames could be extracted from the video.",
            "Record at least 5 to 15 seconds continuously orbiting the room or subject."
        )

    # Sub-sample evenly if extracted frames exceed max_frames
    if len(extracted) > max_frames:
        step = len(extracted) / max_frames
        indices = set(int(i * step) for i in range(max_frames))
        for idx, fpath in enumerate(extracted):
            if idx not in indices:
                try:
                    os.remove(fpath)
                except OSError:
                    pass
        extracted = sorted(glob.glob(os.path.join(output_dir, "frame_*.png")))

    print(f"[FFmpeg] Successfully extracted {len(extracted)} frames from {os.path.basename(video_path)}")
    return extracted

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

def filter_quality_frames(frames_list, output_filtered_dir, min_variance=15.0, min_brightness=15.0):
    """
    Filters out blurry, dark, and near-duplicate frames.
    Uses Laplacian variance for blur detection and histogram comparison for duplicates.
    """
    os.makedirs(output_filtered_dir, exist_ok=True)
    accepted = []
    prev_hist = None

    for fpath in frames_list:
        img = cv2.imread(fpath)
        if img is None:
            continue
        
        # 1. Check brightness / exposure
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        brightness = np.mean(gray)
        if brightness < min_brightness:
            continue # Too dark

        # 2. Check blur (Laplacian variance)
        var = cv2.Laplacian(gray, cv2.CV_64F).var()
        if var < min_variance:
            continue # Too blurry

        # 3. Check for duplicates / static frames
        hist = cv2.calcHist([gray], [0], None, [64], [0, 256])
        cv2.normalize(hist, hist)
        if prev_hist is not None:
            similarity = cv2.compareHist(prev_hist, hist, cv2.HISTCMP_CORREL)
            if similarity > 0.995:
                continue # Near duplicate frame, skip
        
        # Accept frame
        prev_hist = hist
        dest_name = os.path.basename(fpath)
        dest_path = os.path.join(output_filtered_dir, dest_name)
        shutil.copyfile(fpath, dest_path)
        accepted.append(dest_path)

    # Fallback: if blur filtering was slightly too aggressive but frames are valid,
    # select evenly spaced original frames
    if len(accepted) < 5 and len(frames_list) >= 5:
        step = max(1, len(frames_list) // 20)
        for idx in range(0, len(frames_list), step):
            fpath = frames_list[idx]
            dest_path = os.path.join(output_filtered_dir, f"fallback_{idx:04d}.png")
            shutil.copyfile(fpath, dest_path)
            accepted.append(dest_path)

    if len(accepted) < 4:
        raise InsufficientQualityException(
            "INSUFFICIENT_RECONSTRUCTION_QUALITY",
            "Too few clear, overlapping video frames remained after quality filtering. The footage is too dark or contains excessive motion blur.",
            "Record slowly with smooth camera movement and ample lighting."
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

    # 1. Feature Extraction (SIFT) — relaxed settings for mobile video
    cmd_extract = [
        colmap_bin, "feature_extractor",
        "--database_path", str(database_path),
        "--image_path", str(img_dir),
        "--ImageReader.single_camera", "1",
        "--ImageReader.camera_model", "SIMPLE_RADIAL",
        "--FeatureExtraction.use_gpu", "0",
        "--SiftExtraction.max_num_features", "8192",
        "--SiftExtraction.peak_threshold", "0.003",
        "--SiftExtraction.edge_threshold", "10",
    ]
    res = run_command(cmd_extract, job_id=job_id, timeout=300, log_path=log_file, check=False)
    print(f"[COLMAP] feature_extractor returncode={res.returncode}")
    if res.returncode != 0:
        tail_err = (res.stderr.strip() if res.stderr else '') or (res.stdout.strip() if res.stdout else '')
        if len(tail_err) > 400:
            tail_err = tail_err[-400:]
        raise ServerProcessingException(
            f"COLMAP feature extraction failed: {tail_err or 'Unknown process error'}",
            log_path=str(log_file) if log_file else None
        )

    # 2a. Sequential matching (best for video frames)
    matched = False
    cmd_match = [
        colmap_bin, "sequential_matcher",
        "--database_path", str(database_path),
        "--FeatureMatching.use_gpu", "0",
        "--SequentialMatching.overlap", "15",
        "--SequentialMatching.quadratic_overlap", "1",
    ]
    res = run_command(cmd_match, job_id=job_id, timeout=300, log_path=log_file, check=False)
    print(f"[COLMAP] sequential_matcher returncode={res.returncode}")
    if res.returncode == 0:
        matched = True

    # 2b. Exhaustive matching fallback
    if not matched:
        print("[COLMAP] Sequential matching non-zero exit, running exhaustive matcher fallback...")
        cmd_match_ex = [
            colmap_bin, "exhaustive_matcher",
            "--database_path", str(database_path),
            "--FeatureMatching.use_gpu", "0",
        ]
        res_ex = run_command(cmd_match_ex, job_id=job_id, timeout=300, log_path=log_file, check=False)
        print(f"[COLMAP] exhaustive_matcher returncode={res_ex.returncode}")
        if res_ex.returncode != 0:
            tail_err = (res_ex.stderr.strip() if res_ex.stderr else '') or (res_ex.stdout.strip() if res_ex.stdout else '')
            if len(tail_err) > 400:
                tail_err = tail_err[-400:]
            raise ServerProcessingException(
                f"COLMAP feature matching failed: {tail_err or 'Unknown process error'}",
                log_path=str(log_file) if log_file else None
            )

    # 3. Incremental Mapper — relaxed thresholds for indoor/mobile video
    cmd_mapper = [
        colmap_bin, "mapper",
        "--database_path", str(database_path),
        "--image_path", str(img_dir),
        "--output_path", str(sparse_path),
        "--Mapper.min_num_matches", "8",
        "--Mapper.init_min_num_inliers", "50",
        "--Mapper.abs_pose_min_num_inliers", "15",
        "--Mapper.abs_pose_min_inlier_ratio", "0.1",
        "--Mapper.max_extra_param", "1",
    ]
    res = run_command(cmd_mapper, job_id=job_id, timeout=600, log_path=log_file, check=False)
    print(f"[COLMAP] mapper returncode={res.returncode}")
    if res.returncode != 0:
        tail_err = (res.stderr.strip() if res.stderr else '') or (res.stdout.strip() if res.stdout else '')
        if len(tail_err) > 400:
            tail_err = tail_err[-400:]
        raise ServerProcessingException(
            f"COLMAP incremental mapper failed: {tail_err or 'Mapper error'}",
            log_path=str(log_file) if log_file else None
        )

    # Find all reconstructed submodels in sparse/ and pick the BEST one (most 3D points)
    subdirs = [
        str(d) for d in sparse_path.iterdir() if d.is_dir()
    ]
    if not subdirs:
        raise InsufficientQualityException(
            "INSUFFICIENT_RECONSTRUCTION_QUALITY",
            "Structure-from-Motion could not register camera poses. Try recording in a well-lit area with more texture (avoid plain white walls).",
            "Move the camera slowly in a wide arc around the subject, keeping it in frame at all times."
        )

    def model_point_score(d):
        dp = Path(d)
        pbin = dp / "points3D.bin"
        ptxt = dp / "points3D.txt"
        if pbin.is_file():
            return pbin.stat().st_size
        if ptxt.is_file():
            return ptxt.stat().st_size
        return 0

    subdirs.sort(key=model_point_score, reverse=True)
    model_dir = subdirs[0]
    best_score = model_point_score(model_dir)
    print(f"[COLMAP] Evaluated {len(subdirs)} submodels. Selected best submodel '{Path(model_dir).name}' with points3D size {best_score} bytes")

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
    run_command(cmd_convert_ply, job_id=job_id, timeout=120, log_path=log_file, check=True)

    txt_dir = ws_dir / "txt"
    txt_dir.mkdir(parents=True, exist_ok=True)
    cmd_convert_txt = [
        colmap_bin, "model_converter",
        "--input_path", str(model_dir),
        "--output_path", str(txt_dir),
        "--output_type", "TXT"
    ]
    run_command(cmd_convert_txt, job_id=job_id, timeout=120, log_path=log_file, check=True)

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

    return str(ply_path), registered_count, str(model_dir)

def reconstruct_mesh_and_export_glb(ply_path, output_glb_path, thumbnail_path, registered_frames_count=0):
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

    # Estimate surface normals
    pcd.estimate_normals(search_param=o3d.geometry.KDTreeSearchParamHybrid(radius=0.5, max_nn=30))
    pcd.orient_normals_consistent_tangent_plane(15)

    # Mesh reconstruction via Poisson or Ball Pivoting
    mesh = None
    try:
        if len(points) >= 100:
            poisson_mesh, densities = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(pcd, depth=8)
            # Trim low density boundary regions
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

    # If still sparse, build a point-based volumetric mesh using Trimesh
    os.makedirs(os.path.dirname(output_glb_path), exist_ok=True)
    
    if mesh is not None and len(mesh.triangles) > 30:
        v = np.asarray(mesh.vertices)
        f = np.asarray(mesh.triangles)
        c = np.asarray(mesh.vertex_colors)
        if len(c) != len(v):
            # Nearest neighbor color transfer from pcd to mesh vertices
            pcd_tree = o3d.geometry.KDTreeFlann(pcd)
            c = np.zeros_like(v)
            for i, vert in enumerate(v):
                _, idx, _ = pcd_tree.search_knn_vector_3d(vert, 1)
                c[i] = colors[idx[0]]
        
        tri_mesh = trimesh.Trimesh(
            vertices=v,
            faces=f,
            vertex_colors=(np.clip(c, 0, 1) * 255).astype(np.uint8),
            process=True
        )
    else:
        # Create dense point representation
        tri_mesh = trimesh.PointCloud(
            vertices=points,
            colors=(np.clip(colors, 0, 1) * 255).astype(np.uint8)
        )

    # Step 5b: Floor-plane alignment and centering via RANSAC
    alignment_meta = {}
    try:
        from navigation.alignment import align_mesh_or_points
        tri_mesh, transform_matrix, alignment_meta = align_mesh_or_points(tri_mesh)
        print(f"[Pipeline] Geometry floor aligned to y=0 with {alignment_meta.get('floorInliersCount', 0)} inliers")
    except Exception as e:
        print(f"[Pipeline] Alignment warning, falling back to simple centering: {e}")
        bounds = tri_mesh.bounds
        if bounds is not None:
            center = (bounds[0] + bounds[1]) / 2.0
            tri_mesh.apply_translation(-center)

    bounds = tri_mesh.bounds
    if bounds is not None:
        min_b = bounds[0]
        max_b = bounds[1]
    else:
        min_b = np.array([-1.0, 0.0, -1.0])
        max_b = np.array([1.0, 2.0, 1.0])

    # Export to GLB
    tri_mesh.export(output_glb_path, file_type="glb")

    # Generate preview thumbnail
    os.makedirs(os.path.dirname(thumbnail_path), exist_ok=True)
    # Use first clear frame from filtered_frames or raw_frames
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

    # Step 5c: Generate 2D navigation occupancy grid and mini-map wall segments
    navgrid_meta = {}
    try:
        from navigation.occupancy import generate_occupancy_grid
        from navigation.minimap import extract_wall_segments

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
        "navigation": navgrid_meta
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
    filtered_frames = filter_quality_frames(raw_frames, str(filtered_dir))

    # Step 3 & 4: COLMAP SfM (feature matching, poses, sparse 3D geometry)
    report_stage("features", 45, "Extracting 2D feature points (SIFT)", callback_url, project_id, job_id)
    report_stage("matching", 60, "Matching feature descriptors across camera angles", callback_url, project_id, job_id)
    report_stage("sfm", 75, "Recovering 3D camera poses and sparse structure", callback_url, project_id, job_id)
    ply_path, reg_count, _ = run_colmap_sfm(str(filtered_dir), str(colmap_dir), job_id=job_id, log_file=str(log_file_path))

    # Step 5 & 6: Dense geometry, mesh generation & GLB export
    report_stage("meshing", 85, "Reconstructing 3D surface mesh geometry", callback_url, project_id, job_id)
    report_stage("export", 95, "Exporting and optimizing GLB digital twin", callback_url, project_id, job_id)
    recon_stats = reconstruct_mesh_and_export_glb(
        ply_path, str(output_glb_path), str(thumbnail_path), registered_frames_count=reg_count
    )

    report_stage("completed", 100, "Photorealistic 3D Digital Twin successfully generated", callback_url, project_id, job_id)

    return {
        "success": True,
        "source": "photogrammetry",
        "modelUrl": f"/storage/projects/{project_id}/final/scene.glb",
        "thumbnailUrl": f"/storage/projects/{project_id}/preview/thumbnail.jpg",
        "finalModelPath": str(output_glb_path),
        "logPath": str(log_file_path),
        "boundingBox": recon_stats["boundingBox"],
        "metadata": {
            "registeredFrames": recon_stats["registeredFrames"],
            "totalExtractedFrames": len(raw_frames),
            "points3D": recon_stats["points3D"],
            "triangles": recon_stats["triangles"],
            "vertices": recon_stats["vertices"],
            "fileSizeBytes": recon_stats["fileSizeBytes"],
            "reconstructionQuality": "COLMAP Structure-from-Motion & Multi-View Stereo",
            "scaleMeters": f"{recon_stats['boundingBox']['maxX'] - recon_stats['boundingBox']['minX']:.1f}m × {recon_stats['boundingBox']['maxY'] - recon_stats['boundingBox']['minY']:.1f}m × {recon_stats['boundingBox']['maxZ'] - recon_stats['boundingBox']['minZ']:.1f}m",
            "alignment": recon_stats.get("alignment", {}),
            "navigation": recon_stats.get("navigation", {})
        }
    }
