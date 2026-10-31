import heapq
import math
from typing import List, Tuple, Optional, Dict, Any
import numpy as np

from .occupancy import OccupancyGrid

def heuristic(c1: int, r1: int, c2: int, r2: int, resolution: float) -> float:
    """Octile distance heuristic for 8-connected grid."""
    dx = abs(c1 - c2)
    dy = abs(r1 - r2)
    # Diagonal cost: sqrt(2), straight cost: 1
    return (dx + dy + (math.sqrt(2.0) - 2.0) * min(dx, dy)) * resolution

def has_line_of_sight(grid: OccupancyGrid, c0: int, r0: int, c1: int, r1: int) -> bool:
    """
    Supercover / Bresenham line-of-sight check.
    Returns True if direct straight line between (c0, r0) and (c1, r1) contains no obstacles.
    """
    dx = abs(c1 - c0)
    dy = abs(r1 - r0)
    x = c0
    y = r0
    n = 1 + dx + dy
    x_inc = 1 if c1 > c0 else -1
    y_inc = 1 if r1 > r0 else -1
    error = dx - dy
    dx *= 2
    dy *= 2

    for _ in range(n):
        if not grid.in_bounds(x, y) or grid.grid[y, x] != 0:
            return False

        if error > 0:
            x += x_inc
            error -= dy
        elif error < 0:
            y += y_inc
            error += dx
        else:
            # Passes exactly through corner - check both adjacent cells to prevent corner cutting
            if not grid.in_bounds(x + x_inc, y) or grid.grid[y, x + x_inc] != 0:
                return False
            if not grid.in_bounds(x, y + y_inc) or grid.grid[y + y_inc, x] != 0:
                return False
            x += x_inc
            y += y_inc
            error += dx - dy

        if x == c1 and y == r1:
            return bool(grid.in_bounds(x, y) and grid.grid[y, x] == 0)

    return True

def smooth_path(grid: OccupancyGrid, raw_path: List[Tuple[int, int]]) -> List[Tuple[int, int]]:
    """
    String-pulling line-of-sight path smoothing.
    Prunes redundant intermediate waypoints while ensuring clearance.
    """
    if len(raw_path) <= 2:
        return raw_path

    smoothed = [raw_path[0]]
    current_idx = 0

    while current_idx < len(raw_path) - 1:
        # Search backwards from the end to find furthest visible point
        furthest_idx = len(raw_path) - 1
        found_sight = False
        while furthest_idx > current_idx + 1:
            c0, r0 = raw_path[current_idx]
            c1, r1 = raw_path[furthest_idx]
            if has_line_of_sight(grid, c0, r0, c1, r1):
                found_sight = True
                break
            furthest_idx -= 1

        if found_sight:
            smoothed.append(raw_path[furthest_idx])
            current_idx = furthest_idx
        else:
            smoothed.append(raw_path[current_idx + 1])
            current_idx += 1

    return smoothed

def format_eta(seconds: float) -> str:
    sec = max(0, int(round(seconds)))
    if sec < 60:
        return f"{sec}s"
    m = sec // 60
    s = sec % 60
    return f"{m}m {s}s" if s > 0 else f"{m}m"

