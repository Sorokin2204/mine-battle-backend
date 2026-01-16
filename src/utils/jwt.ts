import jwt from 'jsonwebtoken';
import { JwtPayload } from '../types';
import { serverConfig } from '../config/game.config';

export function generateToken(payload: JwtPayload): string {
  return jwt.sign(payload, serverConfig.jwtSecret, {
    expiresIn: serverConfig.jwtExpiresIn,
  });
}

export function verifyToken(token: string): JwtPayload | null {
  try {
    return jwt.verify(token, serverConfig.jwtSecret) as JwtPayload;
  } catch {
    return null;
  }
}
