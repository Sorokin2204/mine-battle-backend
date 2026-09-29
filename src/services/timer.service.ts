import { Server } from 'socket.io';
import { PrismaClient, DefenseStatus } from '@prisma/client';
import { expireDefense, finishTimedOutDefense, toDefensePublic } from './defense.service';
import { ServerToClientEvents, ClientToServerEvents, InterServerEvents, SocketData } from '../types';

const prisma = new PrismaClient();

type GameServer = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

interface ActiveTimer {
  defenseId: number;
  type: 'defense' | 'move';
  endTime: number;
  intervalId: NodeJS.Timeout;
  timeoutId: NodeJS.Timeout;
}

class TimerService {
  private timers: Map<string, ActiveTimer> = new Map();
  private io: GameServer | null = null;
  private maintenanceInterval: NodeJS.Timeout | null = null;

  setServer(io: GameServer) {
    this.io = io;
  }

  async initialize() {
    await this.synchronizeTimers();

    if (!this.maintenanceInterval) {
      // A periodic reconciliation makes the database the source of truth and
      // recovers from delayed callbacks, process sleeps and transient errors.
      this.maintenanceInterval = setInterval(() => {
        void this.synchronizeTimers();
      }, 15000);
    }
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

    const timeoutMs = endTime - now;
    const timeoutId = setTimeout(() => {
      this.clearTimer(key);
      void this.handleDefenseExpire(defenseId);
    }, timeoutMs);

    this.timers.set(key, {
      defenseId,
      type: 'defense',
      endTime,
      intervalId,
      timeoutId,
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

    const timeoutMs = endTime - now;
    const timeoutId = setTimeout(() => {
      this.clearTimer(key);
      void this.handleMoveTimeout(defenseId);
    }, timeoutMs);

    this.timers.set(key, {
      defenseId,
      type: 'move',
      endTime,
      intervalId,
      timeoutId,
    });
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
      clearTimeout(timer.timeoutId);
      this.timers.delete(key);
    }
  }

  private async synchronizeTimers() {
    try {
      const activeDefenses = await prisma.defense.findMany({
        where: { status: { in: [DefenseStatus.WAITING, DefenseStatus.IN_PROGRESS] } },
        select: { id: true, status: true, expiresAt: true, moveDeadline: true },
      });

      const expectedKeys = new Set<string>();

      for (const defense of activeDefenses) {
        const type = defense.status === DefenseStatus.WAITING ? 'defense' : 'move';
        const deadline = type === 'defense' ? defense.expiresAt : defense.moveDeadline;
        const key = this.getTimerKey(defense.id, type);
        expectedKeys.add(key);

        if (!deadline || deadline.getTime() <= Date.now()) {
          this.clearTimer(key);
          if (type === 'defense') {
            await this.handleDefenseExpire(defense.id);
          } else {
            await this.handleMoveTimeout(defense.id);
          }
          continue;
        }

        const existingTimer = this.timers.get(key);
        if (existingTimer?.endTime === deadline.getTime()) {
          continue;
        }

        if (type === 'defense') {
          this.startDefenseTimer(defense.id, deadline);
        } else {
          this.startMoveTimer(defense.id, deadline);
        }
      }

      for (const key of this.timers.keys()) {
        if (!expectedKeys.has(key)) {
          this.clearTimer(key);
        }
      }
    } catch (error) {
      console.error('Error synchronizing game timers:', error);
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
        const creator = await prisma.user.findUnique({ where: { id: expiredDefense.creatorId } });
        if (creator) {
          this.io.to(`user:${creator.id}`).emit('balanceUpdated', { balance: creator.balance });
        }
      }
    } catch (error) {
      console.error(`Error expiring defense ${defenseId}:`, error);
    }
  }

  private async handleMoveTimeout(defenseId: number) {
    try {
      const finishedDefense = await finishTimedOutDefense(defenseId);

      if (this.io && finishedDefense) {
        const defensePublic = toDefensePublic(finishedDefense as any);
        this.io.to(`defense:${defenseId}`).emit('gameFinished', defensePublic);
        this.io.emit('defenseUpdated', defensePublic);

        const creator = await prisma.user.findUnique({ where: { id: finishedDefense.creatorId } });
        const attacker = finishedDefense.attackerId
          ? await prisma.user.findUnique({ where: { id: finishedDefense.attackerId } })
          : null;
        if (creator) {
          this.io.to(`user:${creator.id}`).emit('balanceUpdated', { balance: creator.balance });
        }
        if (attacker) {
          this.io.to(`user:${attacker.id}`).emit('balanceUpdated', { balance: attacker.balance });
        }
      }
    } catch (error) {
      console.error(`Error handling move timeout for defense ${defenseId}:`, error);
    }
  }

  // Clean up all timers on shutdown
  cleanup() {
    if (this.maintenanceInterval) {
      clearInterval(this.maintenanceInterval);
      this.maintenanceInterval = null;
    }
    for (const [, timer] of this.timers) {
      clearInterval(timer.intervalId);
      clearTimeout(timer.timeoutId);
    }
    this.timers.clear();
  }
}

export const timerService = new TimerService();
