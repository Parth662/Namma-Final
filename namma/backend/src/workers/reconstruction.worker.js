import { Worker } from 'bullmq';
import { getRedisClient } from '../config/redis.js';
import {
  RECONSTRUCTION_QUEUE_NAME,
  updateWaitingJobsQueuePositions,
  recordCompletedJobDuration,
} from '../services/reconstruction.service.js';
import { connectDatabase } from '../config/database.js';
import { Project } from '../models/Project.js';
import { ReconstructionJob } from '../models/ReconstructionJob.js';
import {
  emitProjectProgress,
  emitJobStage,
  emitJobCompleted,
  emitJobFailed,
  emitQueuePosition,
} from '../sockets/progress.socket.js';
import { pythonService } from '../services/python.service.js';
import { env } from '../config/environment.js';

export const startReconstructionWorker = () => {
  const redis = getRedisClient();

  const worker = new Worker(
    RECONSTRUCTION_QUEUE_NAME,
    async (job) => {
      const { jobId, projectId, videoPath } = job.data;
      console.log(`[Worker] Started processing reconstruction job: ${jobId} for project: ${projectId}`);
      await updateWaitingJobsQueuePositions();

      const project = await Project.findById(projectId);
      const reconJob = await ReconstructionJob.findById(jobId);

      if (!project || !reconJob) {
        throw new Error(`Project or ReconstructionJob not found in database: ${projectId} / ${jobId}`);
      }

      const updateProgress = async (stage, progressNum, msg) => {
        project.status = 'processing';
        project.currentStage = stage;
        project.progress = progressNum;
        await project.save();

        reconJob.status = 'processing';
        reconJob.currentStage = stage;
        reconJob.progress = progressNum;
        if (!reconJob.startedAt) reconJob.startedAt = new Date();
        await reconJob.save();

        emitProjectProgress(projectId, {
          status: 'processing',
          stage,
          progress: progressNum,
          message: msg,
        });
      };

      // Step 2.7: Active job timeout controller
      const timeoutMs = env.JOB_TIMEOUT_MS || 600000;
      const abortController = new AbortController();
      let timedOut = false;

      const timeoutId = setTimeout(async () => {
        timedOut = true;
        abortController.abort();
        console.warn(`[Worker] Job ${jobId} timed out after ${timeoutMs}ms. Aborting engine request and subprocesses...`);
        try {
          await pythonService.cancelReconstruction({ jobId, projectId });
        } catch (e) {
          console.error('[Worker] Error sending cancellation during timeout:', e.message);
        }
      }, timeoutMs);

      try {
        // Section 19 stages
        await updateProgress('FRAME ANALYSIS', 15, 'Analyzing video and extracting quality frames');

        // Call Python service with absolute storage directory and webhook callback for stage updates
        const callbackUrl = `http://127.0.0.1:${env.PORT}/api/projects/internal/progress`;
        const response = await pythonService.requestReconstruction({
          jobId,
          projectId,
          videoPath,
          storageDir: env.STORAGE_DIR,
          processingDir: env.PROCESSING_DIR,
          callbackUrl,
          signal: abortController.signal,
        });

        if (timedOut) {
          throw new Error(`JOB_TIMEOUT: Reconstruction process exceeded time limit of ${timeoutMs / 1000}s`);
        }

        if (!response.success) {
          const isRejected = response.rejected || (response.error && (response.error.startsWith('REJECTED_') || response.error.startsWith('INSUFFICIENT_')));
          if (isRejected) {
            console.warn(`[Worker] Project ${projectId} rejected early: ${response.reason}`);
            project.status = 'rejected';
            project.currentStage = 'REJECTED';
            project.progress = 0;
            project.rejectionReason = response.reason;
            project.rejectionSuggestion = response.suggestion;
            await project.save();

            reconJob.status = 'rejected';
            reconJob.currentStage = 'REJECTED';
            reconJob.rejectionReason = response.reason;
            reconJob.rejectionSuggestion = response.suggestion;
            reconJob.completedAt = new Date();
            await reconJob.save();

            emitProjectProgress(projectId, {
              status: 'rejected',
              stage: 'REJECTED',
              progress: 0,
              reason: response.reason,
              suggestion: response.suggestion,
            });

            return { success: false, rejected: true, reason: response.reason };
          }

          const customErr = new Error(response.reason || response.error || 'Reconstruction failed in Python 3D engine');
          customErr.code = response.error || 'INSUFFICIENT_RECONSTRUCTION_QUALITY';
          customErr.suggestion = response.suggestion || 'Record the area again while moving slowly with steady overlapping camera angles.';
          throw customErr;
        }

        // Finalize completed model
        project.status = 'completed';
        project.progress = 100;
        project.currentStage = 'DIGITAL TWIN READY';
        project.modelUrl = response.modelUrl || `/storage/projects/${projectId}/final/scene.glb`;
        project.thumbnailUrl = response.thumbnailUrl || `/storage/projects/${projectId}/preview/thumbnail.jpg`;
        if (response.boundingBox) project.boundingBox = response.boundingBox;
        if (response.metadata) project.reconstructionMetadata = response.metadata;
        await project.save();

        reconJob.status = 'completed';
        reconJob.progress = 100;
        reconJob.currentStage = 'DIGITAL TWIN READY';
        reconJob.completedAt = new Date();
        reconJob.finalModelPath = response.finalModelPath;
        await reconJob.save();

        const durationSec = (reconJob.completedAt.getTime() - (reconJob.startedAt || new Date()).getTime()) / 1000;
        await recordCompletedJobDuration(durationSec);
        await updateWaitingJobsQueuePositions();

        emitJobCompleted(projectId, {
          modelUrl: project.modelUrl,
          thumbnailUrl: project.thumbnailUrl,
          boundingBox: project.boundingBox,
          metadata: project.reconstructionMetadata,
          message: 'Photorealistic 3D Digital Twin successfully generated!',
        });

        return { success: true };
      } catch (err) {
        console.error(`[Worker] Error processing job ${jobId}:`, err);

        const failureReason = err.message || 'Photogrammetry pipeline encountered an error';
        const suggestion = err.suggestion || 'Record the area again while moving slowly with steady overlapping camera angles.';

        project.status = 'failed';
        project.currentStage = 'FAILED';
        project.progress = 0;
        await project.save();

        reconJob.status = 'failed';
        reconJob.currentStage = 'FAILED';
        reconJob.error = {
          reason: failureReason,
          suggestion,
          rawError: err.toString(),
        };
        reconJob.completedAt = new Date();
        await reconJob.save();

        emitJobFailed(projectId, {
          reason: failureReason,
          suggestion,
          rejected: false,
        });

        throw err;
      } finally {
        clearTimeout(timeoutId);
      }
    },
    {
      connection: redis,
      concurrency: env.WORKER_CONCURRENCY || 1, // Photogrammetry is compute-intensive
      lockDuration: 120000, // 2 minutes lock duration for heavy photogrammetry stages
      lockRenewTime: 30000, // renew lock every 30s
      maxStalledCount: 1,
    }
  );

  worker.on('completed', (job) => {
    console.log(`[Worker] Job ${job.id} completed successfully`);
  });

  worker.on('failed', async (job, err) => {
    console.log(`[Worker] Job ${job?.id} failed on attempt ${job?.attemptsMade}/${job?.opts?.attempts}:`, err?.message);
    if (job && job.attemptsMade >= (job.opts?.attempts || 2)) {
      console.warn(`[Worker] Job ${job.id} exhausted all ${job.opts?.attempts} retry attempts.`);
      const { projectId } = job.data || {};
      if (projectId) {
        await Project.findByIdAndUpdate(projectId, { status: 'failed', currentStage: 'FAILED' });
        await ReconstructionJob.findOneAndUpdate({ projectId }, { status: 'failed', currentStage: 'FAILED' });
        emitJobFailed(projectId, {
          reason: `Job failed after ${job.attemptsMade} attempts: ${err?.message}`,
          suggestion: 'Check video clarity and try again.',
          rejected: false,
        });
      }
    }
  });

  return worker;
};

