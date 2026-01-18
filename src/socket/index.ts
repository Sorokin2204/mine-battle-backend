import { Server as HttpServer } from 'http';
import { Server } from 'socket.io';
import { socketAuthMiddleware } from '../middleware/auth.middleware';
import { registerDefenseHandlers } from './handlers/defense.handler';
import { registerMatchmakingHandlers } from './handlers/matchmaking.handler';
import { timerService } from '../services/timer.service';
import { serverConfig } from '../config/game.config';
import {
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData,
} from '../types';

export function initializeSocket(httpServer: HttpServer) {
  const io = new Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>(
    httpServer,
    {
      cors: {
        origin: serverConfig.corsOrigin,
        methods: ['GET', 'POST'],
        credentials: true,
      },
      pingTimeout: 60000,
      pingInterval: 25000,
    }
  );

  // Set up timer service with io instance
  timerService.setServer(io);

  // Authentication middleware
  io.use(socketAuthMiddleware);

  io.on('connection', (socket) => {
    console.log(`User connected: ${socket.data.userId}`);

    // Register event handlers
    registerDefenseHandlers(io, socket);
    registerMatchmakingHandlers(io, socket);

    socket.on('disconnect', (reason) => {
      console.log(`User disconnected: ${socket.data.userId}, reason: ${reason}`);
    });

    socket.on('error', (error) => {
      console.error(`Socket error for user ${socket.data.userId}:`, error);
    });
  });

  return io;
}
