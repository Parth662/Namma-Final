import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import path from 'path';
import mongoose from 'mongoose';
import { env } from './config/environment.js';
import { corsOptions } from './config/cors.js';
import { getRedisClient } from './config/redis.js';
import { pythonService } from './services/python.service.js';
import authRoutes from './routes/auth.routes.js';
import projectRoutes from './routes/project.routes.js';
import { getDemoProject } from './controllers/demo.controller.js';
import { errorHandler, notFoundHandler } from './middleware/error.middleware.js';

export const createApp = () => {
  const app = express();

  // Basic Security & Logging Middleware
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    })
  );
  app.use(cors(corsOptions));
  app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev'));

  app.use(express.json({ limit: '20mb' }));
  app.use(express.urlencoded({ extended: true, limit: '20mb' }));

  // Static files serving for uploaded videos, thumbnails, 3D GLB models
  app.use('/uploads', express.static(env.UPLOAD_DIR));
  app.use('/storage', express.static(env.STORAGE_DIR));
  app.use('/storage', express.static(path.resolve(env.rootDir, 'python-service/storage')));
  app.use('/outputs', express.static(env.OUTPUT_DIR));

  // Health Check Endpoint (Section 26)
  app.get('/api/health', async (req, res) => {
    let mongoStatus = 'disconnected';
    if (mongoose.connection.readyState === 1) mongoStatus = 'connected';
    else if (mongoose.connection.readyState === 2) mongoStatus = 'connecting';

    let redisStatus = 'disconnected';
    try {
      const redis = getRedisClient();
      const ping = await redis.ping();
      if (ping === 'PONG') redisStatus = 'connected';
    } catch (e) {
      redisStatus = `error: ${e.message}`;
    }

    const pythonHealth = await pythonService.checkHealth();

    res.status(200).json({
      status: 'ok',
      service: '3d-location-reconstruction-backend',
      timestamp: new Date().toISOString(),
      engineMode: pythonHealth.mode || 'CPU',
      dependencies: {
        mongodb: mongoStatus,
        redis: redisStatus,
        pythonService: pythonHealth.online ? 'connected' : 'offline',
        pythonMode: pythonHealth.mode || 'CPU',
      },
    });
  });

  // API Routes
  app.get('/api/demo', getDemoProject);
  app.use('/api/auth', authRoutes);
  app.use('/api/projects', projectRoutes);

  // Error Handling
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};
