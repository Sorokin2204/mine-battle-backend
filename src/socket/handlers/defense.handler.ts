import { Server, Socket } from 'socket.io';
import {
  createDefense,
  getAllDefenses,
  getMyGamesPage,
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
import { getConfigByDifficulty } from '../../config/game.config';
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
  ToolPreview,
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

  socket.on('getMyGames', async (data, callback) => {
    try {
      if (!checkRateLimit(userId, 'getMyGames', 60)) {
        return callback({ success: false, error: 'Rate limit exceeded', code: 'RATE_LIMIT' });
      }

      const tab = data.tab === 'attacks' || data.tab === 'defenses' ? data.tab : 'all';
      const offset = Math.max(0, Math.floor(data.offset || 0));
      const limit = Math.min(20, Math.max(1, Math.floor(data.limit || 20)));
      const page = await getMyGamesPage(userId, tab, offset, limit);

      callback({
        success: true,
        data: {
          ...page,
          items: page.items.map((defense) => toDefensePublic(defense as any, defense.creatorId === userId)),
        },
      });
    } catch (error) {
      console.error('Error getting user games:', error);
      callback({ success: false, error: 'Failed to get user games', code: 'SERVER_ERROR' });
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

      callback({ success: true, data: toDefensePublic(defense as any, defense.creatorId === userId) });
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
      const creatorDefense = toDefensePublic(defense as any, true);

      // Check if there's a matching user in the matchmaking queue
      const matchedUser = matchmakingService.findMatch(defense);

      if (matchedUser) {
        // Remove matched user from queue
        matchmakingService.removeFromQueue(matchedUser.userId);

        // Notify matched user about the match
        io.to(matchedUser.socketId).emit('matchFound', { defenseId: defense.id, defense: defensePublic });

        console.log(`Match found! Defense ${defense.id} matched with user ${matchedUser.userId}`);
      }

      // Keep every connected list in sync, including the creator's badges.
      io.emit('defenseCreated', defensePublic);

      // Update creator's balance
      const user = await getUserById(userId);
      if (user) {
        socket.emit('balanceUpdated', { balance: user.balance });
      }

      callback({ success: true, data: creatorDefense });
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

      // The board layout is private to its creator until the match ends.
      io.to(`defense:${defense.id}`).except(`user:${defense.creatorId}`).emit('gameStarted', defensePublic);
      io.to(`user:${defense.creatorId}`).emit('gameStarted', toDefensePublic(defense as any, true));

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

      const defense = await getDefenseById(data.defenseId);

      // Schedule exactly the deadline persisted by the move transaction. This
      // keeps UI, database and server timer on the same timestamp.
      if (!result.gameFinished && defense?.moveDeadline) {
        timerService.startMoveTimer(data.defenseId, defense.moveDeadline);
      } else if (result.gameFinished) {
        timerService.stopAllTimers(data.defenseId);
      }

      // Notify room about move
      io.to(`defense:${data.defenseId}`).emit('moveMade', {
        defenseId: data.defenseId,
        move: result,
      });
      io.to(`defense:${data.defenseId}`).emit('toolPreviewUpdated', {
        defenseId: data.defenseId,
        preview: null,
      });

      // Publish every persisted move so badges receive the new moveDeadline.
      if (defense) {
        const defensePublic = toDefensePublic(defense as any);
        io.emit('defenseUpdated', defensePublic);

        if (result.gameFinished) {
          io.to(`defense:${data.defenseId}`).emit('gameFinished', defensePublic);

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

  // Broadcast the attacker's in-progress scanner/radar placement so the
  // defender and spectators see the same board before the move is confirmed.
  socket.on('updateToolPreview', async (data: { defenseId: number; preview: ToolPreview }) => {
    try {
      const defense = await getDefenseById(data.defenseId);
      if (!defense || defense.status !== 'IN_PROGRESS' || defense.attackerId !== userId) return;

      const config = getConfigByDifficulty(((defense as any).difficulty as any) || 'MEDIUM');
      const preview = data.preview;
      if (preview?.moveType === 'SCANNER') {
        const positionsAreValid =
          preview.positions.length === 4 &&
          new Set(preview.positions).size === 4 &&
          preview.positions.every((position) => Number.isInteger(position) && position >= 0 && position < config.fieldSize ** 2);
        if (!positionsAreValid) return;
      } else if (preview?.moveType === 'RADAR') {
        if (!['row', 'column'].includes(preview.radarType) || !Number.isInteger(preview.index) || preview.index < 0 || preview.index >= config.fieldSize) return;
      }

      socket.to(`defense:${data.defenseId}`).emit('toolPreviewUpdated', data);
    } catch (error) {
      console.error('Error updating tool preview:', error);
    }
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
