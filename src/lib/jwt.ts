import jwt from 'jsonwebtoken';

import { env } from './env';
import type { AuthPayload } from '../types/express';

export function signAccessToken(payload: AuthPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL as jwt.SignOptions['expiresIn'],
  });
}

/**
 * Renvoie le payload et sa date d'émission, ou null si le token est
 * invalide/expiré. `issuedAt` sert à couper les tokens antérieurs à
 * `User.sessionsRevokedAt`.
 */
export function verifyAccessToken(token: string): (AuthPayload & { issuedAt: Date }) | null {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET);
    if (typeof decoded === 'string') return null;

    const { userId, schoolId, role, iat } = decoded as Record<string, unknown>;
    if (
      typeof userId !== 'number' ||
      typeof schoolId !== 'number' ||
      typeof role !== 'string' ||
      typeof iat !== 'number'
    ) {
      return null;
    }
    return { userId, schoolId, role, issuedAt: new Date(iat * 1000) } as AuthPayload & {
      issuedAt: Date;
    };
  } catch {
    return null;
  }
}
