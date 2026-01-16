import { Socket } from 'socket.io';
import { ExtendedError } from 'socket.io/dist/namespace';
import { verifyToken } from '../utils/jwt';
import { serverConfig } from '../config/game.config';
import { SocketData } from '../types';

export function socketAuthMiddleware(
  socket: Socket<any, any, any, SocketData>,
  next: (err?: ExtendedError) => void
) {
  try {
    const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      return next(new Error('Authentication required'));
    }

    const payload = verifyToken(token);

    if (!payload) {
      return next(new Error('Invalid token'));
    }

    // Attach user data to socket
    socket.data.userId = payload.userId;
    socket.data.telegramId = payload.telegramId;

    next();
  } catch (error) {
    next(new Error('Authentication failed'));
  }
}

// Rate limiter for socket events
interface RateLimitState {
  count: number;
  resetAt: number;
}

const rateLimitMap = new Map<string, RateLimitState>();

export function checkRateLimit(
  userId: number,
  event: string,
  maxRequests: number = serverConfig.rateLimitMax,
  windowMs: number = serverConfig.rateLimitWindow
): boolean {
  const key = `${userId}:${event}`;
  const now = Date.now();

  let state = rateLimitMap.get(key);

  if (!state || state.resetAt <= now) {
    state = {
      count: 1,
      resetAt: now + windowMs,
    };
    rateLimitMap.set(key, state);
    return true;
  }

  state.count++;

  if (state.count > maxRequests) {
    return false;
  }

  return true;
}

// Cleanup old rate limit entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, state] of rateLimitMap) {
    if (state.resetAt <= now) {
      rateLimitMap.delete(key);
    }
  }
}, 60000);
