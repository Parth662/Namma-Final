import fs from 'fs';
import path from 'path';
import { Project } from '../models/Project.js';
import { ReconstructionJob } from '../models/ReconstructionJob.js';
import { addReconstructionJobToQueue } from '../services/reconstruction.service.js';
import { storageService } from '../services/storage.service.js';
import { emitProjectProgress } from '../sockets/progress.socket.js';

export const startReconstruction = async (req, res, next) => {
  try {
    const { id } = req.params;

    // 1. Verify project & ownership
    const project = await Project.findOne({ _id: id, userId: req.user._id });
    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found or you do not have permission to access it',
      });
    }

    // 2. Verify video exists
    const paths = storageService.ensureProjectDirectories(project._id);
    const uploadedVideo = path.join(paths.uploadsProjectDir, 'video.mp4');
    const storageVideo = path.join(paths.sourceDir, 'video.mp4');

    let videoPathToUse = null;
    if (fs.existsSync(uploadedVideo)) {
      videoPathToUse = uploadedVideo;
    } else if (fs.existsSync(storageVideo)) {
      videoPathToUse = storageVideo;
    }

    if (!videoPathToUse) {
      return res.status(400).json({
        success: false,
        error: 'No video found for this project. Please upload a video first.',
      });
    }

    // Check if a job is already in progress
    if (project.status === 'processing' || project.status === 'queued') {
      return res.status(409).json({
        success: false,
        error: `Reconstruction is already ${project.status} for this project`,
      });
    }

    // 3. Create reconstruction job
    const job = await ReconstructionJob.create({
      projectId: project._id,
      userId: req.user._id,
      status: 'queued',
      progress: 10,
      currentStage: 'QUEUED',
      videoPath: videoPathToUse,
    });

    // 4. Update project status to queued
    project.status = 'queued';
    project.progress = 10;
    project.currentStage = 'QUEUED';
    await project.save();

    // 5. Add job to BullMQ
    await addReconstructionJobToQueue({
      jobId: job._id,
      projectId: project._id,
      userId: req.user._id,
      videoPath: videoPathToUse,
    });

    // Notify connected clients via Socket.IO
    emitProjectProgress(project._id, {
      status: 'queued',
      progress: 10,
      currentStage: 'QUEUED',
      message: 'Job enqueued for 3D reconstruction',
    });

    // 6. Return immediately as required by Section 7
    return res.status(200).json({
      success: true,
      jobId: job._id,
      projectId: project._id,
      status: 'queued',
    });
  } catch (error) {
    next(error);
  }
};

export const getReconstructionStatus = async (req, res, next) => {
  try {
    const { id } = req.params;

    const project = await Project.findOne({ _id: id, userId: req.user._id });
    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found',
      });
    }

    const latestJob = await ReconstructionJob.findOne({ projectId: id }).sort({ createdAt: -1 });

    if (project.status === 'failed' && latestJob?.error) {
      return res.status(200).json({
        projectId: project._id,
        status: 'failed',
        reason: latestJob.error.reason || 'Reconstruction process failed',
        suggestion:
          latestJob.error.suggestion || 'Please try recording the location again with slow, overlapping camera movements.',
        error: latestJob.error,
        updatedAt: project.updatedAt,
      });
    }

    return res.status(200).json({
      projectId: project._id,
      status: project.status,
      progress: project.progress,
      currentStage: project.currentStage,
      modelUrl: project.modelUrl,
      thumbnailUrl: project.thumbnailUrl,
      job: latestJob
        ? {
            id: latestJob._id,
            status: latestJob.status,
            progress: latestJob.progress,
            currentStage: latestJob.currentStage,
            frameCount: latestJob.frameCount,
            startedAt: latestJob.startedAt,
            completedAt: latestJob.completedAt,
          }
        : null,
      updatedAt: project.updatedAt,
    });
  } catch (error) {
    next(error);
  }
};
