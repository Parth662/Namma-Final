import express from 'express';
import { handleVideoUpload } from '../controllers/upload.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';
import { uploadVideoMiddleware, validateProjectForUpload } from '../middleware/upload.middleware.js';

const router = express.Router({ mergeParams: true });

// Route can be used as POST /api/projects/:id/upload
router.post(
  '/:id/upload',
  authenticate,
  validateProjectForUpload,
  uploadVideoMiddleware.single('video'),
  handleVideoUpload
);

export default router;
