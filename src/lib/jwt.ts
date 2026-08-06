import jwt from 'jsonwebtoken';

import { env } from './env';
import type { AuthPayload, StaffAuthPayload } from '../types/express';

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

/**
 * Token de l'équipe Gesnotes — forme distincte de `AuthPayload` (`staffId`
 * seul, ni `schoolId` ni `role`) : un token client ne peut jamais être relu
 * comme un token staff, ni l'inverse, sans passer par la bonne fonction de
 * vérification.
 */
export function signStaffAccessToken(payload: StaffAuthPayload): string {
  return jwt.sign({ ...payload, kind: 'staff' }, env.JWT_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL as jwt.SignOptions['expiresIn'],
  });
}

export function verifyStaffAccessToken(
  token: string,
): (StaffAuthPayload & { issuedAt: Date }) | null {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET);
    if (typeof decoded === 'string') return null;

    const { staffId, kind, iat } = decoded as Record<string, unknown>;
    if (kind !== 'staff' || typeof staffId !== 'number' || typeof iat !== 'number') {
      return null;
    }
    return { staffId, issuedAt: new Date(iat * 1000) };
  } catch {
    return null;
  }
}
