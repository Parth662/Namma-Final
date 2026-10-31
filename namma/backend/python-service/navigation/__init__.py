"""
Navigation and Spatial Alignment Engine for Namma Digital Twin.
Includes floor plane alignment, 2D occupancy rasterization, A* pathfinding, and 2D mini-map generation.
"""

from .alignment import fit_floor_plane_ransac, compute_alignment_matrix, align_mesh_or_points
