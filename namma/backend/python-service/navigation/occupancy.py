import numpy as np
from typing import Dict, Any, Tuple, Optional, Union, List
import math

class OccupancyGrid:
    def __init__(
        self,
        grid: np.ndarray,
        min_x: float,
        min_z: float,
        resolution: float = 0.05,
        raw_obstacles: Optional[np.ndarray] = None
    ):
        """
        grid: 2D numpy array (height, width) where:
              0 = walkable (free space)
              1 = obstacle / non-walkable (inflated boundary)
        """
        self.grid = grid.astype(np.uint8)
        self.height, self.width = grid.shape
        self.min_x = float(min_x)
        self.min_z = float(min_z)
        self.resolution = float(resolution)
        self.raw_obstacles = raw_obstacles if raw_obstacles is not None else self.grid

    @property
    def max_x(self) -> float:
        return self.min_x + self.width * self.resolution

    @property
    def max_z(self) -> float:
        return self.min_z + self.height * self.resolution

    def world_to_grid(self, x: float, z: float) -> Tuple[int, int]:
        """Converts world (x, z) coordinates into (col, row) grid indices."""
        col = int(math.floor((x - self.min_x) / self.resolution))
        row = int(math.floor((z - self.min_z) / self.resolution))
        return col, row

    def grid_to_world(self, col: int, row: int) -> Tuple[float, float]:
        """Converts (col, row) grid indices into world (x, z) center coordinate."""
        x = self.min_x + (col + 0.5) * self.resolution
        z = self.min_z + (row + 0.5) * self.resolution
        return x, z

    def in_bounds(self, col: int, row: int) -> bool:
        return 0 <= col < self.width and 0 <= row < self.height

    def is_walkable(self, x: float, z: float) -> bool:
        col, row = self.world_to_grid(x, z)
        if not self.in_bounds(col, row):
            return False
        return bool(self.grid[row, col] == 0)

    def snap_to_walkable(self, x: float, z: float, max_search_radius_m: float = 2.0) -> Optional[Tuple[float, float]]:
        """Finds nearest walkable cell within search radius, or None if completely enclosed."""
        if self.is_walkable(x, z):
            return x, z

        start_col, start_row = self.world_to_grid(x, z)
        max_cells = int(math.ceil(max_search_radius_m / self.resolution))

        best_dist_sq = float('inf')
        best_point = None

        # Radial search
        for r in range(1, max_cells + 1):
            for dr in range(-r, r + 1):
                for dc in (-r, r):
                    row, col = start_row + dr, start_col + dc
                    if self.in_bounds(col, row) and self.grid[row, col] == 0:
                        wx, wz = self.grid_to_world(col, row)
                        d_sq = (wx - x) ** 2 + (wz - z) ** 2
                        if d_sq < best_dist_sq:
                            best_dist_sq = d_sq
                            best_point = (wx, wz)
                for dc in range(-r + 1, r):
                    for dr in (-r, r):
                        row, col = start_row + dr, start_col + dc
                        if self.in_bounds(col, row) and self.grid[row, col] == 0:
                            wx, wz = self.grid_to_world(col, row)
                            d_sq = (wx - x) ** 2 + (wz - z) ** 2
                            if d_sq < best_dist_sq:
                                best_dist_sq = d_sq
                                best_point = (wx, wz)
            if best_point is not None:
                return best_point

        return None

    def to_dict(self, include_raw_grid: bool = True) -> Dict[str, Any]:
        """Exports JSON-serializable dictionary representation."""
        data = {
            "resolution": self.resolution,
            "origin": [self.min_x, self.min_z],
            "width": self.width,
            "height": self.height,
            "bounds": {
                "minX": self.min_x,
                "maxX": self.max_x,
                "minZ": self.min_z,
                "maxZ": self.max_z,
            }
        }
        if include_raw_grid:
            # Flatten or nested list
            data["grid"] = self.grid.tolist()
        return data


