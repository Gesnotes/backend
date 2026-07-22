import argon2 from 'argon2';
import crypto from 'node:crypto';

import prisma from '../lib/prisma';
import { env } from '../lib/env';
import { mailer } from '../lib/mailer';
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
      OR: [{ email: identifier.toLowerCase() }, { phone: identifier }],
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

  if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
    throw unauthorized('Refresh token invalide ou expiré');
  }
  if (stored.user.archivedAt) throw unauthorized('Refresh token invalide ou expiré');

  await prisma.refreshToken.update({
    where: { id: stored.id },
    data: { revokedAt: new Date() },
  });

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

/** Invalide le refresh token côté serveur. Idempotent. */
export async function logout(rawToken: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { tokenHash: hashToken(rawToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });
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
 * Demande de réinitialisation.
 *
 * Ne révèle jamais si le compte existe : la réponse du contrôleur est
 * identique dans tous les cas.
 */
export async function requestPasswordReset(schoolId: number, email: string): Promise<void> {
  const user = await prisma.user.findFirst({
    where: { schoolId, email: email.toLowerCase(), archivedAt: null },
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
    prisma.user.update({ where: { id: stored.userId }, data: { passwordHash } }),
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
