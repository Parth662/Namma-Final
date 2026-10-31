import numpy as np
from typing import Tuple, Optional, Union, Dict, Any

def fit_floor_plane_ransac(
    points: np.ndarray,
    distance_threshold: float = 0.05,
    max_iterations: int = 1000,
    min_inliers_ratio: float = 0.05
) -> Tuple[np.ndarray, float, np.ndarray]:
    """
    Fits a ground/floor plane using RANSAC.
    
    Args:
        points: (N, 3) numpy array of point coordinates.
        distance_threshold: maximum distance in meters for a point to be an inlier.
        max_iterations: maximum RANSAC trials.
        min_inliers_ratio: minimum fraction of points to accept plane.
        
    Returns:
        normal: (3,) unit vector of floor plane pointing up into the scene.
        d: scalar offset such that normal . p + d = 0 for plane points.
        inliers_mask: boolean array (N,) of points on the floor plane.
    """
    n_points = len(points)
    if n_points < 3:
        return np.array([0.0, 1.0, 0.0]), 0.0, np.zeros(n_points, dtype=bool)

    # Downsample points for RANSAC if very large to conserve CPU & memory
    if n_points > 5000:
        idx_sample = np.random.choice(n_points, 5000, replace=False)
        sample_pts = points[idx_sample]
    else:
        sample_pts = points

    best_inlier_count = -1
    best_plane = None
    best_inlier_mask = None
    rng = np.random.RandomState(42)

    # Candidate planes from random 3 non-collinear points
    for _ in range(max_iterations):
        sample_idx = rng.choice(len(sample_pts), 3, replace=False)
        p1, p2, p3 = sample_pts[sample_idx]

        v1 = p2 - p1
        v2 = p3 - p1
        normal = np.cross(v1, v2)
        norm = np.linalg.norm(normal)
        if norm < 1e-6:
            continue
        normal = normal / norm

        d = -float(np.dot(normal, p1))

        # Vectorized distance calculation
        dists = np.abs(np.dot(points, normal) + d)
        inlier_mask = dists < distance_threshold
        inlier_count = int(np.sum(inlier_mask))

        if inlier_count > best_inlier_count:
            best_inlier_count = inlier_count
            best_plane = (normal, d)
            best_inlier_mask = inlier_mask

    if best_plane is None or (best_inlier_count / max(1, n_points)) < min_inliers_ratio:
        # Fallback: estimate ground plane as minimum bounding box base
        min_y = float(np.min(points[:, 1]))
        return np.array([0.0, 1.0, 0.0]), -min_y, np.ones(n_points, dtype=bool)

    normal, d = best_plane

    # Refine plane equation using Least Squares on inliers
    inlier_pts = points[best_inlier_mask]
    if len(inlier_pts) >= 3:
        centroid = inlier_pts.mean(axis=0)
        _, _, vh = np.linalg.svd(inlier_pts - centroid)
        normal = vh[2, :]
        normal = normal / np.linalg.norm(normal)
        d = -float(np.dot(normal, centroid))
        # Recompute inliers
        dists = np.abs(np.dot(points, normal) + d)
        best_inlier_mask = dists < distance_threshold

    # Ensure normal points toward the majority of the points (upwards into the room)
    centroid_all = points.mean(axis=0)
    # Vector from a point on the plane to the scene centroid
    plane_pt = -normal * d
    to_centroid = centroid_all - plane_pt
    if np.dot(normal, to_centroid) < 0:
        normal = -normal
        d = -d

    return normal, d, best_inlier_mask


