import { Queue } from 'bullmq';
import { env } from '../config/environment.js';
import { getRedisClient } from '../config/redis.js';
import { emitQueuePosition } from '../sockets/progress.socket.js';
import { Project } from '../models/Project.js';
import { ReconstructionJob } from '../models/ReconstructionJob.js';

export const RECONSTRUCTION_QUEUE_NAME = '3d-reconstruction-queue';
const REDIS_ROLLING_AVG_KEY = 'recon:rolling_avg_duration_sec';
const REDIS_DURATIONS_LIST_KEY = 'recon:recent_durations';
const DEFAULT_AVG_DURATION_SEC = 60;

let reconstructionQueue = null;

export const getReconstructionQueue = () => {
  if (!reconstructionQueue) {
    const redis = getRedisClient();
    reconstructionQueue = new Queue(RECONSTRUCTION_QUEUE_NAME, {
      connection: redis,
      defaultJobOptions: {
        attempts: 2, // Step 2.8: 2 attempts with exponential backoff for transient errors
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: {
          age: 3600 * 24, // Keep for 24h
          count: 100,
        },
        removeOnFail: {
          age: 3600 * 48,
          count: 100,
        },
      },
    });
  }
  return reconstructionQueue;
};

/**
 * Step 2.6: Rolling average reconstruction duration calculation
 */
export const getRollingAverageDuration = async () => {
  try {
    const redis = getRedisClient();
    const cached = await redis.get(REDIS_ROLLING_AVG_KEY);
    if (cached) {
      const val = parseFloat(cached);
      if (!isNaN(val) && val > 5) return val;
    }

    // Fallback to recent completed jobs from MongoDB
    const recent = await ReconstructionJob.find({ status: 'completed', startedAt: { $ne: null }, completedAt: { $ne: null } })
      .sort({ completedAt: -1 })
      .limit(10)
      .lean();

    if (recent.length > 0) {
      const durations = recent
        .map((j) => (new Date(j.completedAt).getTime() - new Date(j.startedAt).getTime()) / 1000)
        .filter((d) => d > 0);
      if (durations.length > 0) {
        const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
        await redis.set(REDIS_ROLLING_AVG_KEY, Math.round(avg).toString());
        return avg;
      }
    }
  } catch (err) {
    console.warn('[Queue] Could not read rolling average from Redis:', err.message);
  }
  return DEFAULT_AVG_DURATION_SEC;
};

export const recordCompletedJobDuration = async (durationSec) => {
  if (!durationSec || durationSec <= 0) return;
  try {
    const redis = getRedisClient();
    await redis.lpush(REDIS_DURATIONS_LIST_KEY, Math.round(durationSec));
    await redis.ltrim(REDIS_DURATIONS_LIST_KEY, 0, 9); // Keep last 10 entries

    const items = await redis.lrange(REDIS_DURATIONS_LIST_KEY, 0, 9);
    if (items.length > 0) {
      const sum = items.reduce((acc, str) => acc + parseFloat(str), 0);
      const avg = Math.round(sum / items.length);
      await redis.set(REDIS_ROLLING_AVG_KEY, avg.toString());
      console.log(`[Queue] Updated rolling average reconstruction duration: ${avg}s (from ${items.length} runs)`);
    }
  } catch (err) {
    console.warn('[Queue] Failed to record completed duration:', err.message);
  }
};

/**
 * Step 2.5: Calculate 1-based queue position and rolling ETA
 */
export const calculateQueuePositionAndEta = async (jobId) => {
  try {
    const queue = getReconstructionQueue();
    const waitingJobs = await queue.getWaiting();
    const rollingAvgSec = await getRollingAverageDuration();

    const idx = waitingJobs.findIndex((j) => j.id === jobId || j.data?.jobId === jobId);
    const total = waitingJobs.length;

    if (idx === -1) {
      return { position: 1, total: Math.max(1, total), etaSeconds: Math.round(rollingAvgSec) };
    }

    const position = idx + 1;
    const etaSeconds = Math.round(position * rollingAvgSec);

    return { position, total, etaSeconds };
  } catch (err) {
    console.warn('[Queue] Error calculating queue position:', err.message);
    return { position: 1, total: 1, etaSeconds: DEFAULT_AVG_DURATION_SEC };
  }
};

/**
 * Notify all waiting jobs in queue of their current position and updated ETA
 */
export const updateWaitingJobsQueuePositions = async () => {
  try {
    const queue = getReconstructionQueue();
    const waitingJobs = await queue.getWaiting();
    const rollingAvgSec = await getRollingAverageDuration();
    const total = waitingJobs.length;

    for (let i = 0; i < waitingJobs.length; i++) {
      const job = waitingJobs[i];
      const position = i + 1;
      const etaSeconds = Math.round(position * rollingAvgSec);
      const projectId = job.data?.projectId;

      if (projectId) {
        emitQueuePosition(projectId, { position, total, etaSeconds });
      }
    }
  } catch (err) {
    console.warn('[Queue] Error updating waiting jobs queue positions:', err.message);
  }
};

export const addReconstructionJobToQueue = async ({ jobId, projectId, userId, videoPath }) => {
  const queue = getReconstructionQueue();
  const job = await queue.add(
    'reconstruct_location',
    {
      jobId: jobId.toString(),
      projectId: projectId.toString(),
      userId: userId.toString(),
      videoPath,
    },
    {
      jobId: jobId.toString(),
    }
  );

  // Trigger position and ETA broadcast
  const queueInfo = await calculateQueuePositionAndEta(job.id);
  emitQueuePosition(projectId, queueInfo);

  return { job, queueInfo };
};