def generate_occupancy_grid(
    geometry_or_points: Any,
    resolution: float = 0.05,
    slice_min_y: float = 0.2,
    slice_max_y: float = 1.6,
    agent_radius: float = 0.25,
    padding: float = 0.3
) -> OccupancyGrid:
    """
    Slices 3D geometry between slice_min_y and slice_max_y, projects to 2D (x, z),
    rasterizes into a grid with given resolution, and inflates obstacles by agent_radius.
    """
    import trimesh

    if isinstance(geometry_or_points, np.ndarray):
        points = geometry_or_points
    elif isinstance(geometry_or_points, trimesh.Trimesh):
        points = np.asarray(geometry_or_points.vertices)
    elif isinstance(geometry_or_points, trimesh.PointCloud):
        points = np.asarray(geometry_or_points.vertices)
    else:
        # Check Open3D
        try:
            import open3d as o3d
            if isinstance(geometry_or_points, (o3d.geometry.TriangleMesh, o3d.geometry.PointCloud)):
                points = np.asarray(geometry_or_points.vertices if hasattr(geometry_or_points, 'vertices') else geometry_or_points.points)
            else:
                points = np.asarray(geometry_or_points)
        except Exception:
            points = np.asarray(geometry_or_points)

    if len(points) == 0:
        # Default empty 10x10m grid
        grid = np.zeros((200, 200), dtype=np.uint8)
        return OccupancyGrid(grid, -5.0, -5.0, resolution=resolution)

    # 1. Filter slice between 0.2m and 1.6m above floor
    mask = (points[:, 1] >= slice_min_y) & (points[:, 1] <= slice_max_y)
    obstacle_points = points[mask]

    # Overall bounds from all points (including floor/ceiling)
    min_x = float(np.min(points[:, 0])) - padding
    max_x = float(np.max(points[:, 0])) + padding
    min_z = float(np.min(points[:, 2])) - padding
    max_z = float(np.max(points[:, 2])) + padding

    width = max(1, int(math.ceil((max_x - min_x) / resolution)))
    height = max(1, int(math.ceil((max_z - min_z) / resolution)))

    raw_grid = np.zeros((height, width), dtype=np.uint8)

    # 2. Rasterize obstacle points
    if len(obstacle_points) > 0:
        cols = np.floor((obstacle_points[:, 0] - min_x) / resolution).astype(int)
        rows = np.floor((obstacle_points[:, 2] - min_z) / resolution).astype(int)

        valid = (cols >= 0) & (cols < width) & (rows >= 0) & (rows < height)
        cols = cols[valid]
        rows = rows[valid]
        raw_grid[rows, cols] = 1

    # 3. Inflate obstacles by agent radius
    radius_cells = int(math.ceil(agent_radius / resolution))
    if radius_cells > 0:
        # Create circular dilation footprint
        y_coords, x_coords = np.ogrid[-radius_cells:radius_cells + 1, -radius_cells:radius_cells + 1]
        footprint = (x_coords ** 2 + y_coords ** 2) <= (radius_cells ** 2)

        try:
            from scipy.ndimage import binary_dilation
            inflated_grid = binary_dilation(raw_grid > 0, structure=footprint).astype(np.uint8)
        except Exception:
            # Vectorized fallback
            inflated_grid = np.copy(raw_grid)
            non_zero_rows, non_zero_cols = np.where(raw_grid > 0)
            for r, c in zip(non_zero_rows, non_zero_cols):
                r_min = max(0, r - radius_cells)
                r_max = min(height, r + radius_cells + 1)
                c_min = max(0, c - radius_cells)
                c_max = min(width, c + radius_cells + 1)
                sub_footprint = footprint[
                    (r_min - (r - radius_cells)):(r_max - (r - radius_cells)),
                    (c_min - (c - radius_cells)):(c_max - (c - radius_cells))
                ]
                inflated_grid[r_min:r_max, c_min:c_max] |= sub_footprint.astype(np.uint8)
    else:
        inflated_grid = raw_grid

    return OccupancyGrid(
        grid=inflated_grid,
        min_x=min_x,
        min_z=min_z,
        resolution=resolution,
        raw_obstacles=raw_grid
    )



