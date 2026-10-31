import { Server } from 'socket.io';
import { isOriginAllowed } from '../config/cors.js';

let ioInstance = null;

export const initSocketServer = (server) => {
  ioInstance = new Server(server, {
    cors: {
      origin: (origin, callback) => {
        if (isOriginAllowed(origin)) {
          callback(null, true);
        } else {
          callback(new Error(`Socket.IO CORS origin not allowed: ${origin}`));
        }
      },
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  ioInstance.on('connection', (socket) => {
    // console.log(`[Socket.IO] Client connected: ${socket.id}`);

    socket.on('join_project', (projectId) => {
      if (projectId) {
        socket.join(`project:${projectId}`);
        // console.log(`[Socket.IO] Socket ${socket.id} joined room: project:${projectId}`);
      }
    });

    socket.on('leave_project', (projectId) => {
      if (projectId) {
        socket.leave(`project:${projectId}`);
      }
    });

    socket.on('disconnect', () => {
      // console.log(`[Socket.IO] Client disconnected: ${socket.id}`);
    });
  });

  return ioInstance;
};

export const getIO = () => {
  return ioInstance;
};

export const emitProjectProgress = (projectId, payload) => {
  if (ioInstance) {
    ioInstance.to(`project:${projectId}`).emit('reconstruction_progress', {
      projectId,
      ...payload,
      timestamp: new Date().toISOString(),
    });
  }
};

export const emitJobStage = (projectId, { stage, progress, message }) => {
  if (ioInstance) {
    ioInstance.to(`project:${projectId}`).emit('job:stage', {
      projectId,
      stage,
      progress,
      message,
      timestamp: new Date().toISOString(),
    });
    // Backward compatibility with older clients
    emitProjectProgress(projectId, { stage, progress, message, status: 'processing' });
  }
};

export const emitQueuePosition = (projectId, { position, total, etaSeconds }) => {
  if (ioInstance) {
    ioInstance.to(`project:${projectId}`).emit('queue:position', {
      projectId,
      position,
      total,
      etaSeconds,
      timestamp: new Date().toISOString(),
    });
    emitProjectProgress(projectId, { status: 'queued', position, total, etaSeconds });
  }
};

export const emitJobCompleted = (projectId, payload = {}) => {
  if (ioInstance) {
    ioInstance.to(`project:${projectId}`).emit('job:completed', {
      projectId,
      ...payload,
      timestamp: new Date().toISOString(),
    });
    emitProjectProgress(projectId, { status: 'completed', stage: 'completed', progress: 100, ...payload });
  }
};

export const emitJobFailed = (projectId, { title, code, reason, suggestion, logPath, rejected = false }) => {
  if (ioInstance) {
    const isQuality = rejected || (code && (code.startsWith('REJECTED_') || code.startsWith('INSUFFICIENT_')));
    const finalTitle = title || (isQuality ? 'Reconstruction Quality Issue' : 'Server processing error');
    const finalCode = code || (isQuality ? 'INSUFFICIENT_RECONSTRUCTION_QUALITY' : 'SERVER_PROCESSING_ERROR');

    ioInstance.to(`project:${projectId}`).emit('job:failed', {
      projectId,
      title: finalTitle,
      code: finalCode,
      reason,
      suggestion,
      logPath,
      rejected,
      timestamp: new Date().toISOString(),
    });
    emitProjectProgress(projectId, {
      status: rejected ? 'rejected' : 'failed',
      stage: rejected ? 'rejected' : 'failed',
      progress: 0,
      title: finalTitle,
      code: finalCode,
      reason,
      suggestion,
      logPath,
    });
  }
};
