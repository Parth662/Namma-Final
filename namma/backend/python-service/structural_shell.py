import os
import json
import math
from pathlib import Path
import numpy as np
import trimesh
from shapely.geometry import Polygon, MultiPolygon, LineString, MultiLineString, Point, MultiPoint
from shapely.ops import unary_union, polygonize, triangulate
from shapely.validation import make_valid

def triangulate_polygon_shapely(poly):
    """
    Robust 2D polygon triangulation using Shapely built-in GEOS Delaunay triangulation.
    Returns (vertices, faces) as numpy arrays. Zero extra C libraries required.
    """
    if not isinstance(poly, Polygon) or poly.is_empty:
        return None, None
    
    # Generate triangles from polygon coordinates
    raw_tris = triangulate(poly)
    # Filter triangles whose centroids lie inside the polygon
    valid_tris = [t for t in raw_tris if poly.contains(t.centroid)]
    if not valid_tris:
        # Fallback to intersects in case of very thin shapes
        valid_tris = [t for t in raw_tris if poly.intersects(t.centroid)]
    
    if not valid_tris:
        return None, None

    # Collect unique vertices and build face index array
    vertex_map = {}
    vertices = []
    faces = []

    for tri in valid_tris:
        coords = list(tri.exterior.coords)[:3]
        tri_face = []
        for x, z in coords:
            # Round slightly to merge shared vertices
            key = (round(float(x), 4), round(float(z), 4))
            if key not in vertex_map:
                vertex_map[key] = len(vertices)
                vertices.append([float(x), float(z)])
            tri_face.append(vertex_map[key])
        faces.append(tri_face)

    return np.array(vertices, dtype=np.float64), np.array(faces, dtype=np.int64)

