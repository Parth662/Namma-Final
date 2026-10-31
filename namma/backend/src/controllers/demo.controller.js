import { Project } from '../models/Project.js';

export const getDemoProject = async (req, res) => {
  try {
    let demoProj = await Project.findOne({ isDemo: true, status: 'completed' }).lean();
    if (!demoProj) {
      demoProj = await Project.findOne({ name: /Sample.*Digital Twin/i, status: 'completed' }).lean();
    }

    if (!demoProj) {
      return res.status(200).json({
        success: true,
        isDemo: true,
        data: {
          _id: 'demo_sample_quad',
          name: 'Namma Space Innovation Quad (Demo Scene)',
          description: 'High-fidelity pre-baked photogrammetric digital twin ready for offline walkthrough.',
          status: 'completed',
          progress: 100,
          currentStage: 'DIGITAL TWIN READY',
          modelUrl: '/storage/projects/sample_digital_twin/final/scene.glb',
          thumbnailUrl: '/storage/projects/sample_digital_twin/preview/thumbnail.jpg',
          boundingBox: {
            minX: -2.5,
            minY: -1.2,
            minZ: -3.0,
            maxX: 2.5,
            maxY: 1.5,
            maxZ: 3.0,
          },
          reconstructionMetadata: {
            registeredFrames: 45,
            points3D: 12540,
            triangles: 24800,
            vertices: 12400,
            scaleMeters: '5.0m × 2.7m × 6.0m',
          },
          isPublic: true,
          isDemo: true,
        },
      });
    }

    return res.status(200).json({
      success: true,
      isDemo: true,
      data: demoProj,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};