def compute_alignment_matrix(
    points: np.ndarray,
    distance_threshold: float = 0.05
) -> Tuple[np.ndarray, Dict[str, Any]]:
    """
    Computes a 4x4 rigid transformation matrix that:
    1. Rotates geometry so the floor plane normal aligns with +Y [0, 1, 0].
    2. Translates geometry so the floor plane is at y = 0.
    3. Centers the geometry in X and Z axes (bounding box center at x=0, z=0).
    """
    normal, d, inliers = fit_floor_plane_ransac(points, distance_threshold=distance_threshold)

    # 1. Rotation from normal to target [0, 1, 0]
    target_up = np.array([0.0, 1.0, 0.0], dtype=np.float64)
    normal = normal.astype(np.float64)

    dot = float(np.clip(np.dot(normal, target_up), -1.0, 1.0))
    cross = np.cross(normal, target_up)
    cross_norm = float(np.linalg.norm(cross))

    if cross_norm < 1e-6:
        if dot > 0:
            # Already aligned
            rot_matrix = np.eye(3, dtype=np.float64)
        else:
            # 180 degree flip around X axis
            rot_matrix = np.diag([1.0, -1.0, -1.0])
    else:
        # Rodrigues rotation formula
        v = cross / cross_norm
        angle = float(np.arccos(dot))
        c = np.cos(angle)
        s = np.sin(angle)
        K = np.array([
            [0, -v[2], v[1]],
            [v[2], 0, -v[0]],
            [-v[1], v[0], 0]
        ], dtype=np.float64)
        rot_matrix = np.eye(3) + s * K + (1.0 - c) * np.dot(K, K)

    # 2. Rotate points to check transformed bounding box and floor y
    rotated_pts = np.dot(points, rot_matrix.T)
    if np.any(inliers):
        rotated_inliers = rotated_pts[inliers]
        floor_y = float(np.median(rotated_inliers[:, 1]))
    else:
        floor_y = float(np.min(rotated_pts[:, 1]))

    min_x, max_x = float(np.min(rotated_pts[:, 0])), float(np.max(rotated_pts[:, 0]))
    min_z, max_z = float(np.min(rotated_pts[:, 2])), float(np.max(rotated_pts[:, 2]))
    center_x = (min_x + max_x) / 2.0
    center_z = (min_z + max_z) / 2.0

    # 3. Construct 4x4 matrix: T * R
    # Transformation: P_aligned = R * P + Translation
    # where Translation = [-center_x, -floor_y, -center_z]
    translation = np.array([-center_x, -floor_y, -center_z], dtype=np.float64)
    transform = np.eye(4, dtype=np.float64)
    transform[:3, :3] = rot_matrix
    transform[:3, 3] = translation

    metadata = {
        "floorPlaneEquation": {
            "a": float(normal[0]),
            "b": float(normal[1]),
            "c": float(normal[2]),
            "d": float(d)
        },
        "floorInliersCount": int(np.sum(inliers)),
        "floorHeightBefore": float(floor_y),
        "alignmentMatrix": transform.tolist(),
        "boundsAligned": {
            "minX": float(min_x - center_x),
            "maxX": float(max_x - center_x),
            "minY": 0.0,
            "maxY": float(np.max(rotated_pts[:, 1]) - floor_y),
            "minZ": float(min_z - center_z),
            "maxZ": float(max_z - center_z)
        }
    }

    return transform, metadata


def align_mesh_or_points(geometry: Any) -> Tuple[Any, np.ndarray, Dict[str, Any]]:
    """
    Applies the alignment transformation to either a trimesh.Trimesh, Open3D TriangleMesh/PointCloud,
    or a numpy array (N, 3).
    
    Returns:
        (aligned_geometry, transform_matrix, metadata)
    """
    import trimesh

    if isinstance(geometry, np.ndarray):
        points = geometry
        transform, meta = compute_alignment_matrix(points)
        ones = np.ones((len(points), 1))
        homog = np.hstack([points, ones])
        aligned = np.dot(homog, transform.T)[:, :3]
        return aligned, transform, meta

    elif isinstance(geometry, trimesh.Trimesh):
        points = np.asarray(geometry.vertices)
        transform, meta = compute_alignment_matrix(points)
        geometry.apply_transform(transform)
        return geometry, transform, meta

    elif isinstance(geometry, trimesh.PointCloud):
        points = np.asarray(geometry.vertices)
        transform, meta = compute_alignment_matrix(points)
        geometry.apply_transform(transform)
        return geometry, transform, meta

    else:
        # Check for Open3D geometries
        try:
            import open3d as o3d
            if isinstance(geometry, (o3d.geometry.TriangleMesh, o3d.geometry.PointCloud)):
                points = np.asarray(geometry.vertices if hasattr(geometry, 'vertices') else geometry.points)
                transform, meta = compute_alignment_matrix(points)
                geometry.transform(transform)
                return geometry, transform, meta
        except ImportError:
            pass

        raise TypeError(f"Unsupported geometry type: {type(geometry)}")

