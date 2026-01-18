import { Defense } from '@prisma/client';
import { DifficultyLevel } from '../config/game.config';

interface QueueEntry {
  userId: number;
  minBet: number;
  maxBet: number;
  difficulty?: DifficultyLevel;
  timestamp: Date;
  socketId: string;
}

class MatchmakingService {
  private queue: Map<number, QueueEntry> = new Map();

  /**
   * Add user to matchmaking queue
   */
  addToQueue(
    userId: number,
    minBet: number,
    maxBet: number,
    socketId: string,
    difficulty?: DifficultyLevel
  ): number {
    // Remove existing entry if any
    this.removeFromQueue(userId);

    const entry: QueueEntry = {
      userId,
      minBet,
      maxBet,
      difficulty,
      timestamp: new Date(),
      socketId,
    };

    this.queue.set(userId, entry);
    return this.queue.size;
  }

  /**
   * Remove user from matchmaking queue
   */
  removeFromQueue(userId: number): boolean {
    return this.queue.delete(userId);
  }

  /**
   * Check if user is in queue
   */
  isInQueue(userId: number): boolean {
    return this.queue.has(userId);
  }

  /**
   * Get queue entry for user
   */
  getQueueEntry(userId: number): QueueEntry | undefined {
    return this.queue.get(userId);
  }

  /**
   * Find matching users for a new defense
   * Returns the first matching user from the queue
   */
  findMatch(defense: Defense): QueueEntry | null {
    const defenseDifficulty = (defense as any).difficulty as DifficultyLevel | undefined;

    for (const [userId, entry] of this.queue) {
      // Skip if it's the defense creator
      if (userId === defense.creatorId) {
        continue;
      }

      // Check if defense matches user criteria
      if (this.isMatch(entry, defense, defenseDifficulty)) {
        return entry;
      }
    }

    return null;
  }

  /**
   * Check if defense matches queue entry criteria
   */
  private isMatch(
    entry: QueueEntry,
    defense: Defense,
    defenseDifficulty?: DifficultyLevel
  ): boolean {
    // Check bet range
    if (defense.bet < entry.minBet || defense.bet > entry.maxBet) {
      return false;
    }

    // Check difficulty if specified
    if (entry.difficulty && defenseDifficulty && entry.difficulty !== defenseDifficulty) {
      return false;
    }

    return true;
  }

  /**
   * Find a matching defense from a list of existing defenses
   * Returns the first defense that matches the user's criteria
   */
  findMatchingDefense(
    userId: number,
    minBet: number,
    maxBet: number,
    defenses: Defense[],
    difficulty?: DifficultyLevel
  ): Defense | null {
    for (const defense of defenses) {
      // Skip if it's the user's own defense
      if (defense.creatorId === userId) {
        continue;
      }

      // Skip if defense is not waiting
      if (defense.status !== 'WAITING') {
        continue;
      }

      // Skip if defense is expired
      if (defense.expiresAt < new Date()) {
        continue;
      }

      const defenseDifficulty = (defense as any).difficulty as DifficultyLevel | undefined;

      // Check bet range
      if (defense.bet < minBet || defense.bet > maxBet) {
        continue;
      }

      // Check difficulty if specified
      if (difficulty && defenseDifficulty && difficulty !== defenseDifficulty) {
        continue;
      }

      return defense;
    }

    return null;
  }

  /**
   * Get queue size
   */
  getQueueSize(): number {
    return this.queue.size;
  }

  /**
   * Get all queue entries (for debugging)
   */
  getAllEntries(): QueueEntry[] {
    return Array.from(this.queue.values());
  }

  /**
   * Clean up stale entries (older than 5 minutes)
   */
  cleanupStaleEntries(): number {
    const now = Date.now();
    const staleThreshold = 5 * 60 * 1000; // 5 minutes
    let removed = 0;

    for (const [userId, entry] of this.queue) {
      if (now - entry.timestamp.getTime() > staleThreshold) {
        this.queue.delete(userId);
        removed++;
      }
    }

    return removed;
  }
}

export const matchmakingService = new MatchmakingService();
