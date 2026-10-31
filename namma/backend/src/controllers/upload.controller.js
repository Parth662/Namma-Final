import fs from 'fs';
import path from 'path';
import { storageService } from '../services/storage.service.js';
import { VideoValidationService } from '../services/videoValidation.service.js';

export const handleVideoUpload = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No video file uploaded. Please provide a valid MP4, MOV, or WebM video.',
      });
    }

    // Step 2.2: Validate video format, codec, resolution, and duration using ffprobe
    const validation = await VideoValidationService.validateVideo(req.file.path);
    if (!validation.valid) {
      if (fs.existsSync(req.file.path)) {
        try { fs.unlinkSync(req.file.path); } catch (e) {}
      }
      return res.status(400).json({
        success: false,
        error: validation.reason,
      });
    }

    const project = req.project;
    const paths = storageService.ensureProjectDirectories(project._id);

    // Ensure the video file is also mirrored in storage/projects/<projectId>/source/video.mp4
    const storageSourceVideo = path.join(paths.sourceDir, 'video.mp4');
    fs.copyFileSync(req.file.path, storageSourceVideo);

    const videoRelativeUrl = `/uploads/${project._id}/source/video.mp4`;

    project.videoUrl = videoRelativeUrl;
    project.status = 'uploaded';
    project.currentStage = 'UPLOADED';
    project.progress = 10; // Section 19: UPLOAD 0-10%
    if (validation.duration) {
      project.videoDurationSeconds = validation.duration;
      project.videoResolution = `${validation.width}x${validation.height}`;
      project.videoCodec = validation.codec;
    }
    await project.save();

    res.status(200).json({
      success: true,
      message: 'Video uploaded and verified successfully',
      data: {
        projectId: project._id,
        status: project.status,
        videoUrl: project.videoUrl,
        filename: req.file.filename,
        originalName: req.file.originalname,
        size: req.file.size,
        mimeType: req.file.mimetype,
        storagePath: req.file.path,
        videoMeta: {
          codec: validation.codec,
          width: validation.width,
          height: validation.height,
          duration: validation.duration,
        },
      },
    });
  } catch (error) {
    next(error);
  }
};