def find_path(
    grid: OccupancyGrid,
    start: Tuple[float, float, float],
    goal: Tuple[float, float, float],
    walking_speed_mps: float = 1.3,
    snap_radius_m: float = 2.0
) -> Dict[str, Any]:
    """
    Finds the optimal obstacle-avoiding 3D walking route on the occupancy grid.
    
    Args:
        grid: OccupancyGrid object.
        start: (x, y, z) start world coordinates.
        goal: (x, y, z) target world coordinates.
        walking_speed_mps: Average human walking speed (default 1.3 m/s).
        snap_radius_m: Max radius to search for nearby walkable cell if point is in an obstacle.
        
    Returns:
        Dictionary with route metadata, polyline points, length, and ETA.
    """
    sx, sy, sz = start
    gx, gy, gz = goal

    # Snap start/goal to nearest walkable cell if needed
    snapped_start = grid.snap_to_walkable(sx, sz, max_search_radius_m=snap_radius_m)
    snapped_goal = grid.snap_to_walkable(gx, gz, max_search_radius_m=snap_radius_m)

    if snapped_start is None or snapped_goal is None:
        return {
            "found": False,
            "error": "Start or goal position is completely enclosed or outside walkable bounds",
            "path": [],
            "distanceMeters": 0.0,
            "walkingEtaSeconds": 0.0,
            "walkingEtaFormatted": "0s",
        }

    start_x, start_z = snapped_start
    goal_x, goal_z = snapped_goal

    start_col, start_row = grid.world_to_grid(start_x, start_z)
    goal_col, goal_row = grid.world_to_grid(goal_x, goal_z)

    if start_col == goal_col and start_row == goal_row:
        # Same cell
        path_3d = [
            {"x": round(sx, 3), "y": round(sy, 3), "z": round(sz, 3)},
            {"x": round(gx, 3), "y": round(gy, 3), "z": round(gz, 3)}
        ]
        return {
            "found": True,
            "path": path_3d,
            "rawWaypointsCount": 2,
            "smoothedWaypointsCount": 2,
            "distanceMeters": round(math.sqrt((gx - sx)**2 + (gz - sz)**2), 2),
            "walkingSpeedMps": walking_speed_mps,
            "walkingEtaSeconds": 1.0,
            "walkingEtaFormatted": "1s",
        }

    # 8-connected neighbor offsets: (d_col, d_row, cost_factor)
    sqrt2 = math.sqrt(2.0)
    neighbors = [
        (-1, 0, 1.0), (1, 0, 1.0), (0, -1, 1.0), (0, 1, 1.0),
        (-1, -1, sqrt2), (-1, 1, sqrt2), (1, -1, sqrt2), (1, 1, sqrt2)
    ]

    open_set = []
    # (f_score, h_score, col, row)
    h0 = heuristic(start_col, start_row, goal_col, goal_row, grid.resolution)
    heapq.heappush(open_set, (h0, h0, start_col, start_row))

    came_from: Dict[Tuple[int, int], Tuple[int, int]] = {}
    g_score: Dict[Tuple[int, int], float] = {(start_col, start_row): 0.0}
    closed_set = set()

    path_found = False

    while open_set:
        f, h, col, row = heapq.heappop(open_set)

        if (col, row) in closed_set:
            continue
        closed_set.add((col, row))

        if col == goal_col and row == goal_row:
            path_found = True
            break

        current_g = g_score[(col, row)]

        for dc, dr, move_cost in neighbors:
            nc = col + dc
            nr = row + dr

            if not grid.in_bounds(nc, nr) or grid.grid[nr, nc] != 0:
                continue

            # Prevent diagonal corner-cutting
            if dc != 0 and dr != 0:
                if grid.grid[row, nc] != 0 or grid.grid[nr, col] != 0:
                    continue

            tentative_g = current_g + move_cost * grid.resolution

            if (nc, nr) not in g_score or tentative_g < g_score[(nc, nr)]:
                came_from[(nc, nr)] = (col, row)
                g_score[(nc, nr)] = tentative_g
                h_cost = heuristic(nc, nr, goal_col, goal_row, grid.resolution)
                heapq.heappush(open_set, (tentative_g + h_cost, h_cost, nc, nr))

    if not path_found:
        return {
            "found": False,
            "error": "No reachable path found between points",
            "path": [],
            "distanceMeters": 0.0,
            "walkingEtaSeconds": 0.0,
            "walkingEtaFormatted": "0s",
        }

    # Reconstruct raw grid path
    curr = (goal_col, goal_row)
    raw_grid_path = [curr]
    while curr in came_from:
        curr = came_from[curr]
        raw_grid_path.append(curr)
    raw_grid_path.reverse()

    # Apply string pulling smoothing
    smoothed_grid_path = smooth_path(grid, raw_grid_path)

    # Convert to 3D points
    path_3d: List[Dict[str, float]] = []
    # Include original start world coordinate
    path_3d.append({"x": round(sx, 3), "y": round(sy, 3), "z": round(sz, 3)})

    for col, row in smoothed_grid_path:
        wx, wz = grid.grid_to_world(col, row)
        path_3d.append({"x": round(wx, 3), "y": round(sy, 3), "z": round(wz, 3)})

    # Include original goal world coordinate
    path_3d.append({"x": round(gx, 3), "y": round(gy, 3), "z": round(gz, 3)})

    # Remove consecutive duplicate points if very close
    cleaned_path: List[Dict[str, float]] = [path_3d[0]]
    for pt in path_3d[1:]:
        last = cleaned_path[-1]
        dist = math.sqrt((pt["x"] - last["x"])**2 + (pt["z"] - last["z"])**2)
        if dist > 0.01:
            cleaned_path.append(pt)

    # Compute total path distance
    total_distance = 0.0
    for i in range(len(cleaned_path) - 1):
        p1 = cleaned_path[i]
        p2 = cleaned_path[i + 1]
        total_distance += math.sqrt(
            (p2["x"] - p1["x"])**2 + (p2["y"] - p1["y"])**2 + (p2["z"] - p1["z"])**2
        )

    eta_seconds = total_distance / max(0.1, walking_speed_mps)

    return {
        "found": True,
        "path": cleaned_path,
        "rawWaypointsCount": len(raw_grid_path),
        "smoothedWaypointsCount": len(cleaned_path),
        "distanceMeters": round(total_distance, 2),
        "walkingSpeedMps": walking_speed_mps,
        "walkingEtaSeconds": round(eta_seconds, 1),
        "walkingEtaFormatted": format_eta(eta_seconds),
    }
