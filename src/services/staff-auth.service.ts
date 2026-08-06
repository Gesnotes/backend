import argon2 from 'argon2';

import prisma from '../lib/prisma';
import { env } from '../lib/env';
import { normalizeEmail } from '../lib/normalize';
import { signStaffAccessToken } from '../lib/jwt';
import { generateToken, hashToken } from '../lib/tokens';
import { unauthorized } from '../errors/AppError';

/**
 * Connexion de l'équipe Gesnotes.
 *
 * Mirroir de `auth.service.ts`, pour un compte hors périmètre multi-écoles :
 * mêmes garanties (temps constant sur un email inconnu, tokens haché en
 * base, rotation du refresh token), sans `schoolId` ni sous-domaine.
 */

const LOGIN_FAILED = 'Email ou mot de passe incorrect. Vérifiez votre saisie, puis réessayez.';

export interface StaffLoginResult {
  accessToken: string;
  refreshToken: string;
  staff: { id: number; email: string; firstName: string | null; lastName: string | null };
}

function toPublicStaff(staff: {
  id: number;
  email: string;
  firstName: string | null;
  lastName: string | null;
}) {
  return { id: staff.id, email: staff.email, firstName: staff.firstName, lastName: staff.lastName };
}

export async function login(email: string, password: string): Promise<StaffLoginResult> {
  const staff = await prisma.staffUser.findUnique({ where: { email: normalizeEmail(email) } });

  if (!staff) {
    await argon2.hash('mot-de-passe-factice-pour-egaliser-le-temps');
    throw unauthorized(LOGIN_FAILED);
  }

  const valid = await argon2.verify(staff.passwordHash, password);
  if (!valid) throw unauthorized(LOGIN_FAILED);
  if (staff.archivedAt) throw unauthorized(LOGIN_FAILED);

  const accessToken = signStaffAccessToken({ staffId: staff.id });
  const refreshToken = await issueRefreshToken(staff.id);

  return { accessToken, refreshToken, staff: toPublicStaff(staff) };
}

/** Rotation : l'ancien refresh token est révoqué, un nouveau est émis. */
export async function refresh(rawToken: string): Promise<StaffLoginResult> {
  const stored = await prisma.staffRefreshToken.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    include: { staffUser: true },
  });

  if (!stored || stored.expiresAt < new Date()) {
    throw unauthorized('Votre session a expiré. Reconnectez-vous.');
  }

  // Réutilisation d'un token déjà révoqué : le token a fuité, ou le client
  // légitime rejoue après vol. On coupe toute la famille et on force un login.
  if (stored.revokedAt) {
    await revokeAllRefreshTokens(stored.staffUserId);
    throw unauthorized('Votre session a expiré. Reconnectez-vous.');
  }

  if (stored.staffUser.archivedAt) throw unauthorized('Votre session a expiré. Reconnectez-vous.');

  const { count } = await prisma.staffRefreshToken.updateMany({
    where: { id: stored.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (count !== 1) throw unauthorized('Votre session a expiré. Reconnectez-vous.');

  const accessToken = signStaffAccessToken({ staffId: stored.staffUser.id });

  return {
    accessToken,
    refreshToken: await issueRefreshToken(stored.staffUser.id),
    staff: toPublicStaff(stored.staffUser),
  };
}

export async function logout(rawToken: string): Promise<void> {
  await prisma.staffRefreshToken.updateMany({
    where: { tokenHash: hashToken(rawToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

async function revokeAllRefreshTokens(staffUserId: number): Promise<void> {
  await prisma.staffRefreshToken.updateMany({
    where: { staffUserId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

async function issueRefreshToken(staffUserId: number): Promise<string> {
  const rawToken = generateToken(48);

  await prisma.staffRefreshToken.create({
    data: {
      staffUserId,
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60_000),
    },
  });

  return rawToken;
}
