import argon2 from 'argon2';
import crypto from 'node:crypto';

import prisma from '../lib/prisma';
import { env } from '../lib/env';
import { mailer } from '../lib/mailer';
import { normalizeEmail, normalizePhone } from '../lib/normalize';
import { signAccessToken } from '../lib/jwt';
import { unauthorized } from '../errors/AppError';

/**
 * Message unique pour tout échec de connexion.
 *
 * Ne jamais distinguer « compte inconnu », « mot de passe faux » et « compte
 * archivé » : la différence permettrait d'énumérer les comptes existants.
 */
const LOGIN_FAILED = 'Identifiants invalides';

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  user: { id: number; email: string; role: string; firstName: string | null; lastName: string | null };
}

/**
 * Connexion par email OU téléphone, dans l'école du sous-domaine.
 *
 * Le rejet des comptes archivés se fait ici, dans le service d'auth : le
 * middleware s'exécute après émission du token, c'est trop tard (plan §8.1).
 */
export async function login(
  schoolId: number,
  identifier: string,
  password: string,
): Promise<LoginResult> {
  const user = await prisma.user.findFirst({
    where: {
      schoolId,
      OR: [{ email: normalizeEmail(identifier) }, { phone: normalizePhone(identifier) }],
    },
  });

  // Hachage à vide quand le compte n'existe pas : sans cela, le temps de
  // réponse trahit l'existence d'un compte (attaque temporelle).
  if (!user) {
    await argon2.hash('mot-de-passe-factice-pour-egaliser-le-temps');
    throw unauthorized(LOGIN_FAILED);
  }

  const valid = await argon2.verify(user.passwordHash, password);
  if (!valid) throw unauthorized(LOGIN_FAILED);

  if (user.archivedAt) throw unauthorized(LOGIN_FAILED);

  const accessToken = signAccessToken({
    userId: user.id,
    schoolId: user.schoolId,
    role: user.role,
  });
  const refreshToken = await issueRefreshToken(user.id);

  return {
    accessToken,
    refreshToken,
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      firstName: user.firstName,
      lastName: user.lastName,
    },
  };
}

