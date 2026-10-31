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

