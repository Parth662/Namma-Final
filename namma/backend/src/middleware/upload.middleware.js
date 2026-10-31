import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { env } from '../config/environment.js';
import { storageService } from '../services/storage.service.js';
import { Project } from '../models/Project.js';

const ALLOWED_EXTENSIONS = new Set(['.mp4', '.mov', '.webm']);
const ALLOWED_MIME_TYPES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-matroska',
  'application/octet-stream',
]);

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      const { id } = req.params;
      const paths = storageService.ensureProjectDirectories(id);
      cb(null, paths.uploadsProjectDir);
    } catch (err) {
      cb(err);
    }
  },
  filename: (req, file, cb) => {
    // Requirements: uploads/<projectId>/source/video.mp4
    // If video.mp4 already exists, preserve old one or use unique filename
    const ext = path.extname(file.originalname).toLowerCase();
    const targetFile = path.join(req.uploadDir || '', 'video.mp4');

    if (fs.existsSync(targetFile)) {
      // Backup previous video to avoid overwriting user original
      const backupName = `video_backup_${Date.now()}${ext}`;
      try {
        fs.renameSync(targetFile, path.join(path.dirname(targetFile), backupName));
      } catch (e) {
        // Continue
      }
    }

    cb(null, 'video.mp4');
  },
});

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  const mime = (file.mimetype || '').toLowerCase();

  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return cb(
      new Error(`Unsupported file extension (${ext}). Only MP4, MOV, and WebM videos are accepted.`),
      false
    );
  }

  const isVideoMime = ALLOWED_MIME_TYPES.has(mime) || mime.startsWith('video/') || mime === 'application/octet-stream';
  if (!isVideoMime) {
    console.warn(`[UploadMiddleware] Note: file '${file.originalname}' reported MIME type '${mime}'. Accepting based on valid extension '${ext}'.`);
  }

  cb(null, true);
};

export const uploadVideoMiddleware = multer({
  storage,
  limits: {
    fileSize: env.MAX_VIDEO_SIZE_MB * 1024 * 1024,
  },
  fileFilter,
});

export const validateProjectForUpload = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!id.match(/^[0-9a-fA-F]{24}$/)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid project ID format',
      });
    }

    const project = await Project.findById(id);
    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found',
      });
    }

    // Check ownership
    if (project.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden: You do not have permission to upload to this project',
      });
    }

    req.project = project;
    const paths = storageService.ensureProjectDirectories(id);
    req.uploadDir = paths.uploadsProjectDir;
    next();
  } catch (err) {
    next(err);
  }
};