/** Rotation : l'ancien refresh token est révoqué, un nouveau est émis. */
export async function refresh(rawToken: string): Promise<LoginResult> {
  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    include: { user: true },
  });

  if (!stored || stored.expiresAt < new Date()) {
    throw unauthorized('Refresh token invalide ou expiré');
  }

  /**
   * Réutilisation d'un token déjà révoqué : soit le token a fuité et un tiers
   * le rejoue, soit le client légitime rejoue après vol. Dans les deux cas on
   * ne peut pas distinguer la victime de l'attaquant, donc on coupe toute la
   * famille et on force un passage par le login.
   */
  if (stored.revokedAt) {
    await revokeAllRefreshTokens(stored.userId);
    throw unauthorized('Refresh token invalide ou expiré');
  }

  if (stored.user.archivedAt) throw unauthorized('Refresh token invalide ou expiré');

  // Révocation conditionnelle : deux rafraîchissements concurrents avec le
  // même token ne doivent pas produire deux chaînes valides. Seul celui qui
  // gagne la course voit count === 1.
  const { count } = await prisma.refreshToken.updateMany({
    where: { id: stored.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (count !== 1) throw unauthorized('Refresh token invalide ou expiré');

  const accessToken = signAccessToken({
    userId: stored.user.id,
    schoolId: stored.user.schoolId,
    role: stored.user.role,
  });

  return {
    accessToken,
    refreshToken: await issueRefreshToken(stored.user.id),
    user: {
      id: stored.user.id,
      email: stored.user.email,
      role: stored.user.role,
      firstName: stored.user.firstName,
      lastName: stored.user.lastName,
    },
  };
}

/**
 * Déconnexion. Idempotent.
 *
 * Révoque le refresh token, et si la requête est authentifiée, coupe aussi
 * les access tokens déjà émis : sans `sessionsRevokedAt`, un token de 30 jours
 * resterait valable 30 jours après le logout.
 */
export async function logout(rawToken: string, userId?: number): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { tokenHash: hashToken(rawToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });

  if (userId !== undefined) {
    await prisma.user.update({
      where: { id: userId },
      data: { sessionsRevokedAt: new Date() },
    });
  }
}

/**
 * Révoque tous les refresh tokens d'un utilisateur.
 *
 * À appeler à chaque archivage de compte : sans cela, un compte désactivé se
 * reconnecte indéfiniment par refresh sans jamais repasser par le login.
 */
export async function revokeAllRefreshTokens(userId: number): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * Coupe toutes les sessions d'un utilisateur : refresh tokens ET access
 * tokens déjà émis. C'est la seule façon de déconnecter réellement quelqu'un
 * quand les access tokens sont longue durée.
 *
 * À appeler à l'archivage d'un compte et à tout changement de rôle.
 */
export async function revokeAllSessions(userId: number): Promise<void> {
  await prisma.$transaction([
    prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
    prisma.user.update({ where: { id: userId }, data: { sessionsRevokedAt: new Date() } }),
  ]);
}

/**
 * Demande de réinitialisation.
 *
 * Ne révèle jamais si le compte existe : la réponse du contrôleur est
 * identique dans tous les cas.
 */
export async function requestPasswordReset(schoolId: number, email: string): Promise<void> {
  const user = await prisma.user.findFirst({
    where: { schoolId, email: normalizeEmail(email), archivedAt: null },
  });
  if (!user) return;

  const rawToken = crypto.randomBytes(32).toString('hex');

  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(Date.now() + env.RESET_TOKEN_TTL_MINUTES * 60_000),
    },
  });

  const link = `${env.APP_BASE_URL}/reset-password?token=${rawToken}`;
  await mailer.send(
    user.email,
    'Réinitialisation de votre mot de passe Gesnotes',
    `<p>Bonjour,</p>
     <p>Vous avez demandé la réinitialisation de votre mot de passe.</p>
     <p><a href="${link}">Définir un nouveau mot de passe</a></p>
     <p>Ce lien expire dans ${env.RESET_TOKEN_TTL_MINUTES} minutes. Si vous n'êtes pas à l'origine de cette demande, ignorez cet email.</p>`,
  );
}

/** Valide le token du lien et change le mot de passe. Token à usage unique. */
export async function resetPassword(rawToken: string, newPassword: string): Promise<void> {
  const stored = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    include: { user: true },
  });

  if (!stored || stored.usedAt || stored.expiresAt < new Date()) {
    throw unauthorized('Lien de réinitialisation invalide ou expiré');
  }
  if (stored.user.archivedAt) throw unauthorized('Lien de réinitialisation invalide ou expiré');

  const passwordHash = await argon2.hash(newPassword);

  // Changer le mot de passe déconnecte partout : les refresh tokens existants
  // ne doivent pas survivre à une réinitialisation.
  await prisma.$transaction([
    prisma.user.update({
      where: { id: stored.userId },
      // sessionsRevokedAt coupe aussi les access tokens déjà émis.
      data: { passwordHash, sessionsRevokedAt: new Date() },
    }),
    prisma.passwordResetToken.update({ where: { id: stored.id }, data: { usedAt: new Date() } }),
    prisma.refreshToken.updateMany({
      where: { userId: stored.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);
}

async function issueRefreshToken(userId: number): Promise<string> {
  const rawToken = crypto.randomBytes(48).toString('hex');

  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60_000),
    },
  });

  return rawToken;
}

/**
 * Les tokens ne sont jamais stockés en clair : une fuite de la base ne doit
 * pas permettre de se connecter. SHA-256 suffit ici (le token est déjà un
 * secret aléatoire de 384 bits, il n'a pas besoin d'être ralenti comme un
 * mot de passe choisi par un humain).
 */
function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}
