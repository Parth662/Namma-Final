import { Queue } from 'bullmq';
import { env } from '../config/environment.js';
import { getRedisClient } from '../config/redis.js';

export const RECONSTRUCTION_QUEUE_NAME = '3d-reconstruction-queue';

let reconstructionQueue = null;

export const getReconstructionQueue = () => {
  if (!reconstructionQueue) {
    const redis = getRedisClient();
    reconstructionQueue = new Queue(RECONSTRUCTION_QUEUE_NAME, {
      connection: redis,
      defaultJobOptions: {
        attempts: 1, // Photogrammetry is heavy; fail cleanly with diagnostic reasons
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
  return job;
};
