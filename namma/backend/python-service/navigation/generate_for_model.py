import os
import sys
import json
import trimesh
import numpy as np

from navigation.occupancy import generate_occupancy_grid
from navigation.minimap import extract_wall_segments
from navigation.alignment import align_mesh_or_points

def generate_navigation_for_model(glb_path: str, output_json_path: str) -> dict:
    """
    Loads a GLB model, extracts 3D geometry, generates a 2D occupancy grid and wall segments,
    and writes navgrid.json.
    """
    if not os.path.exists(glb_path):
        raise FileNotFoundError(f"Model file not found: {glb_path}")

    print(f"[NavGen] Loading 3D model from {glb_path}...")
    loaded = trimesh.load(glb_path, force='mesh')

    if isinstance(loaded, trimesh.Scene):
        # Flatten scene geometries into a single mesh or concatenate vertices
        meshes = [g for g in loaded.geometry.values() if isinstance(g, trimesh.Trimesh)]
        if meshes:
            mesh = trimesh.util.concatenate(meshes)
        else:
            # Gather points
            points = np.vstack([np.asarray(g.vertices) for g in loaded.geometry.values() if hasattr(g, 'vertices')])
            mesh = trimesh.PointCloud(vertices=points)
    else:
        mesh = loaded

    print(f"[NavGen] Mesh loaded: {len(mesh.vertices)} vertices. Slicing and rasterizing grid...")
    grid = generate_occupancy_grid(mesh, resolution=0.05, agent_radius=0.25)
    print(f"[NavGen] Occupancy grid: {grid.width}x{grid.height} cells. Extracting wall segments...")
    wall_data = extract_wall_segments(grid)
    print(f"[NavGen] Extracted {wall_data['totalSegments']} wall segments.")

    payload = {
        "resolution": grid.resolution,
        "origin": [grid.min_x, grid.min_z],
        "width": grid.width,
        "height": grid.height,
        "bounds": {
            "minX": grid.min_x,
            "maxX": grid.max_x,
            "minZ": grid.min_z,
            "maxZ": grid.max_z,
        },
        "grid": grid.grid.tolist(),
        "wallSegments": wall_data.get("wallSegments", []),
        "totalSegments": wall_data.get("totalSegments", 0),
    }

    os.makedirs(os.path.dirname(output_json_path), exist_ok=True)
    with open(output_json_path, "w", encoding="utf-8") as f:
        json.dump(payload, f)

    print(f"[NavGen] Successfully wrote navigation data to {output_json_path}")
    return payload

if __name__ == "__main__":
    if len(sys.argv) >= 3:
        glb = sys.argv[1]
        out = sys.argv[2]
    else:
        base_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        glb = os.path.join(base_dir, "storage", "projects", "sample_digital_twin", "final", "scene.glb")
        out = os.path.join(base_dir, "storage", "projects", "sample_digital_twin", "navigation", "navgrid.json")

    generate_navigation_for_model(glb, out)

