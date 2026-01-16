import { Server } from 'socket.io';
import { PrismaClient, DefenseStatus, GameResult } from '@prisma/client';
import { defaultGameConfig } from '../config/game.config';
import { expireDefense, toDefensePublic, getDefenseById } from './defense.service';
import { ServerToClientEvents, ClientToServerEvents, InterServerEvents, SocketData } from '../types';

const prisma = new PrismaClient();

type GameServer = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

interface ActiveTimer {
  defenseId: number;
  type: 'defense' | 'move';
  endTime: number;
  intervalId: NodeJS.Timeout;
}

class TimerService {
  private timers: Map<string, ActiveTimer> = new Map();
  private io: GameServer | null = null;

  setServer(io: GameServer) {
    this.io = io;
  }

  private getTimerKey(defenseId: number, type: 'defense' | 'move'): string {
    return `${defenseId}-${type}`;
  }

  startDefenseTimer(defenseId: number, expiresAt: Date) {
    const key = this.getTimerKey(defenseId, 'defense');

    // Clear existing timer if any
    this.clearTimer(key);

    const endTime = expiresAt.getTime();
    const now = Date.now();

    if (endTime <= now) {
      // Already expired
      this.handleDefenseExpire(defenseId);
      return;
    }

    // Set up interval for updates (every 10 seconds)
    const intervalId = setInterval(() => {
      const timeLeft = endTime - Date.now();

      if (timeLeft <= 0) {
        this.handleDefenseExpire(defenseId);
        this.clearTimer(key);
        return;
      }

      // Emit timer update
      if (this.io) {
        this.io.to(`defense:${defenseId}`).emit('timerUpdate', {
          defenseId,
          timeLeft,
          type: 'defense',
        });
      }
    }, 10000);

    // Set up timeout for expiration
    const timeoutMs = endTime - now;
    setTimeout(() => {
      this.handleDefenseExpire(defenseId);
      this.clearTimer(key);
    }, timeoutMs);

    this.timers.set(key, {
      defenseId,
      type: 'defense',
      endTime,
      intervalId,
    });
  }

  startMoveTimer(defenseId: number, deadline: Date) {
    const key = this.getTimerKey(defenseId, 'move');

    // Clear existing timer if any
    this.clearTimer(key);

    const endTime = deadline.getTime();
    const now = Date.now();

    if (endTime <= now) {
      // Already expired
      this.handleMoveTimeout(defenseId);
      return;
    }

    // Set up interval for updates (every second)
    const intervalId = setInterval(() => {
      const timeLeft = endTime - Date.now();

      if (timeLeft <= 0) {
        this.handleMoveTimeout(defenseId);
        this.clearTimer(key);
        return;
      }

      // Emit timer update
      if (this.io) {
        this.io.to(`defense:${defenseId}`).emit('timerUpdate', {
          defenseId,
          timeLeft,
          type: 'move',
        });
      }
    }, 1000);

    // Set up timeout for expiration
    const timeoutMs = endTime - now;
    setTimeout(() => {
      this.handleMoveTimeout(defenseId);
      this.clearTimer(key);
    }, timeoutMs);

    this.timers.set(key, {
      defenseId,
      type: 'move',
      endTime,
      intervalId,
    });
  }

  resetMoveTimer(defenseId: number) {
    const config = defaultGameConfig;
    const newDeadline = new Date(Date.now() + config.moveTime);
    this.startMoveTimer(defenseId, newDeadline);
  }

  stopDefenseTimer(defenseId: number) {
    this.clearTimer(this.getTimerKey(defenseId, 'defense'));
  }

  stopMoveTimer(defenseId: number) {
    this.clearTimer(this.getTimerKey(defenseId, 'move'));
  }

  stopAllTimers(defenseId: number) {
    this.stopDefenseTimer(defenseId);
    this.stopMoveTimer(defenseId);
  }

  private clearTimer(key: string) {
    const timer = this.timers.get(key);
    if (timer) {
      clearInterval(timer.intervalId);
      this.timers.delete(key);
    }
  }

  private async handleDefenseExpire(defenseId: number) {
    try {
      const defense = await prisma.defense.findUnique({
        where: { id: defenseId },
      });

      if (!defense || defense.status !== DefenseStatus.WAITING) {
        return;
      }

      const expiredDefense = await expireDefense(defenseId);

      if (this.io) {
        this.io.emit('defenseUpdated', toDefensePublic(expiredDefense as any));
        this.io.emit('defenseRemoved', defenseId);
      }
    } catch (error) {
      console.error(`Error expiring defense ${defenseId}:`, error);
    }
  }

  private async handleMoveTimeout(defenseId: number) {
    try {
      const defense = await prisma.defense.findUnique({
        where: { id: defenseId },
        include: { creator: true, attacker: true },
      });

      if (!defense || defense.status !== DefenseStatus.IN_PROGRESS) {
        return;
      }

      // Timeout - defender wins
      const totalPot = defense.bet * 2;

      await prisma.$transaction(async (tx) => {
        // Pay defender
        const creator = await tx.user.update({
          where: { id: defense.creatorId },
          data: { balance: { increment: totalPot } },
        });

        // Update defense
        await tx.defense.update({
          where: { id: defenseId },
          data: {
            status: DefenseStatus.FINISHED,
            result: GameResult.TIMEOUT,
            winnerId: defense.creatorId,
            finishedAt: new Date(),
          },
        });

        // Create transaction
        await tx.transaction.create({
          data: {
            userId: defense.creatorId,
            defenseId,
            type: 'WIN',
            amount: totalPot,
            balanceBefore: creator.balance - totalPot,
            balanceAfter: creator.balance,
            description: `Won defense #${defenseId} (timeout)`,
          },
        });
      });

      const finishedDefense = await getDefenseById(defenseId);

      if (this.io && finishedDefense) {
        const defensePublic = toDefensePublic(finishedDefense as any);
        this.io.to(`defense:${defenseId}`).emit('gameFinished', defensePublic);
        this.io.emit('defenseUpdated', defensePublic);
      }
    } catch (error) {
      console.error(`Error handling move timeout for defense ${defenseId}:`, error);
    }
  }

  // Clean up all timers on shutdown
  cleanup() {
    for (const [key, timer] of this.timers) {
      clearInterval(timer.intervalId);
    }
    this.timers.clear();
  }
}

export const timerService = new TimerService();
