"""
NAMMA SPACE — Capture Coach (python-service/coach.py)
Cheaply inspects uploaded video at ~2 fps, <= 640 px without running COLMAP.
Measures: brightness swings, blur ratio (Laplacian variance), keypoints (ORB texture),
consecutive frame overlap/matches, duration, and detects problematic time ranges.
Returns plain-language actionable advice and overall quality score.
"""

import os
import cv2
import numpy as np
from pathlib import Path


def analyze_video_capture(video_path, max_dimension=640, sample_fps=2.0):
    v_path = Path(video_path).resolve()
    if not v_path.exists():
        return {
            "success": False,
            "error": f"Video file not found at {v_path}",
            "hopeless": True,
        }

    cap = cv2.VideoCapture(str(v_path))
    if not cap.isOpened():
        return {
            "success": False,
            "error": "Failed to open video file for inspection",
            "hopeless": True,
        }

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
    duration_sec = total_frames / fps if total_frames > 0 and fps > 0 else 0.0

    step = max(1, int(round(fps / sample_fps)))

    orb = cv2.ORB_create(nfeatures=500)
    bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)

    frame_idx = 0
    sampled_records = []
    prev_des = None
    prev_gray = None

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        if frame_idx % step == 0:
            timestamp = frame_idx / fps

            h, w = frame.shape[:2]
            scale = max_dimension / max(h, w) if max(h, w) > max_dimension else 1.0
            if scale < 1.0:
                frame_small = cv2.resize(frame, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
            else:
                frame_small = frame

            gray = cv2.cvtColor(frame_small, cv2.COLOR_BGR2GRAY)

            # 1. Brightness
            brightness = float(np.mean(gray))

            # 2. Blur via Laplacian variance
            lap_var = float(cv2.Laplacian(gray, cv2.CV_64F).var())

            # 3. Keypoints & Descriptors
            kp, des = orb.detectAndCompute(gray, None)
            num_kp = len(kp) if kp else 0

            # 4. Match count with previous sampled frame
            matches_count = 0
            motion_score = 0.0
            if prev_des is not None and des is not None and len(prev_des) > 10 and len(des) > 10:
                try:
                    matches = bf.match(prev_des, des)
                    matches_count = len(matches)
                except Exception:
                    matches_count = 0

            if prev_gray is not None and prev_gray.shape == gray.shape:
                diff = cv2.absdiff(prev_gray, gray)
                motion_score = float(np.mean(diff)) / 255.0

            sampled_records.append({
                "time": timestamp,
                "brightness": brightness,
                "blur": lap_var,
                "keypoints": num_kp,
                "matches": matches_count,
                "motion": motion_score,
            })

            prev_des = des
            prev_gray = gray

        frame_idx += 1

    cap.release()

    if not sampled_records:
        return {
            "success": False,
            "error": "No frames could be extracted from video",
            "hopeless": True,
        }

    # Aggregate Metrics
    n = len(sampled_records)
    avg_brightness = float(np.mean([r["brightness"] for r in sampled_records]))
    median_blur = float(np.median([r["blur"] for r in sampled_records]))
    blurry_count = sum(1 for r in sampled_records if r["blur"] < 80.0)
    blurry_ratio = blurry_count / n

    keypoint_counts = [r["keypoints"] for r in sampled_records]
    median_kp = float(np.median(keypoint_counts))

    # Match overlap evaluation (excluding first frame which has 0 matches)
    match_records = sampled_records[1:] if len(sampled_records) > 1 else []
    low_overlap_count = sum(1 for r in match_records if r["matches"] < 25)
    low_overlap_fraction = (low_overlap_count / len(match_records)) if match_records else 0.0

    avg_motion = float(np.mean([r["motion"] for r in sampled_records]))

    # Hopeless Detection (near pitch black or completely static camera)
    if avg_brightness < 18.0:
        return {
            "success": True,
            "score": 10,
            "verdict": "REJECTED",
            "hopeless": True,
            "metrics": {
                "durationSeconds": round(duration_sec, 1),
                "sampledFrames": n,
                "avgBrightness": round(avg_brightness, 1),
                "blurryFrameRatio": round(blurry_ratio, 2),
                "medianKeypoints": int(median_kp),
                "lowOverlapFraction": round(low_overlap_fraction, 2),
            },
            "tips": ["Video is extremely dark or near black. Please turn on room lights and record again."],
            "problemRanges": [{"start": 0.0, "end": round(duration_sec, 1), "issue": "DARK", "tip": "Room is too dark for feature extraction."}],
        }

    if avg_motion < 0.015:
        return {
            "success": True,
            "score": 15,
            "verdict": "REJECTED",
            "hopeless": True,
            "metrics": {
                "durationSeconds": round(duration_sec, 1),
                "sampledFrames": n,
                "avgBrightness": round(avg_brightness, 1),
                "blurryFrameRatio": round(blurry_ratio, 2),
                "medianKeypoints": int(median_kp),
                "lowOverlapFraction": round(low_overlap_fraction, 2),
            },
            "tips": ["Camera did not move. 3D reconstruction requires walking or orbiting around the scene to create parallax."],
            "problemRanges": [{"start": 0.0, "end": round(duration_sec, 1), "issue": "NO_MOTION", "tip": "Camera held static without movement."}],
        }

    # Problem Interval Clustering
    problem_ranges = []
    tips = []

    # 1. Blank walls / low texture
    blank_times = [r["time"] for r in sampled_records if r["keypoints"] < 60]
    blank_intervals = _cluster_timestamps(blank_times, gap=2.0)
    for start, end in blank_intervals:
        if end - start >= 2.0:
            problem_ranges.append({
                "start": round(start, 1),
                "end": round(end, 1),
                "issue": "BLANK_WALLS",
                "tip": f"Walls look blank around {start:.0f}–{end:.0f}s: add posters, photos, or tape paper on them.",
            })
            tips.append(f"Walls look blank around {start:.0f}–{end:.0f}s: add posters or tape paper on them")

    # 2. Fast turn / abrupt angle drop
    fast_turn_times = [r["time"] for r in match_records if r["matches"] < 20]
    fast_turn_intervals = _cluster_timestamps(fast_turn_times, gap=2.0)
    for start, end in fast_turn_intervals:
        if end - start >= 1.5:
            problem_ranges.append({
                "start": round(start, 1),
                "end": round(end, 1),
                "issue": "FAST_TURN",
                "tip": f"Fast turn at {start:.0f}–{end:.0f}s: move slower and maintain overlapping view.",
            })
            tips.append(f"Fast turn at {start:.0f}–{end:.0f}s: move slower")

    # 3. Motion blur segments
    blur_times = [r["time"] for r in sampled_records if r["blur"] < 60]
    blur_intervals = _cluster_timestamps(blur_times, gap=2.0)
    for start, end in blur_intervals:
        if end - start >= 2.0:
            problem_ranges.append({
                "start": round(start, 1),
                "end": round(end, 1),
                "issue": "BLUR",
                "tip": f"Camera shake/motion blur detected at {start:.0f}–{end:.0f}s: hold steady.",
            })
            tips.append(f"Blurry footage at {start:.0f}–{end:.0f}s: hold device steadier")

    # 4. Rotation vs Translation Check
    if avg_motion < 0.08 and low_overlap_fraction > 0.35:
        tips.append("Mostly rotating in place: walk sideways in a wide circle around the room rather than pivoting.")

    # 5. Short duration
    if duration_sec < 20.0:
        tips.append(f"Recording is short ({duration_sec:.0f}s). 45–90s recommended for full room photogrammetry.")

    # Quality Score (0 to 100)
    score = 100.0
    # Penalty for blur
    score -= min(30.0, blurry_ratio * 50.0)
    # Penalty for low texture
    if median_kp < 200:
        score -= min(25.0, (200 - median_kp) / 5.0)
    # Penalty for low overlap
    score -= min(25.0, low_overlap_fraction * 40.0)
    # Penalty for extreme lighting swings
    if avg_brightness < 50:
        score -= min(15.0, (50 - avg_brightness) / 2.0)
    elif avg_brightness > 210:
        score -= min(15.0, (avg_brightness - 210) / 2.0)

    score = int(max(20, min(98, round(score))))

    verdict = "EXCELLENT" if score >= 80 else ("GOOD" if score >= 65 else ("FAIR" if score >= 45 else "POOR"))

    if not tips:
        tips.append("Capture quality is good! Overlap and texture look sufficient for 3D reconstruction.")

    return {
        "success": True,
        "score": score,
        "verdict": verdict,
        "hopeless": False,
        "metrics": {
            "durationSeconds": round(duration_sec, 1),
            "sampledFrames": n,
            "avgBrightness": round(avg_brightness, 1),
            "blurryFrameRatio": round(blurry_ratio, 2),
            "medianKeypoints": int(median_kp),
            "lowOverlapFraction": round(low_overlap_fraction, 2),
        },
        "problemRanges": problem_ranges[:6],
        "tips": tips[:5],
    }


def _cluster_timestamps(timestamps, gap=2.0):
    """Clusters sequence of timestamps into [start, end] ranges with max inter-element gap."""
    if not timestamps:
        return []
    sorted_ts = sorted(timestamps)
    intervals = []
    cur_start = sorted_ts[0]
    cur_end = sorted_ts[0]

    for t in sorted_ts[1:]:
        if t - cur_end <= gap:
            cur_end = t
        else:
            intervals.append((cur_start, cur_end))
            cur_start = t
            cur_end = t
    intervals.append((cur_start, cur_end))
    return intervals
