import { Server } from 'socket.io';

let ioInstance = null;

export const initSocketServer = (server) => {
  ioInstance = new Server(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
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

export const emitJobFailed = (projectId, { reason, suggestion, rejected = false }) => {
  if (ioInstance) {
    ioInstance.to(`project:${projectId}`).emit('job:failed', {
      projectId,
      reason,
      suggestion,
      rejected,
      timestamp: new Date().toISOString(),
    });
    emitProjectProgress(projectId, {
      status: rejected ? 'rejected' : 'failed',
      stage: rejected ? 'rejected' : 'failed',
      progress: 0,
      reason,
      suggestion,
    });
  }
};
