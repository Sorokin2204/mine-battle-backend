import { Server, Socket } from 'socket.io';
import { matchmakingService } from '../../services/matchmaking.service';
import { getActiveDefenses, toDefensePublic } from '../../services/defense.service';
import { checkRateLimit } from '../../middleware/auth.middleware';
import { DifficultyLevel } from '../../config/game.config';
import {
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData,
  SocketResponse,
} from '../../types';

type GameSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
type GameServer = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

interface StartMatchmakingData {
  minBet: number;
  maxBet: number;
  difficulty?: DifficultyLevel;
}

interface MatchmakingResponse {
  queuePosition: number;
}

export function registerMatchmakingHandlers(io: GameServer, socket: GameSocket) {
  const userId = socket.data.userId;

  // Start matchmaking - add user to queue
  socket.on('startMatchmaking' as any, async (
    data: StartMatchmakingData,
    callback: (response: SocketResponse<MatchmakingResponse>) => void
  ) => {
    try {
      if (!checkRateLimit(userId, 'startMatchmaking', 10)) {
        return callback({ success: false, error: 'Rate limit exceeded', code: 'RATE_LIMIT' });
      }

      // Validate bet range
      if (data.minBet < 1 || data.maxBet < data.minBet) {
        return callback({ success: false, error: 'Invalid bet range', code: 'INVALID_BET_RANGE' });
      }

      // First, check existing defenses for a match
      const existingDefenses = await getActiveDefenses();
      const matchedDefense = matchmakingService.findMatchingDefense(
        userId,
        data.minBet,
        data.maxBet,
        existingDefenses,
        data.difficulty
      );

      if (matchedDefense) {
        // Found a matching defense - notify immediately
        const defensePublic = toDefensePublic(matchedDefense as any);
        console.log(`Instant match found for user ${userId}! Defense: ${matchedDefense.id}`);

        // Send match found event
        socket.emit('matchFound' as any, {
          defenseId: matchedDefense.id,
          defense: defensePublic
        });

        callback({ success: true, data: { queuePosition: 0 } });
        return;
      }

      // No immediate match - add to queue for future defenses
      const queuePosition = matchmakingService.addToQueue(
        userId,
        data.minBet,
        data.maxBet,
        socket.id,
        data.difficulty
      );

      console.log(`User ${userId} joined matchmaking queue. Position: ${queuePosition}`);

      callback({ success: true, data: { queuePosition } });
    } catch (error) {
      console.error('Error starting matchmaking:', error);
      callback({ success: false, error: 'Failed to start matchmaking', code: 'SERVER_ERROR' });
    }
  });

  // Stop matchmaking - remove user from queue
  socket.on('stopMatchmaking' as any, async (
    callback: (response: SocketResponse<null>) => void
  ) => {
    try {
      const removed = matchmakingService.removeFromQueue(userId);

      if (removed) {
        console.log(`User ${userId} left matchmaking queue`);
      }

      callback({ success: true, data: null });
    } catch (error) {
      console.error('Error stopping matchmaking:', error);
      callback({ success: false, error: 'Failed to stop matchmaking', code: 'SERVER_ERROR' });
    }
  });

  // Remove from queue on disconnect
  socket.on('disconnect', () => {
    if (matchmakingService.isInQueue(userId)) {
      matchmakingService.removeFromQueue(userId);
      console.log(`User ${userId} disconnected, removed from matchmaking queue`);
    }
  });
}

// Export function to notify matched user
export function notifyMatchFound(
  io: GameServer,
  socketId: string,
  defenseId: number,
  defense: any
) {
  io.to(socketId).emit('matchFound' as any, { defenseId, defense });
}
