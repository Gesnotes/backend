import jwt from 'jsonwebtoken';

import { env } from './env';
import type { AuthPayload } from '../types/express';

export function signAccessToken(payload: AuthPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL as jwt.SignOptions['expiresIn'],
  });
}

/** Renvoie le payload, ou null si le token est invalide/expiré. */
export function verifyAccessToken(token: string): AuthPayload | null {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET);
    if (typeof decoded === 'string') return null;

    const { userId, schoolId, role } = decoded as Record<string, unknown>;
    if (typeof userId !== 'number' || typeof schoolId !== 'number' || typeof role !== 'string') {
      return null;
    }
    return { userId, schoolId, role } as AuthPayload;
  } catch {
    return null;
  }
}