export const recoverOrphanedJobs = async () => {
  try {
    const orphanedProjects = await Project.find({ status: 'processing' });
    if (orphanedProjects.length > 0) {
      console.warn(`[Recovery] Found ${orphanedProjects.length} orphaned processing project(s). Resetting to failed...`);
      for (const proj of orphanedProjects) {
        proj.status = 'failed';
        proj.currentStage = 'FAILED';
        proj.progress = 0;
        await proj.save();

        await ReconstructionJob.updateMany(
          { projectId: proj._id, status: 'processing' },
          {
            status: 'failed',
            currentStage: 'FAILED',
            error: {
              reason: 'Reconstruction interrupted due to server/worker restart.',
              suggestion: 'Please restart the 3D reconstruction.',
            },
            completedAt: new Date(),
          }
        );
      }
    }
  } catch (err) {
    console.error('[Recovery] Error during orphaned job recovery:', err.message);
  }
};

// Standalone execution support: npm run worker
if (process.argv[1] && process.argv[1].endsWith('reconstruction.worker.js')) {
  (async () => {
    await connectDatabase();
    console.log(`[Worker] Dedicated reconstruction worker process started (concurrency: ${env.WORKER_CONCURRENCY || 1})`);
    await recoverOrphanedJobs();
    const worker = startReconstructionWorker();

    const gracefulWorkerShutdown = async (sig) => {
      console.log(`\n[Worker] Received ${sig}. Closing worker cleanly...`);
      await worker.close();
      process.exit(0);
    };

    process.on('SIGINT', () => gracefulWorkerShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulWorkerShutdown('SIGTERM'));
  })();
}
