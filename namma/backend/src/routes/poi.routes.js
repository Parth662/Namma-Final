import express from 'express';
import {
  getPOIs,
  getPOIById,
  createPOI,
  updatePOI,
  deletePOI,
} from '../controllers/poi.controller.js';
import { authenticate, optionalAuthenticate } from '../middleware/auth.middleware.js';

const router = express.Router({ mergeParams: true });

// Mounted at /api/projects/:id/pois
router.get('/', optionalAuthenticate, getPOIs);
router.get('/:poiId', optionalAuthenticate, getPOIById);
router.post('/', authenticate, createPOI);
router.put('/:poiId', authenticate, updatePOI);
router.delete('/:poiId', authenticate, deletePOI);

export default router;

