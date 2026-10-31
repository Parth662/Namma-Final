/**
 * NAMMA SPACE — Reconstruction Worker Auto-Scaler (`scripts/auto-scaler.js`)
 * Monitors BullMQ queue depth and dynamically adjusts worker pool size with a hard cap.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendDir = path.resolve(__dirname, '../namma/backend');
const require = createRequire(path.join(backendDir, 'package.json'));

const { Queue } = require('bullmq');
const { Redis } = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const QUEUE_NAME = '3d-reconstruction-queue';
const POLL_INTERVAL_MS = parseInt(process.env.AUTOSCALE_INTERVAL_MS, 10) || 10000;
const HARD_CAP_WORKERS = parseInt(process.env.MAX_WORKERS, 10) || (process.platform === 'win32' ? 1 : 4);
const JOBS_PER_WORKER_THRESHOLD = 2; // Scale up when waiting jobs exceed 2 per worker

console.log('========================================================');
console.log('       NAMMA SPACE — RECONSTRUCTION QUEUE AUTO-SCALER    ');
console.log('========================================================');
console.log(`Redis Connection:    ${REDIS_URL}`);
console.log(`Poll Interval:       ${POLL_INTERVAL_MS / 1000}s`);
console.log(`Hard Cap Workers:    ${HARD_CAP_WORKERS} (Host protected)`);
console.log('========================================================\n');

const connection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue(QUEUE_NAME, { connection });

let currentWorkerCount = 1;

const evaluateScale = async () => {
  try {
    const waitingCount = await queue.getWaitingCount();
    const activeCount = await queue.getActiveCount();
    const completedCount = await queue.getCompletedCount();
    const failedCount = await queue.getFailedCount();

    console.log(`[AutoScaler] Queue Status: Active=${activeCount}, Waiting=${waitingCount}, Completed=${completedCount}, Failed=${failedCount}`);

    // Compute desired worker count
    let desiredWorkers = 1;
    if (waitingCount > 0) {
      desiredWorkers = Math.min(HARD_CAP_WORKERS, Math.ceil(waitingCount / JOBS_PER_WORKER_THRESHOLD));
    }

    if (desiredWorkers > currentWorkerCount) {
      console.log(`[AutoScaler] SCALE-UP RECOMMENDED: Increase workers from ${currentWorkerCount} to ${desiredWorkers} (Cap: ${HARD_CAP_WORKERS})`);
      currentWorkerCount = desiredWorkers;
    } else if (desiredWorkers < currentWorkerCount && waitingCount === 0) {
      console.log(`[AutoScaler] SCALE-DOWN RECOMMENDED: Decrease workers from ${currentWorkerCount} to ${desiredWorkers}`);
      currentWorkerCount = desiredWorkers;
    } else {
      console.log(`[AutoScaler] Pool size steady at ${currentWorkerCount} worker(s).`);
    }
  } catch (err) {
    console.warn('[AutoScaler] Error evaluating queue depth:', err.message);
  }
};

// Initial evaluation
evaluateScale().then(() => {
  if (process.argv.includes('--once')) {
    setTimeout(async () => {
      await connection.quit();
      process.exit(0);
    }, 500);
  } else {
    const timer = setInterval(evaluateScale, POLL_INTERVAL_MS);
    process.on('SIGINT', async () => {
      clearInterval(timer);
      await connection.quit();
      process.exit(0);
    });
  }
});