def detect_planes_and_build_shell(points, normals=None, voxel_size=0.05):
    """
    Detects floor, ceiling, and vertical walls from a 3D point cloud,
    constructs a 2D floor polygon with Shapely, handles gap bridging with inferred segments,
    and produces 3D shell geometries and GeoJSON metadata.
    """
    if points is None or len(points) < 30:
        return {"success": False, "reason": "Insufficient points for structural shell extraction"}

    pts = np.asarray(points, dtype=np.float64)

    # 1. Estimate normals if not provided
    if normals is None or len(normals) != len(pts):
        try:
            import open3d as o3d
            pcd = o3d.geometry.PointCloud()
            pcd.points = o3d.utility.Vector3dVector(pts)
            pcd.estimate_normals(search_param=o3d.geometry.KDTreeSearchParamHybrid(radius=0.4, max_nn=30))
            pcd.orient_normals_consistent_tangent_plane(15)
            norms = np.asarray(pcd.normals)
        except Exception:
            norms = np.zeros_like(pts)
            norms[:, 1] = 1.0
    else:
        norms = np.asarray(normals, dtype=np.float64)

    # 2. Identify Floor Plane (horizontal plane with lowest Y containing >= 5% of points)
    min_pts_floor = max(10, int(len(pts) * 0.05))
    horizontal_mask = np.abs(norms[:, 1]) > 0.85
    
    y_floor = 0.0
    floor_inliers_count = 0

    if np.sum(horizontal_mask) >= min_pts_floor:
        h_pts = pts[horizontal_mask]
        y_vals = h_pts[:, 1]
        hist, bin_edges = np.histogram(y_vals, bins=40)
        cum_thresh = max(5, int(len(h_pts) * 0.08))
        found_bin = None
        for b_idx in range(len(hist)):
            if hist[b_idx] >= cum_thresh:
                found_bin = b_idx
                break
        if found_bin is not None:
            y_floor = float(0.5 * (bin_edges[found_bin] + bin_edges[found_bin + 1]))
            floor_inliers_count = int(hist[found_bin])
        else:
            y_floor = float(np.percentile(pts[:, 1], 5))
    else:
        # Check planarity: if cloud has no horizontal cluster, fail gracefully
        y_spread = np.std(pts[:, 1])
        x_spread = np.std(pts[:, 0])
        z_spread = np.std(pts[:, 2])
        if y_spread > 2.0 and abs(y_spread - x_spread) < 1.0 and abs(y_spread - z_spread) < 1.0:
            return {"success": False, "reason": "Point cloud is non-planar or pure noise (no floor detected)"}
        y_floor = float(np.percentile(pts[:, 1], 5))

    # 3. Identify Ceiling Plane (highest horizontal plane parallel to floor, at least 2.0m above floor)
    ceiling_candidates = pts[pts[:, 1] >= (y_floor + 1.8)]
    ceiling_inferred = True
    y_ceiling = y_floor + 2.6  # Standard default indoor height

    if len(ceiling_candidates) >= max(10, int(len(pts) * 0.02)):
        c_norms = norms[pts[:, 1] >= (y_floor + 1.8)]
        c_horiz = np.abs(c_norms[:, 1]) > 0.85
        if np.sum(c_horiz) >= 10:
            c_y_vals = ceiling_candidates[c_horiz][:, 1]
            hist_c, bin_edges_c = np.histogram(c_y_vals, bins=20)
            best_c_bin = np.argmax(hist_c)
            if hist_c[best_c_bin] >= 8:
                cand_ceil = float(0.5 * (bin_edges_c[best_c_bin] + bin_edges_c[best_c_bin + 1]))
                if cand_ceil >= (y_floor + 2.0):
                    y_ceiling = cand_ceil
                    ceiling_inferred = False

    # 4. Vertical Walls Detection (normal orthogonal to floor within 15 degrees: |ny| < 0.26)
    vertical_mask = np.abs(norms[:, 1]) < 0.26
    v_pts = pts[vertical_mask]
    v_norms = norms[vertical_mask]

    wall_segments = []
    # If insufficient vertical points exist, pure noise or non-room
    if len(v_pts) < 20:
        return {"success": False, "reason": "Insufficient vertical points to extract wall planes"}

    x_2d = v_pts[:, 0]
    z_2d = v_pts[:, 2]

    # Extract dominant lines
    remaining_indices = list(range(len(v_pts)))
    detected_lines = []

    for _ in range(8):  # Max 8 wall planes
        if len(remaining_indices) < 15:
            break
        
        sub_x = x_2d[remaining_indices]
        sub_z = z_2d[remaining_indices]
        best_inliers = []
        best_line = None

        n_sub = len(remaining_indices)
        iter_count = min(150, max(40, n_sub))
        for _ in range(iter_count):
            idx1, idx2 = np.random.choice(n_sub, 2, replace=False)
            p1 = np.array([sub_x[idx1], sub_z[idx1]])
            p2 = np.array([sub_x[idx2], sub_z[idx2]])
            diff = p2 - p1
            dist_pts = np.linalg.norm(diff)
            if dist_pts < 0.3:
                continue
            normal = np.array([-diff[1], diff[0]])
            norm_len = np.linalg.norm(normal)
            if norm_len < 1e-6:
                continue
            normal /= norm_len
            d_const = -np.dot(normal, p1)

            pts_sub_mat = np.column_stack([sub_x, sub_z])
            dists = np.abs(np.dot(pts_sub_mat, normal) + d_const)
            inliers = np.where(dists < 0.12)[0]

            if len(inliers) > len(best_inliers):
                best_inliers = inliers
                best_line = (normal, d_const, p1, p2)

        if len(best_inliers) >= max(12, int(len(v_pts) * 0.04)):
            normal, d_const, p1, p2 = best_line
            inlier_sub_idx = [remaining_indices[i] for i in best_inliers]
            detected_lines.append({
                "normal": normal,
                "d": d_const,
                "points": np.column_stack([x_2d[inlier_sub_idx], z_2d[inlier_sub_idx]])
            })
            inlier_set = set(inlier_sub_idx)
            remaining_indices = [idx for idx in remaining_indices if idx not in inlier_set]
        else:
            break

    if len(detected_lines) < 2:
        return {"success": False, "reason": "Fewer than 2 dominant wall planes detected"}

    # Snap detected wall normals to Manhattan frame if dominant angle is prominent
    primary_normal = detected_lines[0]["normal"]
    primary_angle = math.atan2(primary_normal[1], primary_normal[0])

    for dl in detected_lines:
        curr_angle = math.atan2(dl["normal"][1], dl["normal"][0])
        angle_diff = (curr_angle - primary_angle) % (math.pi / 2.0)
        if angle_diff > (math.pi / 4.0):
            angle_diff -= (math.pi / 2.0)

        # If within 15 degrees of 90-degree multiple, snap
        if abs(angle_diff) < math.radians(15):
            snapped_angle = curr_angle - angle_diff
            dl["normal"] = np.array([math.cos(snapped_angle), math.sin(snapped_angle)])
            dl["d"] = -float(np.median(np.dot(dl["points"], dl["normal"])))

    # Convert each detected line into a bounded segment along its inlier extent
    for dl in detected_lines:
        norm = dl["normal"]
        tangent = np.array([-norm[1], norm[0]])
        proj = np.dot(dl["points"], tangent)
        t_min = float(np.percentile(proj, 2))
        t_max = float(np.percentile(proj, 98))
        if (t_max - t_min) < 0.4:
            continue
        base_pt = -norm * dl["d"]
        p_start = base_pt + tangent * t_min
        p_end = base_pt + tangent * t_max
        wall_segments.append({
            "start": (float(p_start[0]), float(p_start[1])),
            "end": (float(p_end[0]), float(p_end[1])),
            "source": "measured"
        })

    # 5. Build 2D Floor Polygon with Shapely
    floor_poly = None

    if len(wall_segments) >= 3:
        try:
            lines = [LineString([s["start"], s["end"]]) for s in wall_segments]
            extended_lines = []
            for line in lines:
                coords = list(line.coords)
                p0 = np.array(coords[0])
                p1 = np.array(coords[1])
                vec = p1 - p0
                length = np.linalg.norm(vec)
                if length > 1e-4:
                    unit_v = vec / length
                    ext_p0 = p0 - unit_v * 0.40
                    ext_p1 = p1 + unit_v * 0.40
                    extended_lines.append(LineString([ext_p0, ext_p1]))

            union_geom = unary_union(extended_lines)
            candidate_polys = list(polygonize(union_geom))

            if candidate_polys:
                # Merge connected adjacent polygon cells (e.g. L-shaped rooms or partitioned spaces)
                merged_room = unary_union(candidate_polys)
                valid_poly = make_valid(merged_room)
                if isinstance(valid_poly, Polygon) and valid_poly.area >= 2.0:
                    floor_poly = valid_poly
                elif isinstance(valid_poly, MultiPolygon):
                    sub_polys = sorted(list(valid_poly.geoms), key=lambda p: p.area, reverse=True)
                    if sub_polys and sub_polys[0].area >= 2.0:
                        floor_poly = sub_polys[0]
        except Exception as e:
            print(f"[StructuralShell] Polygonization attempt note: {e}")

    # Fallback / Gap-bridging if polygon not closed (e.g. corridor with missing wall)
    if floor_poly is None or not floor_poly.is_valid or floor_poly.area < 1.5:
        all_2d_pts = []
        for s in wall_segments:
            all_2d_pts.append(s["start"])
            all_2d_pts.append(s["end"])
        if len(all_2d_pts) >= 3:
            poly_candidate = MultiPoint(all_2d_pts).convex_hull
            if isinstance(poly_candidate, Polygon) and poly_candidate.area >= 1.0:
                floor_poly = poly_candidate

    if floor_poly is None or not floor_poly.is_valid:
        return {"success": False, "reason": "Failed to close valid 2D floor polygon"}

    floor_poly = make_valid(floor_poly)
    if isinstance(floor_poly, MultiPolygon):
        floor_poly = sorted(list(floor_poly.geoms), key=lambda p: p.area, reverse=True)[0]

    if not isinstance(floor_poly, Polygon) or floor_poly.area < 1.0:
        return {"success": False, "reason": "Extracted room polygon has insufficient area"}

    floor_poly = floor_poly.simplify(0.04, preserve_topology=True)
    exterior_coords = list(floor_poly.exterior.coords)
    if len(exterior_coords) < 4:
        return {"success": False, "reason": "Room polygon has fewer than 3 boundary edges"}

    # 6. Classify Boundary Edges as Measured vs Inferred
    final_walls = []
    for i in range(len(exterior_coords) - 1):
        p1 = exterior_coords[i]
        p2 = exterior_coords[i+1]
        edge_seg = LineString([p1, p2])
        edge_len = edge_seg.length
        if edge_len < 0.15:
            continue

        is_measured = False
        edge_dir = np.array([p2[0] - p1[0], p2[1] - p1[1]])
        edge_dir /= max(1e-6, np.linalg.norm(edge_dir))

        for ws in wall_segments:
            ws_seg = LineString([ws["start"], ws["end"]])
            dist = edge_seg.distance(ws_seg)
            if dist < 0.35:
                ws_dir = np.array([ws["end"][0] - ws["start"][0], ws["end"][1] - ws["start"][1]])
                ws_dir /= max(1e-6, np.linalg.norm(ws_dir))
                dot_prod = abs(np.dot(edge_dir, ws_dir))
                if dot_prod > 0.85:
                    is_measured = True
                    break

        final_walls.append({
            "index": i,
            "start": p1,
            "end": p2,
            "length": round(edge_len, 2),
            "source": "measured" if is_measured else "inferred"
        })

    inferred_count = sum(1 for w in final_walls if w["source"] == "inferred")
    total_walls = len(final_walls)
    inferred_pct = round((inferred_count / max(1, total_walls)) * 100.0, 1)

    # 7. Generate 3D Shell Geometry (Extruded Floor Polygon)
    shell_scene = trimesh.Scene()

    # Triangulate polygon cleanly with Shapely
    v_2d, f_2d = triangulate_polygon_shapely(floor_poly)

    # (a) Floor Mesh
    if v_2d is not None and f_2d is not None:
        floor_vertices = np.column_stack([
            v_2d[:, 0],
            np.full(len(v_2d), y_floor),
            v_2d[:, 1]
        ])
        floor_mesh = trimesh.Trimesh(
            vertices=floor_vertices,
            faces=f_2d,
            process=True
        )
        if np.mean(floor_mesh.face_normals[:, 1]) < 0:
            floor_mesh.faces = np.fliplr(floor_mesh.faces)
        floor_mesh.visual.vertex_colors = np.full((len(floor_vertices), 4), [210, 215, 222, 230], dtype=np.uint8)
        shell_scene.add_geometry(floor_mesh, node_name="floor", geom_name="floor")

        # (b) Ceiling Mesh (translucent)
        ceil_vertices = np.column_stack([
            v_2d[:, 0],
            np.full(len(v_2d), y_ceiling),
            v_2d[:, 1]
        ])
        ceil_mesh = trimesh.Trimesh(
            vertices=ceil_vertices,
            faces=f_2d,
            process=True
        )
        if np.mean(ceil_mesh.face_normals[:, 1]) > 0:
            ceil_mesh.faces = np.fliplr(ceil_mesh.faces)
        ceil_mesh.visual.vertex_colors = np.full((len(ceil_vertices), 4), [235, 240, 248, 120], dtype=np.uint8)
        shell_scene.add_geometry(ceil_mesh, node_name="ceiling", geom_name="ceiling")

    # (c) Wall Meshes (Vertical Quads)
    for w in final_walls:
        p1 = w["start"]
        p2 = w["end"]
        v_quad = np.array([
            [p1[0], y_floor, p1[1]],
            [p2[0], y_floor, p2[1]],
            [p2[0], y_ceiling, p2[1]],
            [p1[0], y_ceiling, p1[1]],
        ], dtype=np.float64)
        f_quad = np.array([
            [0, 1, 2],
            [0, 2, 3]
        ], dtype=np.int64)

        wall_mesh = trimesh.Trimesh(vertices=v_quad, faces=f_quad, process=False)
        node_prefix = "wall" if w["source"] == "measured" else "inferred_wall"
        node_name = f"{node_prefix}_{w['index']}"

        if w["source"] == "inferred":
            wall_mesh.visual.vertex_colors = np.full((4, 4), [245, 158, 11, 150], dtype=np.uint8)
        else:
            wall_mesh.visual.vertex_colors = np.full((4, 4), [180, 195, 210, 220], dtype=np.uint8)

        shell_scene.add_geometry(wall_mesh, node_name=node_name, geom_name=node_name)

    # 8. Local Metric GeoJSON Export
    room_coords = [[float(c[0]), float(c[1])] for c in exterior_coords]
    geojson_data = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [room_coords]
                },
                "properties": {
                    "area_sqm": round(float(floor_poly.area), 2),
                    "perimeter_m": round(float(floor_poly.length), 2),
                    "ceiling_height_m": round(float(y_ceiling - y_floor), 2),
                    "y_floor": round(float(y_floor), 2),
                    "y_ceiling": round(float(y_ceiling), 2),
                    "wall_count": total_walls,
                    "inferred_wall_count": inferred_count,
                    "inferred_percentage": inferred_pct,
                    "confidence": round(1.0 - (inferred_count / max(1, total_walls)) * 0.5, 2),
                    "source": "hybrid_photogrammetry_inferred" if inferred_count > 0 else "measured_photogrammetry",
                    "walls": final_walls
                }
            }
        ]
    }

    metrics_data = {
        "area_sqm": round(float(floor_poly.area), 2),
        "perimeter_m": round(float(floor_poly.length), 2),
        "ceiling_height_m": round(float(y_ceiling - y_floor), 2),
        "y_floor": round(float(y_floor), 2),
        "y_ceiling": round(float(y_ceiling), 2),
        "wall_count": total_walls,
        "inferred_wall_count": inferred_count,
        "inferred_percentage": inferred_pct,
        "confidence": round(1.0 - (inferred_count / max(1, total_walls)) * 0.5, 2),
    }

    return {
        "success": True,
        "shell_scene": shell_scene,
        "geojson": geojson_data,
        "metrics": metrics_data,
        "floor_polygon": floor_poly,
        "walls": final_walls,
        "y_floor": float(y_floor),
        "y_ceiling": float(y_ceiling),
        "ceiling_inferred": ceiling_inferred
    }
