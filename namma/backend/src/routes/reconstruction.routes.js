import express from 'express';
import {
  startReconstruction,
  getReconstructionStatus,
} from '../controllers/reconstruction.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';

const router = express.Router({ mergeParams: true });

// POST /api/projects/:id/reconstruct
router.post('/:id/reconstruct', authenticate, startReconstruction);

// GET /api/projects/:id/status
router.get('/:id/status', authenticate, getReconstructionStatus);

export default router;
