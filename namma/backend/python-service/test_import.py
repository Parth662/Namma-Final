import sys
try:
    import open3d
    print("OPEN3D_LOADED_OK")
except Exception as e:
    print(f"OPEN3D_ERROR: {e}")
except BaseException as be:
    print(f"OPEN3D_BASE_ERROR: {be}")
