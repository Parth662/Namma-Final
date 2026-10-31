import { Project } from '../models/Project.js';
import { ReconstructionJob } from '../models/ReconstructionJob.js';
import { storageService } from '../services/storage.service.js';

export const createProject = async (req, res, next) => {
  try {
    const { name, description, locationName, latitude, longitude } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Project name is required',
      });
    }

    const project = await Project.create({
      userId: req.user._id,
      name: name.trim(),
      description: description ? description.trim() : '',
      locationName: locationName ? locationName.trim() : '',
      latitude: latitude !== undefined && latitude !== null ? Number(latitude) : null,
      longitude: longitude !== undefined && longitude !== null ? Number(longitude) : null,
      status: 'created',
      progress: 0,
      currentStage: 'CREATED',
    });

    // Ensure storage structure is initialized for this project
    storageService.ensureProjectDirectories(project._id);

    res.status(201).json({
      success: true,
      data: project,
    });
  } catch (error) {
    next(error);
  }
};

export const getProjects = async (req, res, next) => {
  try {
    const projects = await Project.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .lean();

    res.status(200).json({
      success: true,
      count: projects.length,
      data: projects,
    });
  } catch (error) {
    next(error);
  }
};

export const getProjectById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const project = await Project.findOne({ _id: id, userId: req.user._id });

    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found or you do not have permission to view it',
      });
    }

    // Also get the latest reconstruction job if any
    const latestJob = await ReconstructionJob.findOne({ projectId: id })
      .sort({ createdAt: -1 })
      .lean();

    res.status(200).json({
      success: true,
      data: project,
      latestJob,
    });
  } catch (error) {
    next(error);
  }
};

export const deleteProject = async (req, res, next) => {
  try {
    const { id } = req.params;
    const project = await Project.findOne({ _id: id, userId: req.user._id });

    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found or you do not have permission to delete it',
      });
    }

    // Delete project files
    storageService.deleteProjectFiles(project._id);

    // Delete jobs
    await ReconstructionJob.deleteMany({ projectId: id });

    // Delete project
    await Project.findByIdAndDelete(id);

    res.status(200).json({
      success: true,
      message: 'Project and associated 3D reconstruction files deleted successfully',
    });
  } catch (error) {
    next(error);
  }
};

// Section 18 & 26: Digital Twin Metadata endpoint: GET /api/projects/:id/metadata
export const getProjectMetadata = async (req, res, next) => {
  try {
    const { id } = req.params;
    const project = await Project.findOne({ _id: id, userId: req.user._id });

    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found',
      });
    }

    const metadata = {
      projectId: project._id,
      location: {
        latitude: project.latitude || 0,
        longitude: project.longitude || 0,
        locationName: project.locationName || '',
      },
      bounds: project.boundingBox || {
        minX: 0,
        minY: 0,
        minZ: 0,
        maxX: 0,
        maxY: 0,
        maxZ: 0,
      },
      model: {
        format: project.outputType || 'glb',
        url: project.modelUrl || '',
        previewUrl: project.previewUrl || project.thumbnailUrl || '',
        size: project.reconstructionMetadata?.modelSize || 0,
      },
      quality: {
        vertices: project.reconstructionMetadata?.vertices || 0,
        triangles: project.reconstructionMetadata?.triangles || 0,
        textureResolution: project.reconstructionMetadata?.textureResolution || 0,
      },
      reconstructionMetadata: project.reconstructionMetadata || {},
    };

    res.status(200).json({
      success: true,
      data: metadata,
    });
  } catch (error) {
    next(error);
  }
};

// Section 21 & 22 & 26: Launch 3D View endpoint: GET /api/projects/:id/model
export const getProjectModel = async (req, res, next) => {
  try {
    const { id } = req.params;
    const project = await Project.findOne({ _id: id, userId: req.user._id });

    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found',
      });
    }

    if (project.status !== 'completed') {
      return res.status(400).json({
        success: false,
        status: project.status,
        error: `3D model is not ready yet. Current status: ${project.status}`,
      });
    }

    res.status(200).json({
      projectId: project._id,
      status: project.status,
      model: {
        format: project.outputType || 'glb',
        url: project.modelUrl,
        thumbnail: project.thumbnailUrl || project.previewUrl,
        availableLODs: project.reconstructionMetadata?.availableLODs || ['lod0'],
      },
      bounds: project.boundingBox,
      metadata: project.reconstructionMetadata,
    });
  } catch (error) {
    next(error);
  }
};

// Scale Calibration: POST /api/projects/:id/calibrate
export const calibrateProject = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { p1, p2, realDistanceMeters, doorHeightFallback } = req.body;

    const project = await Project.findOne({
      _id: id,
      $or: [{ userId: req.user._id }, { isDemo: true }],
    });

    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found',
      });
    }

    let metersPerUnit = 1.0;
    let calibratedDist = realDistanceMeters ? Number(realDistanceMeters) : 2.0;

    if (Array.isArray(p1) && Array.isArray(p2) && p1.length === 3 && p2.length === 3) {
      const dx = Number(p2[0]) - Number(p1[0]);
      const dy = Number(p2[1]) - Number(p1[1]);
      const dz = Number(p2[2]) - Number(p1[2]);
      const modelDistance = Math.sqrt(dx * dx + dy * dy + dz * dz);

      if (modelDistance < 1e-4) {
        return res.status(400).json({
          success: false,
          error: 'Calibration points must be distinct',
        });
      }

      metersPerUnit = calibratedDist / modelDistance;
      project.calibration = {
        p1: p1.map(Number),
        p2: p2.map(Number),
        realDistanceMeters: calibratedDist,
        calibratedAt: new Date(),
      };
    } else {
      // Fallback: estimate using door opening height (~2.0m) or bounding box height
      const bboxHeight = (project.boundingBox?.maxY || 2.0) - (project.boundingBox?.minY || 0.0);
      const fallbackTarget = 2.0; // standard door height in meters
      metersPerUnit = bboxHeight > 0.1 ? fallbackTarget / bboxHeight : 1.0;
      calibratedDist = fallbackTarget;
      project.calibration = {
        p1: [0, 0, 0],
        p2: [0, bboxHeight, 0],
        realDistanceMeters: fallbackTarget,
        calibratedAt: new Date(),
      };
    }

    project.metersPerUnit = Number(metersPerUnit.toFixed(6));
    await project.save();

    res.status(200).json({
      success: true,
      data: {
        projectId: project._id,
        metersPerUnit: project.metersPerUnit,
        calibration: project.calibration,
      },
    });
  } catch (error) {
    next(error);
  }
};
