import express from 'express';
import {
  createProject,
  getProjects,
  getProjectById,
  deleteProject,
  getProjectMetadata,
  getProjectModel,
} from '../controllers/project.controller.js';
import { handleVideoUpload } from '../controllers/upload.controller.js';
import {
  startReconstruction,
  getReconstructionStatus,
} from '../controllers/reconstruction.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';
import { uploadVideoMiddleware, validateProjectForUpload } from '../middleware/upload.middleware.js';

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

// Reconstruction Trigger & Status (Section 7, 20)
router.post('/:id/reconstruct', authenticate, startReconstruction);
router.get('/:id/status', authenticate, getReconstructionStatus);

// Digital Twin Model & Metadata for 3D View (Section 18, 21)
router.get('/:id/metadata', authenticate, getProjectMetadata);
router.get('/:id/model', authenticate, getProjectModel);

export default router;
