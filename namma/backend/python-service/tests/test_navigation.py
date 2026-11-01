"""
Automated unit tests for Navigation Engine:
- RANSAC Floor Plane Alignment
- 2D Occupancy Grid Rasterization & Inflation
- 8-Connected A* Pathfinding with Line-of-Sight Smoothing
- Phase F: Walkable area from 2D floor polygon minus inflated obstacles
- Phase F: POI snapping with Shapely
- Phase F: A* path verification ensuring path never leaves floor polygon
"""

import os
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("OMP_NUM_THREADS", "1")

import unittest
import numpy as np
import math
from pathlib import Path
import sys

# Ensure python-service root is in sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from shapely.geometry import Polygon, Point
from navigation.alignment import fit_floor_plane_ransac, compute_alignment_matrix
from navigation.occupancy import (
    generate_occupancy_grid,
    OccupancyGrid,
    generate_occupancy_grid_from_floor_plan,
    snap_poi_to_walkable
)
from navigation.pathfinding import find_path, has_line_of_sight, smooth_path
from navigation.minimap import extract_wall_segments, ramer_douglas_peucker_2d

class TestNavigationEngine(unittest.TestCase):

    def test_floor_plane_alignment(self):
        """Test RANSAC floor alignment rotates normal to +Y and translates floor to y=0."""
        rng = np.random.RandomState(42)
        x = rng.uniform(-4, 4, 1500)
        z = rng.uniform(-4, 4, 1500)
        y = 0.3 * x - 0.1 * z + 2.0 + rng.normal(0, 0.005, 1500)
        ceil_y = y + 2.5
        pts = np.vstack([np.column_stack([x, y, z]), np.column_stack([x, ceil_y, z])])

        transform, meta = compute_alignment_matrix(pts)

        self.assertEqual(transform.shape, (4, 4))
        self.assertAlmostEqual(meta["boundsAligned"]["minY"], 0.0, places=1)
        self.assertAlmostEqual(meta["boundsAligned"]["maxY"], 2.4, places=1)

    def test_occupancy_grid_rasterization_and_inflation(self):
        """Test obstacle rasterization between 0.2m and 1.6m and inflation by agent radius."""
        wall_pts = np.column_stack([
            np.full(100, 2.0),
            np.linspace(0.5, 1.5, 100),
            np.linspace(-2, 2, 100)
        ])
        floor_pts = np.column_stack([
            np.random.uniform(-4, 4, 200),
            np.full(200, 0.05),
            np.random.uniform(-4, 4, 200)
        ])
        pts = np.vstack([wall_pts, floor_pts])

        grid = generate_occupancy_grid(pts, resolution=0.05, agent_radius=0.25)

        self.assertIsInstance(grid, OccupancyGrid)
        self.assertTrue(grid.is_walkable(0.0, 0.0))
        self.assertFalse(grid.is_walkable(2.0, 0.0))
        self.assertFalse(grid.is_walkable(1.85, 0.0))
        self.assertTrue(grid.is_walkable(1.0, 0.0))

    def test_pathfinding_obstacle_routing(self):
        """Test A* navigates around a central wall obstacle and smooths path."""
        wall_pts = np.column_stack([
            np.zeros(100),
            np.full(100, 1.0),
            np.linspace(-2, 2, 100)
        ])
        room_bounds = np.array([[-5, 0, -5], [5, 0, 5]])
        pts = np.vstack([wall_pts, room_bounds])

        grid = generate_occupancy_grid(pts, resolution=0.1, agent_radius=0.2)

        start = (-2.5, 0.0, 0.0)
        goal = (2.5, 0.0, 0.0)

        res = find_path(grid, start, goal, walking_speed_mps=1.3)

        self.assertTrue(res["found"])
        self.assertGreater(res["distanceMeters"], 5.0)
        self.assertGreater(res["walkingEtaSeconds"], 0.0)
        self.assertLess(res["smoothedWaypointsCount"], res["rawWaypointsCount"])

    def test_phase_f_floor_polygon_walkable_area(self):
        """Phase F: Test walkable area strictly bounded inside room polygon minus obstacle."""
        # 6m x 4m room: [-3, 3] x [-2, 2]
        room_poly = Polygon([(-3, -2), (3, -2), (3, 2), (-3, 2)])
        
        # Central obstacle pillar at (0, 0)
        pillar_pts = np.array([
            [0.0, 0.5, 0.0],
            [0.1, 0.8, 0.1],
            [-0.1, 1.0, -0.1]
        ])

        grid, walkable_geom = generate_occupancy_grid_from_floor_plan(
            floor_polygon=room_poly,
            points=pillar_pts,
            y_floor=0.0,
            resolution=0.1,
            agent_radius=0.3
        )

        # 1. Point outside the room (e.g. x=4, z=0) must be non-walkable
        self.assertFalse(grid.is_walkable(4.0, 0.0), "Points outside room must not be walkable")

        # 2. Point inside room clear of pillar (e.g. x=-2, z=0) must be walkable
        self.assertTrue(grid.is_walkable(-2.0, 0.0), "Interior clear floor point must be walkable")

        # 3. Point at the pillar (x=0, z=0) must be non-walkable
        self.assertFalse(grid.is_walkable(0.0, 0.0), "Pillar center must not be walkable")

        # 4. Point near room wall (x=2.9, z=0) within agent_radius buffer must be non-walkable
        self.assertFalse(grid.is_walkable(2.9, 0.0), "Buffer near room wall must not be walkable")

    def test_phase_f_poi_snapping(self):
        """Phase F: Test POI snapping with Shapely nearest_points."""
        room_poly = Polygon([(-2, -2), (2, -2), (2, 2), (-2, 2)])

        # A) POI inside room -> not snapped
        res_inside = snap_poi_to_walkable(0.5, 0.5, room_poly)
        self.assertFalse(res_inside["snapped"])
        self.assertEqual(res_inside["x"], 0.5)
        self.assertEqual(res_inside["z"], 0.5)

        # B) POI clicked far outside room (e.g. at 5.0, 0.0) -> snapped to room boundary
        res_outside = snap_poi_to_walkable(5.0, 0.0, room_poly)
        self.assertTrue(res_outside["snapped"])
        self.assertAlmostEqual(res_outside["x"], 2.0, delta=0.05)
        self.assertAlmostEqual(res_outside["z"], 0.0, delta=0.05)

    def test_phase_f_astar_never_leaves_floor_polygon(self):
        """Phase F: Verify A* path never crosses obstacles or leaves the floor polygon."""
        # L-shaped room: [0, 4] x [0, 2] union [0, 2] x [2, 4]
        poly = Polygon([(0, 0), (4, 0), (4, 2), (2, 2), (2, 4), (0, 4)])
        grid, walkable_geom = generate_occupancy_grid_from_floor_plan(
            floor_polygon=poly,
            resolution=0.1,
            agent_radius=0.2
        )

        start = (3.5, 0.0, 1.0) # In the right leg of L
        goal = (1.0, 0.0, 3.5)  # In the top leg of L

        res = find_path(grid, start, goal)
        self.assertTrue(res["found"], "Path in L-shaped room should be found")

        # Check every waypoint: must be strictly inside the room polygon!
        for wp in res["path"]:
            pt = Point(wp["x"], wp["z"])
            self.assertTrue(
                poly.buffer(0.05).contains(pt),
                f"Waypoint ({wp['x']}, {wp['z']}) leaked outside the room polygon!"
            )

if __name__ == "__main__":
    unittest.main()
