import express from 'express';
import {
  createProject,
  getProjects,
  getProjectById,
  deleteProject,
  getProjectMetadata,
  getProjectModel,
  calibrateProject,
  updateProjectGeo,
  getProjectFloorplan,
  getProjectMetrics,
} from '../controllers/project.controller.js';
import { handleVideoUpload } from '../controllers/upload.controller.js';
import {
  startReconstruction,
  getReconstructionStatus,
  cancelReconstruction,
  handleInternalProgress,
  getCaptureCoach,
} from '../controllers/reconstruction.controller.js';
import { authenticate, optionalAuthenticate } from '../middleware/auth.middleware.js';
import { uploadVideoMiddleware, validateProjectForUpload } from '../middleware/upload.middleware.js';
import { getProjectNavGrid, getProjectPath } from '../controllers/navigation.controller.js';
import poiRoutes from './poi.routes.js';

const router = express.Router();

// Project CRUD
router.post('/', authenticate, createProject);
router.get('/', authenticate, getProjects);
router.get('/:id', authenticate, getProjectById);
router.delete('/:id', authenticate, deleteProject);

// Video Upload (Section 6)
router.post(
  '/:id/upload',
  authenticate,
  validateProjectForUpload,
  uploadVideoMiddleware.single('video'),
  handleVideoUpload
);

// Reconstruction Trigger, Status & Cancel (Section 7, 20)
router.post('/internal/progress', handleInternalProgress);
router.post('/:id/coach', authenticate, getCaptureCoach);
router.post('/:id/reconstruct', authenticate, startReconstruction);
router.post('/:id/cancel', authenticate, cancelReconstruction);
router.get('/:id/status', authenticate, getReconstructionStatus);

// Digital Twin Model & Metadata for 3D View (Section 18, 21)
router.get('/:id/metadata', authenticate, getProjectMetadata);
router.get('/:id/model', authenticate, getProjectModel);
router.post('/:id/calibrate', authenticate, calibrateProject);
router.patch('/:id/geo', authenticate, updateProjectGeo);
router.get('/:id/floorplan', optionalAuthenticate, getProjectFloorplan);
router.get('/:id/metrics', optionalAuthenticate, getProjectMetrics);

// Navigation & Pathfinding (Phase 4)
router.get('/:id/navgrid', optionalAuthenticate, getProjectNavGrid);
router.get('/:id/path', optionalAuthenticate, getProjectPath);

// Points of Interest (Phase 5)
router.use('/:id/pois', poiRoutes);

export default router;
