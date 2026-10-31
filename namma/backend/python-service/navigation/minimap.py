import numpy as np
import cv2
import math
from typing import List, Dict, Any, Tuple, Optional
from .occupancy import OccupancyGrid

def ramer_douglas_peucker_2d(points: np.ndarray, epsilon: float) -> np.ndarray:
    """
    Ramer-Douglas-Peucker polyline simplification algorithm.
    points: (N, 2) array of coordinates [[x, z], ...]
    epsilon: distance tolerance in meters.
    """
    if len(points) < 3:
        return points

    start = points[0]
    end = points[-1]
    line_vec = end - start
    line_len = np.linalg.norm(line_vec)

    if line_len < 1e-6:
        # Start and end are identical
        dists = np.linalg.norm(points - start, axis=1)
    else:
        # Distance from each point to line segment
        line_unit = line_vec / line_len
        to_pts = points - start
        proj = np.dot(to_pts, line_unit)
        proj_clamped = np.clip(proj, 0, line_len)
        closest_pts = start + np.outer(proj_clamped, line_unit)
        dists = np.linalg.norm(points - closest_pts, axis=1)

    max_idx = int(np.argmax(dists))
    max_dist = dists[max_idx]

    if max_dist > epsilon:
        # Recursive simplification
        rec1 = ramer_douglas_peucker_2d(points[:max_idx + 1], epsilon)
        rec2 = ramer_douglas_peucker_2d(points[max_idx:], epsilon)
        return np.vstack([rec1[:-1], rec2])
    else:
        return np.vstack([start, end])


def extract_wall_segments(
    grid: OccupancyGrid,
    rdp_epsilon_m: float = 0.1,
    min_segment_length_m: float = 0.15,
    use_raw_obstacles: bool = True
) -> Dict[str, Any]:
    """
    Extracts simplified 2D wall line segments from the occupancy grid for mini-map rendering.
    
    Args:
        grid: OccupancyGrid object.
        rdp_epsilon_m: RDP tolerance in meters.
        min_segment_length_m: Minimum line length to retain (filters out tiny noise).
        use_raw_obstacles: If True, uses uninflated obstacles for accurate wall positions.
        
    Returns:
        Dictionary containing wall segments, bounds, and mini-map metadata.
    """
    obstacle_map = grid.raw_obstacles if (use_raw_obstacles and grid.raw_obstacles is not None) else grid.grid
    binary_img = (obstacle_map * 255).astype(np.uint8)

    # Bridge small gaps between discrete points along walls
    kernel = np.ones((3, 3), np.uint8)
    morphed = cv2.morphologyEx(binary_img, cv2.MORPH_CLOSE, kernel)
    morphed = cv2.dilate(morphed, kernel, iterations=1)

    # Find external and internal contours
    contours, _ = cv2.findContours(morphed, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)

    epsilon_pixels = max(1.0, rdp_epsilon_m / grid.resolution)
    wall_segments: List[Dict[str, Any]] = []

    for cnt in contours:
        if len(cnt) < 3:
            continue

        # Simplify contour using approxPolyDP
        approx = cv2.approxPolyDP(cnt, epsilon_pixels, closed=True)
        if len(approx) < 2:
            continue

        pts_grid = approx.reshape(-1, 2)
        # Convert grid points to world (x, z) coordinates
        pts_world = []
        for col, row in pts_grid:
            wx, wz = grid.grid_to_world(int(col), int(row))
            pts_world.append([round(wx, 3), round(wz, 3)])

        pts_world = np.array(pts_world)

        # Loop through edges of the polygon
        num_pts = len(pts_world)
        for i in range(num_pts):
            p1 = pts_world[i]
            p2 = pts_world[(i + 1) % num_pts]

            length = math.sqrt((p2[0] - p1[0])**2 + (p2[1] - p1[1])**2)
            if length >= min_segment_length_m:
                wall_segments.append({
                    "start": [float(p1[0]), float(p1[1])],
                    "end": [float(p2[0]), float(p2[1])],
                    "length": round(float(length), 3)
                })

    return {
        "bounds": {
            "minX": round(grid.min_x, 3),
            "maxX": round(grid.max_x, 3),
            "minZ": round(grid.min_z, 3),
            "maxZ": round(grid.max_z, 3),
            "width": round(grid.max_x - grid.min_x, 3),
            "height": round(grid.max_z - grid.min_z, 3),
        },
        "resolution": grid.resolution,
        "totalSegments": len(wall_segments),
        "wallSegments": wall_segments
    }
