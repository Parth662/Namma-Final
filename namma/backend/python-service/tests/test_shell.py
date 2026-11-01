import os
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("OMP_NUM_THREADS", "1")

import unittest
import numpy as np
from pathlib import Path
import sys

# Ensure python-service root is in sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from structural_shell import detect_planes_and_build_shell

class TestStructuralShell(unittest.TestCase):

    def generate_plane_points(self, p_min, p_max, count=200, noise=0.01):
        """Generates uniformly distributed points within a 3D box or plane with gaussian noise."""
        pts = np.random.uniform(p_min, p_max, size=(count, 3))
        if noise > 0:
            pts += np.random.normal(0, noise, size=pts.shape)
        return pts

    def test_a_synthetic_box_room(self):
        """
        a) Synthetic box room (perfect 4x3x2.5 m box with noise)
           -> Closes cleanly, area ~12 m^2, 0 inferred walls.
        """
        # Box from x in [-2, 2], y in [0, 2.5], z in [-1.5, 1.5]
        # Dimensions: 4m (X) x 2.5m (Y) x 3m (Z) -> Floor area = 4 * 3 = 12 m^2
        np.random.seed(42)
        # Floor (y=0)
        floor = self.generate_plane_points([-2.0, -0.02, -1.5], [2.0, 0.02, 1.5], count=400)
        # Ceiling (y=2.5)
        ceiling = self.generate_plane_points([-2.0, 2.48, -1.5], [2.0, 2.52, 1.5], count=150)
        # 4 Walls:
        # Wall 1: x = -2 (normal approx [1, 0, 0])
        w1 = self.generate_plane_points([-2.02, 0.0, -1.5], [-1.98, 2.5, 1.5], count=250)
        # Wall 2: x = +2 (normal approx [-1, 0, 0])
        w2 = self.generate_plane_points([1.98, 0.0, -1.5], [2.02, 2.5, 1.5], count=250)
        # Wall 3: z = -1.5 (normal approx [0, 0, 1])
        w3 = self.generate_plane_points([-2.0, 0.0, -1.52], [2.0, 2.5, -1.48], count=250)
        # Wall 4: z = +1.5 (normal approx [0, 0, -1])
        w4 = self.generate_plane_points([-2.0, 0.0, 1.48], [2.0, 2.5, 1.52], count=250)

        all_points = np.vstack([floor, ceiling, w1, w2, w3, w4])
        res = detect_planes_and_build_shell(all_points)

        self.assertTrue(res["success"], f"Failed to build shell: {res.get('reason')}")
        area = res["metrics"]["area_sqm"]
        print(f"[Test A] Box Room Area: {area} m^2, Inferred walls: {res['metrics']['inferred_wall_count']}")
        self.assertAlmostEqual(area, 12.0, delta=1.5)
        self.assertEqual(res["metrics"]["inferred_wall_count"], 0)
        self.assertIsNotNone(res["shell_scene"])
        self.assertIn("floor", res["shell_scene"].geometry)
        self.assertIn("ceiling", res["shell_scene"].geometry)

    def test_b_l_shaped_room(self):
        """
        b) L-shaped room -> Closes cleanly, correct area.
        Box 1: [0, 4] x [0, 2] -> 8 m^2
        Box 2: [0, 2] x [2, 4] -> 4 m^2
        Total area = 12 m^2
        """
        np.random.seed(42)
        # Floor points in L shape
        pts_floor_1 = self.generate_plane_points([0.0, -0.02, 0.0], [4.0, 0.02, 2.0], count=300)
        pts_floor_2 = self.generate_plane_points([0.0, -0.02, 2.0], [2.0, 0.02, 4.0], count=200)
        floor = np.vstack([pts_floor_1, pts_floor_2])

        # Wall points along L perimeter:
        # (0,0)->(4,0), (4,0)->(4,2), (4,2)->(2,2), (2,2)->(2,4), (2,4)->(0,4), (0,4)->(0,0)
        w1 = self.generate_plane_points([0, 0, -0.02], [4, 2.5, 0.02], count=200)
        w2 = self.generate_plane_points([3.98, 0, 0], [4.02, 2.5, 2], count=150)
        w3 = self.generate_plane_points([1.98, 0, 1.98], [4.02, 2.5, 2.02], count=150)
        w4 = self.generate_plane_points([1.98, 0, 2], [2.02, 2.5, 4], count=150)
        w5 = self.generate_plane_points([0, 0, 3.98], [2, 2.5, 4.02], count=150)
        w6 = self.generate_plane_points([-0.02, 0, 0], [0.02, 2.5, 4], count=200)

        all_points = np.vstack([floor, w1, w2, w3, w4, w5, w6])
        res = detect_planes_and_build_shell(all_points)

        self.assertTrue(res["success"], f"Failed L-shape shell: {res.get('reason')}")
        area = res["metrics"]["area_sqm"]
        print(f"[Test B] L-Shaped Room Area: {area} m^2, Walls: {res['metrics']['wall_count']}")
        self.assertAlmostEqual(area, 12.0, delta=2.0)

    def test_c_noisy_corridor_with_missing_wall(self):
        """
        c) Noisy corridor with 1 missing wall
           -> Closes with at least 1 inferred wall, marked inferred.
        Corridor 5m x 1.5m (Wall 4 missing).
        """
        np.random.seed(42)
        # Floor: x in [-2.5, 2.5], z in [-0.75, 0.75]
        floor = self.generate_plane_points([-2.5, -0.03, -0.75], [2.5, 0.03, 0.75], count=300, noise=0.03)
        # Left wall (z = -0.75)
        w_left = self.generate_plane_points([-2.5, 0, -0.78], [2.5, 2.4, -0.72], count=250, noise=0.03)
        # Right wall (z = +0.75)
        w_right = self.generate_plane_points([-2.5, 0, 0.72], [2.5, 2.4, 0.78], count=250, noise=0.03)
        # Back wall (x = -2.5)
        w_back = self.generate_plane_points([-2.53, 0, -0.75], [-2.47, 2.4, 0.75], count=150, noise=0.03)
        # Missing front wall (x = +2.5 is completely absent!)

        all_points = np.vstack([floor, w_left, w_right, w_back])
        res = detect_planes_and_build_shell(all_points)

        self.assertTrue(res["success"], f"Failed corridor shell: {res.get('reason')}")
        inferred_count = res["metrics"]["inferred_wall_count"]
        print(f"[Test C] Corridor Inferred Walls: {inferred_count}")
        self.assertGreaterEqual(inferred_count, 1, "Expected at least 1 missing wall to be marked inferred")

        # Verify inferred wall node exists in shell_scene
        has_inferred_node = any("inferred_wall" in name for name in res["shell_scene"].geometry.keys())
        self.assertTrue(has_inferred_node, "Expected an inferred_wall geometry node in the 3D shell")

    def test_d_pure_noise_cloud(self):
        """
        d) Pure noise / non-planar cloud
           -> Gracefully returns failure/None without crashing, pipeline finishes with Mesh+Points only.
        """
        np.random.seed(42)
        # Pure 3D spherical noise (no floor or walls)
        random_noise = np.random.normal(0, 10.0, size=(100, 3))
        res = detect_planes_and_build_shell(random_noise)
        print(f"[Test D] Pure noise result success: {res.get('success')}")
        # Must return dict without raising an unhandled exception
        self.assertIsInstance(res, dict)

if __name__ == "__main__":
    unittest.main()
