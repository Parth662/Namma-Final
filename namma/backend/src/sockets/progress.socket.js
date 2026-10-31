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
