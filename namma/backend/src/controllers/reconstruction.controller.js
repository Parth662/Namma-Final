import fs from 'fs';
import path from 'path';
import { env } from '../config/environment.js';
import { Project } from '../models/Project.js';
import { ReconstructionJob } from '../models/ReconstructionJob.js';
import {
  addReconstructionJobToQueue,
  getReconstructionQueue,
  updateWaitingJobsQueuePositions,
} from '../services/reconstruction.service.js';
import { pythonService } from '../services/python.service.js';
import { storageService } from '../services/storage.service.js';
import { emitProjectProgress, emitJobStage, emitQueuePosition } from '../sockets/progress.socket.js';

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

    // Step 2.10: Per-user queued-job limit (default 2)
    const activeJobsCount = await ReconstructionJob.countDocuments({
      userId: req.user._id,
      status: { $in: ['queued', 'processing'] },
    });
    const maxConcurrent = env.USER_CONCURRENT_QUEUE_LIMIT || 2;
    if (activeJobsCount >= maxConcurrent) {
      return res.status(429).json({
        success: false,
        error: `Queue limit reached: You currently have ${activeJobsCount} active/queued job(s). Maximum allowed per user is ${maxConcurrent}.`,
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
    const { job: queuedJob, queueInfo } = await addReconstructionJobToQueue({
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
      queuePosition: queueInfo.position,
      etaSeconds: queueInfo.etaSeconds,
    });

    // 6. Return immediately as required by Section 7
    return res.status(200).json({
      success: true,
      jobId: job._id,
      projectId: project._id,
      status: 'queued',
      queuePosition: queueInfo.position,
      totalQueued: queueInfo.total,
      etaSeconds: queueInfo.etaSeconds,
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

    if ((project.status === 'failed' || project.status === 'rejected') && latestJob?.error) {
      return res.status(200).json({
        projectId: project._id,
        status: project.status,
        title: latestJob.error.title,
        code: latestJob.error.code,
        reason: latestJob.error.reason || 'Reconstruction process failed',
        suggestion:
          latestJob.error.suggestion || 'Please try recording the location again with slow, overlapping camera movements.',
        logPath: latestJob.error.logPath,
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

export const handleInternalProgress = async (req, res, next) => {
  try {
    const { projectId, jobId, stage, progress, message } = req.body;
    if (!projectId) {
      return res.status(400).json({ success: false, error: 'projectId is required' });
    }

    const stageNormalized = (stage || 'processing').toLowerCase();
    const update = { currentStage: stageNormalized, progress: Number(progress) || 0 };

    if (stageNormalized === 'completed') update.status = 'completed';
    else if (stageNormalized === 'rejected') update.status = 'rejected';
    else if (stageNormalized === 'failed') update.status = 'failed';
    else update.status = 'processing';

    await Project.findByIdAndUpdate(projectId, update);
    if (jobId) {
      await ReconstructionJob.findByIdAndUpdate(jobId, update);
    }

    emitJobStage(projectId, { stage: stageNormalized, progress: update.progress, message: message || '' });
    return res.status(200).json({ success: true });
  } catch (err) {
    next(err);
  }
};

export const cancelReconstruction = async (req, res, next) => {
  try {
    const { id } = req.params;

    const project = await Project.findOne({ _id: id, userId: req.user._id });
    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found or you do not have permission to access it',
      });
    }

    if (project.status !== 'queued' && project.status !== 'processing') {
      return res.status(400).json({
        success: false,
        error: `Project cannot be cancelled because its current status is '${project.status}'. Only queued or processing projects can be cancelled.`,
      });
    }

    const latestJob = await ReconstructionJob.findOne({
      projectId: id,
      status: { $in: ['queued', 'processing'] },
    }).sort({ createdAt: -1 });

    const queue = getReconstructionQueue();

    if (project.status === 'queued') {
      if (latestJob) {
        try {
          const queuedJob = await queue.getJob(latestJob._id.toString());
          if (queuedJob) await queuedJob.remove();
        } catch (e) {
          console.warn('[Queue] Could not remove queued BullMQ job:', e.message);
        }
      }
    } else if (project.status === 'processing') {
      if (latestJob) {
        try {
          await pythonService.cancelReconstruction({
            jobId: latestJob._id.toString(),
            projectId: id.toString(),
          });
        } catch (e) {
          console.warn('[Queue] Could not notify engine of cancellation:', e.message);
        }
      }
    }

    project.status = 'cancelled';
    project.currentStage = 'CANCELLED';
    await project.save();

    if (latestJob) {
      latestJob.status = 'cancelled';
      latestJob.currentStage = 'CANCELLED';
      latestJob.completedAt = new Date();
      await latestJob.save();
    }

    emitProjectProgress(id, {
      status: 'cancelled',
      stage: 'CANCELLED',
      message: 'Reconstruction cancelled by user.',
    });

    await updateWaitingJobsQueuePositions();

    return res.status(200).json({
      success: true,
      message: 'Reconstruction successfully cancelled.',
      status: 'cancelled',
      projectId: project._id,
    });
  } catch (err) {
    next(err);
  }
};

export const getCaptureCoach = async (req, res, next) => {
  try {
    const { id } = req.params;
    const project = await Project.findOne({ _id: id, userId: req.user._id });
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    const paths = storageService.ensureProjectDirectories(project._id);
    const uploadedVideo = path.join(paths.uploadsProjectDir, 'video.mp4');
    const storageVideo = path.join(paths.sourceDir, 'video.mp4');

    const videoPath = fs.existsSync(uploadedVideo)
      ? uploadedVideo
      : (fs.existsSync(storageVideo) ? storageVideo : null);

    if (!videoPath) {
      return res.status(400).json({
        success: false,
        error: 'No uploaded video found for this project.',
        hopeless: true,
      });
    }

    const coachResult = await pythonService.analyzeCaptureCoach(videoPath);
    return res.status(200).json(coachResult);
  } catch (err) {
    next(err);
  }
};
