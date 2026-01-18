import { Server, Socket } from 'socket.io';
import {
  createDefense,
  getAllDefenses,
  getDefenseById,
  startAttack,
  makeMove,
  takeHalf,
  toDefensePublic,
} from '../../services/defense.service';
import { getUserById, toUserWithBalance } from '../../services/user.service';
import { matchmakingService } from '../../services/matchmaking.service';
import { timerService } from '../../services/timer.service';
import { checkRateLimit } from '../../middleware/auth.middleware';
import {
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData,
  CreateDefenseData,
  AttackDefenseData,
  MakeMoveData,
  TakeHalfData,
  SocketResponse,
  DefensePublic,
  MoveResult,
  UserWithBalance,
} from '../../types';

type GameSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
type GameServer = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

export function registerDefenseHandlers(io: GameServer, socket: GameSocket) {
  const userId = socket.data.userId;

  // Get all defenses (optionally including finished and expired)
  socket.on('getDefenses', async (dataOrCallback, maybeCallback?) => {
    // Support both old signature (callback only) and new signature (data, callback)
    const callback = typeof dataOrCallback === 'function' ? dataOrCallback : maybeCallback!;
    const data = typeof dataOrCallback === 'function' ? { includeFinished: false, includeExpired: false } : dataOrCallback;
    const includeFinished = data.includeFinished ?? false;
    const includeExpired = data.includeExpired ?? false;

    try {
      if (!checkRateLimit(userId, 'getDefenses', 30)) {
        return callback({ success: false, error: 'Rate limit exceeded', code: 'RATE_LIMIT' });
      }

      const defenses = await getAllDefenses(includeFinished, includeExpired);
      const defensesPublic = defenses.map((d) => toDefensePublic(d as any));

      callback({ success: true, data: defensesPublic });
    } catch (error) {
      console.error('Error getting defenses:', error);
      callback({ success: false, error: 'Failed to get defenses', code: 'SERVER_ERROR' });
    }
  });

  // Get single defense
  socket.on('getDefense', async (data, callback) => {
    try {
      if (!checkRateLimit(userId, 'getDefense', 60)) {
        return callback({ success: false, error: 'Rate limit exceeded', code: 'RATE_LIMIT' });
      }

      const defense = await getDefenseById(data.defenseId);

      if (!defense) {
        return callback({ success: false, error: 'Defense not found', code: 'NOT_FOUND' });
      }

      const isParticipant = defense.creatorId === userId || defense.attackerId === userId;
      callback({ success: true, data: toDefensePublic(defense as any, isParticipant) });
    } catch (error) {
      console.error('Error getting defense:', error);
      callback({ success: false, error: 'Failed to get defense', code: 'SERVER_ERROR' });
    }
  });

  // Create defense
  socket.on('createDefense', async (data: CreateDefenseData, callback) => {
    try {
      if (!checkRateLimit(userId, 'createDefense', 10)) {
        return callback({ success: false, error: 'Rate limit exceeded', code: 'RATE_LIMIT' });
      }

      const defense = await createDefense(userId, data.bet, data.bombPositions, data.difficulty);

      // Start defense expiration timer
      timerService.startDefenseTimer(defense.id, defense.expiresAt);

      const defensePublic = toDefensePublic(defense as any);

      // Check if there's a matching user in the matchmaking queue
      const matchedUser = matchmakingService.findMatch(defense);

      if (matchedUser) {
        // Remove matched user from queue
        matchmakingService.removeFromQueue(matchedUser.userId);

        // Notify matched user about the match
        io.to(matchedUser.socketId).emit('matchFound', { defenseId: defense.id, defense: defensePublic });

        console.log(`Match found! Defense ${defense.id} matched with user ${matchedUser.userId}`);
      } else {
        // No match found - notify all clients about new defense (normal flow)
        io.emit('defenseCreated', defensePublic);
      }

      // Update creator's balance
      const user = await getUserById(userId);
      if (user) {
        socket.emit('balanceUpdated', { balance: user.balance });
      }

      callback({ success: true, data: defensePublic });
    } catch (error: any) {
      console.error('Error creating defense:', error);
      callback({ success: false, error: error.message || 'Failed to create defense', code: 'CREATE_ERROR' });
    }
  });

  // Attack defense
  socket.on('attackDefense', async (data: AttackDefenseData, callback) => {
    try {
      if (!checkRateLimit(userId, 'attackDefense', 10)) {
        return callback({ success: false, error: 'Rate limit exceeded', code: 'RATE_LIMIT' });
      }

      const defense = await startAttack(data.defenseId, userId);

      // Stop defense expiration timer, start move timer
      timerService.stopDefenseTimer(defense.id);
      timerService.startMoveTimer(defense.id, defense.moveDeadline!);

      const defensePublic = toDefensePublic(defense as any);

      // Notify room about game start
      io.to(`defense:${defense.id}`).emit('gameStarted', defensePublic);

      // Notify all clients about defense update
      io.emit('defenseUpdated', defensePublic);

      // Update attacker's balance
      const user = await getUserById(userId);
      if (user) {
        socket.emit('balanceUpdated', { balance: user.balance });
      }

      callback({ success: true, data: defensePublic });
    } catch (error: any) {
      console.error('Error attacking defense:', error);
      callback({ success: false, error: error.message || 'Failed to attack defense', code: 'ATTACK_ERROR' });
    }
  });

  // Make move
  socket.on('makeMove', async (data: MakeMoveData, callback) => {
    try {
      if (!checkRateLimit(userId, 'makeMove', 30)) {
        return callback({ success: false, error: 'Rate limit exceeded', code: 'RATE_LIMIT' });
      }

      const result = await makeMove(
        data.defenseId,
        userId,
        data.moveType,
        data.position,
        data.positions
      );

      // Reset move timer if game continues
      if (!result.gameFinished) {
        timerService.resetMoveTimer(data.defenseId);
      } else {
        timerService.stopAllTimers(data.defenseId);
      }

      // Notify room about move
      io.to(`defense:${data.defenseId}`).emit('moveMade', {
        defenseId: data.defenseId,
        move: result,
      });

      // If game finished, notify everyone
      if (result.gameFinished) {
        const defense = await getDefenseById(data.defenseId);
        if (defense) {
          const defensePublic = toDefensePublic(defense as any);
          io.to(`defense:${data.defenseId}`).emit('gameFinished', defensePublic);
          io.emit('defenseUpdated', defensePublic);

          // Update both players' balances
          const creator = await getUserById(defense.creatorId);
          const attacker = defense.attackerId ? await getUserById(defense.attackerId) : null;

          if (creator) {
            io.to(`user:${creator.id}`).emit('balanceUpdated', { balance: creator.balance });
          }
          if (attacker) {
            io.to(`user:${attacker.id}`).emit('balanceUpdated', { balance: attacker.balance });
          }
        }
      }

      callback({ success: true, data: result });
    } catch (error: any) {
      console.error('Error making move:', error);
      callback({ success: false, error: error.message || 'Failed to make move', code: 'MOVE_ERROR' });
    }
  });

  // Take half
  socket.on('takeHalf', async (data: TakeHalfData, callback) => {
    try {
      if (!checkRateLimit(userId, 'takeHalf', 5)) {
        return callback({ success: false, error: 'Rate limit exceeded', code: 'RATE_LIMIT' });
      }

      const defense = await takeHalf(data.defenseId, userId);

      // Stop all timers
      timerService.stopAllTimers(data.defenseId);

      const defensePublic = toDefensePublic(defense as any);

      // Notify room about game finish
      io.to(`defense:${data.defenseId}`).emit('gameFinished', defensePublic);
      io.emit('defenseUpdated', defensePublic);

      // Update both players' balances
      const creator = await getUserById(defense.creatorId);
      const attacker = defense.attackerId ? await getUserById(defense.attackerId) : null;

      if (creator) {
        io.to(`user:${creator.id}`).emit('balanceUpdated', { balance: creator.balance });
      }
      if (attacker) {
        io.to(`user:${attacker.id}`).emit('balanceUpdated', { balance: attacker.balance });
      }

      callback({ success: true, data: defensePublic });
    } catch (error: any) {
      console.error('Error taking half:', error);
      callback({ success: false, error: error.message || 'Failed to take half', code: 'TAKE_HALF_ERROR' });
    }
  });

  // Join defense room
  socket.on('joinDefenseRoom', (data: { defenseId: number }) => {
    socket.join(`defense:${data.defenseId}`);
  });

  // Leave defense room
  socket.on('leaveDefenseRoom', (data: { defenseId: number }) => {
    socket.leave(`defense:${data.defenseId}`);
  });

  // Get current user info
  socket.on('getMe', async (callback) => {
    try {
      const user = await getUserById(userId);

      if (!user) {
        return callback({ success: false, error: 'User not found', code: 'NOT_FOUND' });
      }

      callback({ success: true, data: toUserWithBalance(user) });
    } catch (error) {
      console.error('Error getting user:', error);
      callback({ success: false, error: 'Failed to get user', code: 'SERVER_ERROR' });
    }
  });

  // Join user's personal room for balance updates
  socket.join(`user:${userId}`);
}
