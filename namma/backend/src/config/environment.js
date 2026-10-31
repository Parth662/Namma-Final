import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../../');

// Always load from backend root directory .env
dotenv.config({ path: path.resolve(rootDir, '.env') });

export const env = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  HOST: process.env.HOST || '0.0.0.0',
  PORT: parseInt(process.env.PORT, 10) || 5001,
  MONGODB_URI: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/digital_twin_db',
  JWT_SECRET: process.env.JWT_SECRET || 'super_secret_digital_twin_jwt_token_key_987654321',
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '7d',
  REDIS_URL: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  RECON_ENGINE_URL: process.env.RECON_ENGINE_URL || process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:5002',
  PYTHON_SERVICE_URL: process.env.RECON_ENGINE_URL || process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:5002',
  UPLOAD_DIR: path.resolve(rootDir, process.env.UPLOAD_DIR || './uploads'),
  PROCESSING_DIR: path.resolve(rootDir, process.env.PROCESSING_DIR || './processing'),
  STORAGE_DIR: path.resolve(rootDir, process.env.STORAGE_DIR || './storage'),
  OUTPUT_DIR: path.resolve(rootDir, process.env.OUTPUT_DIR || './outputs'),
  MAX_VIDEO_SIZE_MB: parseInt(process.env.MAX_VIDEO_MB || process.env.MAX_VIDEO_SIZE_MB, 10) || 500,
  MAX_VIDEO_MB: parseInt(process.env.MAX_VIDEO_MB || process.env.MAX_VIDEO_SIZE_MB, 10) || 500,
  MAX_VIDEO_SECONDS: parseInt(process.env.MAX_VIDEO_SECONDS, 10) || 180,
  MAX_IMAGE_SIZE: parseInt(process.env.MAX_IMAGE_SIZE, 10) || 1280,
  MAX_FRAMES: parseInt(process.env.MAX_FRAMES, 10) || 60,
  FRAME_FPS: parseFloat(process.env.FRAME_FPS) || 2,
  MIN_KEYPOINTS: parseInt(process.env.MIN_KEYPOINTS, 10) || 100,
  MIN_MOTION_SCORE: parseFloat(process.env.MIN_MOTION_SCORE) || 0.05,
  USER_CONCURRENT_QUEUE_LIMIT: parseInt(process.env.USER_CONCURRENT_QUEUE_LIMIT, 10) || 2,
  WORKER_CONCURRENCY: parseInt(process.env.WORKER_CONCURRENCY, 10) || 1,
  JOB_TIMEOUT_MS: parseInt(process.env.JOB_TIMEOUT_MS, 10) || 600000,
  FRAME_INTERVAL: parseInt(process.env.FRAME_INTERVAL, 10) || 5,
  FFMPEG_PATH: process.env.FFMPEG_PATH || 'ffmpeg',
  FFPROBE_PATH: process.env.FFPROBE_PATH || 'ffprobe',
  COLMAP_PATH: process.env.COLMAP_PATH || (process.platform === 'win32' ? path.resolve(rootDir, 'tools/colmap/COLMAP.bat') : '/opt/homebrew/bin/colmap'),
  rootDir,
};