def generate_occupancy_grid_from_floor_plan(
    floor_polygon,
    points: Optional[np.ndarray] = None,
    y_floor: float = 0.0,
    resolution: float = 0.05,
    agent_radius: float = 0.30,
    slice_min_y: float = 0.10,
    slice_max_y: float = 1.80,
    padding: float = 0.2
) -> Tuple[OccupancyGrid, Any]:
    """
    Constructs an OccupancyGrid directly from a Shapely 2D floor polygon:
    - Walkable free space is strictly bounded within the room polygon eroded by agent_radius.
    - Obstacle points between y_floor + slice_min_y and y_floor + slice_max_y are buffered by agent_radius and subtracted.
    - Everything outside the room is non-walkable.
    Returns: (OccupancyGrid, walkable_shapely_geom)
    """
    from shapely.geometry import Polygon, Point, MultiPoint
    from shapely.ops import unary_union

    if floor_polygon is None or not floor_polygon.is_valid:
        # Fallback to standard point cloud slicing
        grid = generate_occupancy_grid(points if points is not None else np.zeros((0, 3)), resolution=resolution, agent_radius=agent_radius)
        return grid, None

    # Inner eroded boundary so the agent body doesn't clip walls
    eroded_room = floor_polygon.buffer(-agent_radius)
    if eroded_room.is_empty:
        # If room is very narrow, use a smaller buffer
        eroded_room = floor_polygon.buffer(-0.1)
    if eroded_room.is_empty:
        eroded_room = floor_polygon

    # Bounding box of the room
    bounds = floor_polygon.bounds  # (minx, miny, maxx, maxy) -> (min_x, min_z, max_x, max_z)
    min_x = float(bounds[0]) - padding
    min_z = float(bounds[1]) - padding
    max_x = float(bounds[2]) + padding
    max_z = float(bounds[3]) + padding

    width = max(1, int(math.ceil((max_x - min_x) / resolution)))
    height = max(1, int(math.ceil((max_z - min_z) / resolution)))

    # Process obstacles within the room
    obstacle_geom = None
    if points is not None and len(points) > 0:
        obs_mask = (points[:, 1] >= (y_floor + slice_min_y)) & (points[:, 1] <= (y_floor + slice_max_y))
        obs_pts = points[obs_mask]
        if len(obs_pts) > 0:
            obs_2d = [Point(p[0], p[2]) for p in obs_pts if floor_polygon.contains(Point(p[0], p[2]))]
            if obs_2d:
                # Buffer obstacle points by agent radius
                obstacle_geom = MultiPoint(obs_2d).buffer(agent_radius)

    walkable_geom = eroded_room
    if obstacle_geom is not None and not obstacle_geom.is_empty:
        walkable_geom = eroded_room.difference(obstacle_geom)

    # Rasterize: default all to 1 (obstacle/wall)
    grid = np.ones((height, width), dtype=np.uint8)

    # Fill walkable cells
    for row in range(height):
        z = min_z + (row + 0.5) * resolution
        for col in range(width):
            x = min_x + (col + 0.5) * resolution
            if walkable_geom.contains(Point(x, z)):
                grid[row, col] = 0  # Walkable

    occ_grid = OccupancyGrid(
        grid=grid,
        min_x=min_x,
        min_z=min_z,
        resolution=resolution,
        raw_obstacles=(grid > 0).astype(np.uint8)
    )
    return occ_grid, walkable_geom

def snap_poi_to_walkable(
    poi_x: float,
    poi_z: float,
    floor_polygon,
    walkable_geom=None,
    grid: Optional[OccupancyGrid] = None
) -> Dict[str, Any]:
    """
    Validates and snaps a POI coordinate using Shapely:
    - If outside the room polygon, snaps to the nearest valid interior point.
    - If inside an obstacle, snaps out to free walkable space.
    """
    from shapely.geometry import Point
    from shapely.ops import nearest_points

    pt = Point(poi_x, poi_z)
    target_boundary = walkable_geom if walkable_geom is not None and not walkable_geom.is_empty else floor_polygon

    if target_boundary is None or target_boundary.is_empty:
        if grid:
            snapped = grid.snap_to_walkable(poi_x, poi_z)
            if snapped:
                return {
                    "x": float(snapped[0]),
                    "z": float(snapped[1]),
                    "snapped": (snapped[0] != poi_x or snapped[1] != poi_z),
                    "message": "POI snapped to nearest walkable grid cell"
                }
        return {"x": poi_x, "z": poi_z, "snapped": False, "message": "Valid"}

    if target_boundary.contains(pt):
        return {"x": poi_x, "z": poi_z, "snapped": False, "message": "POI is within walkable floor area"}

    nearest_pt = nearest_points(target_boundary, pt)[0]
    return {
        "x": float(nearest_pt.x),
        "z": float(nearest_pt.y),
        "snapped": True,
        "message": "POI was outside room or inside obstacle and was snapped to nearest walkable location"
    }
