"""
Automated unit tests for Phase 4 Navigation Engine:
- RANSAC Floor Plane Alignment
- 2D Occupancy Grid Rasterization & Inflation
- 8-Connected A* Pathfinding with Line-of-Sight Smoothing
- Unreachable Target Handling
- Mini-map 2D Wall Segment Extraction
"""

import unittest
import numpy as np
import math

from navigation.alignment import fit_floor_plane_ransac, compute_alignment_matrix
from navigation.occupancy import generate_occupancy_grid, OccupancyGrid
from navigation.pathfinding import find_path, has_line_of_sight, smooth_path
from navigation.minimap import extract_wall_segments, ramer_douglas_peucker_2d

class TestNavigationEngine(unittest.TestCase):

    def test_floor_plane_alignment(self):
        """Test RANSAC floor alignment rotates normal to +Y and translates floor to y=0."""
        rng = np.random.RandomState(42)
        # Floor points on tilted plane y = 0.3*x - 0.1*z + 2.0
        x = rng.uniform(-4, 4, 1500)
        z = rng.uniform(-4, 4, 1500)
        y = 0.3 * x - 0.1 * z + 2.0 + rng.normal(0, 0.005, 1500)
        # Ceiling points at height +2.5m
        ceil_y = y + 2.5

        pts = np.vstack([np.column_stack([x, y, z]), np.column_stack([x, ceil_y, z])])

        transform, meta = compute_alignment_matrix(pts)

        self.assertEqual(transform.shape, (4, 4))
        # Bounds check: aligned floor should be at y=0
        self.assertAlmostEqual(meta["boundsAligned"]["minY"], 0.0, places=1)
        # Height should be ~2.4m (2.5m vertical offset rotated along normal)
        self.assertAlmostEqual(meta["boundsAligned"]["maxY"], 2.4, places=1)
        # Center in X and Z should be centered around 0
        self.assertAlmostEqual(meta["boundsAligned"]["minX"] + meta["boundsAligned"]["maxX"], 0.0, places=2)
        self.assertAlmostEqual(meta["boundsAligned"]["minZ"] + meta["boundsAligned"]["maxZ"], 0.0, places=2)

    def test_occupancy_grid_rasterization_and_inflation(self):
        """Test obstacle rasterization between 0.2m and 1.6m and inflation by agent radius."""
        # Create a 10x10 room with walls at x=2, y between 0.5 and 1.5, z between -2 and 2
        wall_pts = np.column_stack([
            np.full(100, 2.0),
            np.linspace(0.5, 1.5, 100),
            np.linspace(-2, 2, 100)
        ])
        # Low floor points (y=0.05) which should NOT become obstacles
        floor_pts = np.column_stack([
            np.random.uniform(-4, 4, 200),
            np.full(200, 0.05),
            np.random.uniform(-4, 4, 200)
        ])
        pts = np.vstack([wall_pts, floor_pts])

        grid = generate_occupancy_grid(pts, resolution=0.05, agent_radius=0.25)

        self.assertIsInstance(grid, OccupancyGrid)
        # Origin and bounds should cover [-4, 4]
        self.assertLessEqual(grid.min_x, -4.0)
        self.assertGreaterEqual(grid.max_x, 4.0)

        # Floor at (0, 0) should be walkable
        self.assertTrue(grid.is_walkable(0.0, 0.0))

        # Direct wall coordinate at (2.0, 0.0) should NOT be walkable
        self.assertFalse(grid.is_walkable(2.0, 0.0))

        # Coordinate within agent radius (2.0 - 0.2 = 1.8) should be inflated (not walkable)
        self.assertFalse(grid.is_walkable(1.85, 0.0))

        # Coordinate well clear of wall (1.0, 0.0) should be walkable
        self.assertTrue(grid.is_walkable(1.0, 0.0))

    def test_pathfinding_obstacle_routing(self):
        """Test A* navigates around a central wall obstacle and smooths path."""
        # Central wall dividing x=-3 to +3 at x=0, with z between -2 and +2
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
        self.assertGreater(res["distanceMeters"], 5.0) # Direct Euclidean is 5.0, detour must be > 5.0
        self.assertGreater(res["walkingEtaSeconds"], 0.0)
        self.assertLess(res["smoothedWaypointsCount"], res["rawWaypointsCount"])

        # Path should go around the wall: either z < -2.0 or z > 2.0
        detour_z_vals = [pt["z"] for pt in res["path"]]
        has_detour = any(abs(z_val) > 1.8 for z_val in detour_z_vals)
        self.assertTrue(has_detour, "Path should route around the wall")

    def test_unreachable_target_handling(self):
        """Test that attempting to path into a fully enclosed obstacle fails cleanly."""
        # Hollow square impenetrable bunker
        bunker = []
        for x_val in np.linspace(-1, 1, 30):
            bunker.append([x_val, 1.0, -1.0])
            bunker.append([x_val, 1.0, 1.0])
        for z_val in np.linspace(-1, 1, 30):
            bunker.append([-1.0, 1.0, z_val])
            bunker.append([1.0, 1.0, z_val])
        bunker_pts = np.array(bunker)
        room_pts = np.array([[-6, 0, -6], [6, 0, 6]])
        pts = np.vstack([bunker_pts, room_pts])

        # Dense grid with large inflation so inside is totally trapped
        grid = generate_occupancy_grid(pts, resolution=0.05, agent_radius=0.6)

        # Target in the dead center of the bunker
        res = find_path(grid, (-4.0, 0.0, 0.0), (0.0, 0.0, 0.0), snap_radius_m=0.3)

        # Either snap fails or no path found, but should NOT raise an unhandled exception
        self.assertFalse(res["found"])
        self.assertEqual(res["distanceMeters"], 0.0)

    def test_minimap_wall_segment_extraction(self):
        """Test 2D mini-map extracts simplified RDP wall line segments."""
        x = np.linspace(-4, 4, 80)
        z = np.linspace(-4, 4, 80)
        wall_n = np.column_stack([x, np.ones(80), np.full(80, 4.0)])
        wall_s = np.column_stack([x, np.ones(80), np.full(80, -4.0)])
        wall_w = np.column_stack([np.full(80, -4.0), np.ones(80), z])
        wall_e = np.column_stack([np.full(80, 4.0), np.ones(80), z])
        pts = np.vstack([wall_n, wall_s, wall_w, wall_e])

        grid = generate_occupancy_grid(pts, resolution=0.05)
        minimap = extract_wall_segments(grid, rdp_epsilon_m=0.1)

        self.assertGreater(minimap["totalSegments"], 0)
        self.assertTrue("wallSegments" in minimap)
        for seg in minimap["wallSegments"]:
            self.assertIn("start", seg)
            self.assertIn("end", seg)
            self.assertGreater(seg["length"], 0.1)

if __name__ == "__main__":
    unittest.main()
