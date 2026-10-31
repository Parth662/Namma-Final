// Digital Twin 3D Server (v1.0.1)
import http from 'http';
import { createApp } from './app.js';
import { env } from './config/environment.js';
import { connectDatabase, disconnectDatabase } from './config/database.js';
import { closeRedisConnection } from './config/redis.js';
import { initSocketServer } from './sockets/progress.socket.js';
import { storageService } from './services/storage.service.js';
import { startReconstructionWorker, recoverOrphanedJobs } from './workers/reconstruction.worker.js';

const startServer = async () => {
  try {
    // 1. Ensure storage directories exist
    storageService.initDirectories();

    // 2. Connect to MongoDB and recover any orphaned jobs from unexpected restarts
    await connectDatabase();
    await recoverOrphanedJobs();

    // 3. Optional inline worker (controlled via RUN_WORKER_IN_SERVER, default false in dedicated mode)
    if (process.env.RUN_WORKER_IN_SERVER === 'true') {
      console.log(' Starting Reconstruction Worker inline with API server...');
      startReconstructionWorker();
    } else {
      console.log(' Dedicated Worker mode enabled. Launch standalone worker with: npm run worker');
    }

    // 4. Create Express app
    const app = createApp();

    // 5. Create HTTP server and attach Socket.IO
    const server = http.createServer(app);
    initSocketServer(server);

    // 6. Start listening with automatic fallback for busy ports (e.g. macOS AirPlay)
    let currentPort = env.PORT;

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.warn(`[Server] Port ${currentPort} is in use (often macOS AirPlay on port 5000). Retrying on port ${currentPort + 1}...`);
        currentPort += 1;
        setTimeout(() => {
          server.listen(currentPort, env.HOST);
        }, 200);
      } else {
        console.error('Server error:', err);
      }
    });

    server.listen(currentPort, env.HOST, () => {
      console.log('====================================================');
      console.log(' 3D Location Reconstruction & Digital Twin Backend');
      console.log(` Server running on http://localhost:${currentPort}`);
      console.log(` Environment: ${env.NODE_ENV}`);
      console.log(` Storage Path: ${env.STORAGE_DIR}`);
      console.log(` Python Engine: ${env.PYTHON_SERVICE_URL}`);
      console.log(' Reconstruction Worker: ACTIVE');
      console.log('====================================================');
    });

    const gracefulShutdown = async (signal) => {
      console.log(`\nReceived ${signal}. Gracefully shutting down...`);
      server.close(async () => {
        await disconnectDatabase();
        await closeRedisConnection();
        console.log('Server terminated cleanly.');
        process.exit(0);
      });
    };

    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  } catch (error) {
    console.error('Fatal startup error:', error);
    process.exit(1);
  }
};

startServer();
