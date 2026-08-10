import argon2 from 'argon2';
import crypto from 'node:crypto';

import prisma from '../lib/prisma';
import { env, webAppUrl } from '../lib/env';
import { mailer } from '../lib/mailer';
import { normalizeEmail, normalizePhone } from '../lib/normalize';
import { signAccessToken } from '../lib/jwt';
import { hashToken } from '../lib/tokens';
import { unauthorized } from '../errors/AppError';

/**
 * Message unique pour tout échec de connexion.
 *
 * Ne jamais distinguer « compte inconnu », « mot de passe faux » et « compte
 * archivé » : la différence permettrait d'énumérer les comptes existants.
 */
const LOGIN_FAILED =
  'Email, téléphone ou mot de passe incorrect. Vérifiez votre saisie, puis réessayez.';

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  user: { id: number; email: string; role: string; firstName: string | null; lastName: string | null };
}

export interface IdentifyOk {
  status: 'ok';
  accessToken: string;
  refreshToken: string;
  user: LoginResult['user'];
  school: { id: number; name: string };
}

export interface IdentifyAmbiguous {
  status: 'ambiguous';
  schools: { id: number; name: string; city: string | null }[];
}

export type IdentifyResult = IdentifyOk | IdentifyAmbiguous;

/**
 * Connexion par identifiant (email ou téléphone) + mot de passe, recherchée
 * à travers toutes les écoles actives — aucun sous-domaine ni en-tête
 * n'intervient plus dans la résolution de l'établissement.
 *
 * Un même identifiant peut exister dans deux écoles (un parent avec un enfant
 * dans chacune) : si le mot de passe saisi est valable dans plus d'une,
 * impossible de deviner laquelle sans le demander — la réponse liste alors
 * les écoles concernées, sans jamais émettre de jeton pour l'une plutôt que
 * l'autre. Le client rappelle ensuite avec le `schoolId` choisi.
 */
export async function identify(
  identifier: string,
  password: string,
  schoolId?: number,
): Promise<IdentifyResult> {
  const parEmail = identifier.includes('@');

  const candidates = await prisma.user.findMany({
    where: {
      archivedAt: null,
      school: { archivedAt: null },
      ...(parEmail
        ? { email: normalizeEmail(identifier) }
        : { phone: normalizePhone(identifier) }),
    },
    include: { school: { select: { id: true, name: true, city: true } } },
  });

  // Hachage à vide quand l'identifiant n'existe nulle part : sans cela, le
  // temps de réponse trahit son absence (attaque temporelle).
  if (candidates.length === 0) {
    await argon2.hash('mot-de-passe-factice-pour-egaliser-le-temps');
    throw unauthorized(LOGIN_FAILED);
  }

  let verified = [];
  for (const candidate of candidates) {
    if (await argon2.verify(candidate.passwordHash, password)) verified.push(candidate);
  }

  if (verified.length === 0) throw unauthorized(LOGIN_FAILED);

  // École choisie dans la liste ambiguë d'un appel précédent : on referme le
  // choix plutôt que de le redemander.
  if (schoolId !== undefined) {
    verified = verified.filter((u) => u.schoolId === schoolId);
    if (verified.length === 0) throw unauthorized(LOGIN_FAILED);
  }

  if (verified.length > 1) {
    return {
      status: 'ambiguous',
      schools: verified.map((u) => ({
        id: u.school.id,
        name: u.school.name,
        city: u.school.city,
      })),
    };
  }

  const user = verified[0]!;
  const accessToken = signAccessToken({ userId: user.id, schoolId: user.schoolId, role: user.role });
  const refreshToken = await issueRefreshToken(user.id);

  return {
    status: 'ok',
    accessToken,
    refreshToken,
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      firstName: user.firstName,
      lastName: user.lastName,
    },
    school: { id: user.school.id, name: user.school.name },
  };
}

/** Rotation : l'ancien refresh token est révoqué, un nouveau est émis. */
export async function refresh(rawToken: string): Promise<LoginResult> {
  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    include: { user: true },
  });

  if (!stored || stored.expiresAt < new Date()) {
    throw unauthorized('Votre session a expiré. Reconnectez-vous.');
  }

  /**
   * Réutilisation d'un token déjà révoqué : soit le token a fuité et un tiers
   * le rejoue, soit le client légitime rejoue après vol. Dans les deux cas on
   * ne peut pas distinguer la victime de l'attaquant, donc on coupe toute la
   * famille et on force un passage par le login.
   */
  if (stored.revokedAt) {
    await revokeAllRefreshTokens(stored.userId);
    throw unauthorized('Votre session a expiré. Reconnectez-vous.');
  }

  if (stored.user.archivedAt) throw unauthorized('Votre session a expiré. Reconnectez-vous.');

  // Révocation conditionnelle : deux rafraîchissements concurrents avec le
  // même token ne doivent pas produire deux chaînes valides. Seul celui qui
  // gagne la course voit count === 1.
  const { count } = await prisma.refreshToken.updateMany({
    where: { id: stored.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (count !== 1) throw unauthorized('Votre session a expiré. Reconnectez-vous.');

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
 * Demande de réinitialisation, recherchée à travers toutes les écoles (plus
 * de sous-domaine pour la scoper à une seule).
 *
 * Ne révèle jamais si le compte existe : la réponse du contrôleur est
 * identique dans tous les cas. Un même email peut être rattaché à un compte
 * dans plusieurs écoles (un parent avec un enfant dans chacune) : chacun
 * reçoit alors son propre lien, dans un email qui nomme son établissement —
 * jamais un seul lien ambigu qui réinitialiserait le mauvais compte.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const users = await prisma.user.findMany({
    where: { email: normalizeEmail(email), archivedAt: null, school: { archivedAt: null } },
    select: { id: true, email: true, school: { select: { name: true } } },
  });
  if (users.length === 0) return;

  for (const user of users) {
    const rawToken = crypto.randomBytes(32).toString('hex');

    await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(rawToken),
        expiresAt: new Date(Date.now() + env.RESET_TOKEN_TTL_MINUTES * 60_000),
      },
    });

    const link = `${webAppUrl}/reset-password?token=${rawToken}`;
    const contexteEcole = users.length > 1 ? ` pour votre compte à ${user.school.name}` : '';
    await mailer.send(
      user.email,
      'Réinitialisation de votre mot de passe Gesnotes',
      `<p>Bonjour,</p>
       <p>Vous avez demandé la réinitialisation de votre mot de passe${contexteEcole}.</p>
       <p><a href="${link}">Définir un nouveau mot de passe</a></p>
       <p>Ce lien expire dans ${env.RESET_TOKEN_TTL_MINUTES} minutes. Si vous n'êtes pas à l'origine de cette demande, ignorez cet email.</p>`,
    );
  }
}

/** Valide le token du lien et change le mot de passe. Token à usage unique. */
export async function resetPassword(rawToken: string, newPassword: string): Promise<void> {
  const stored = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    include: { user: true },
  });

  if (!stored || stored.usedAt || stored.expiresAt < new Date()) {
    throw unauthorized(
      "Ce lien n'est plus valable : il a déjà servi, ou il est trop ancien. Demandez-en un nouveau depuis « Mot de passe oublié ».",
    );
  }
  if (stored.user.archivedAt) throw unauthorized(
      "Ce lien n'est plus valable : il a déjà servi, ou il est trop ancien. Demandez-en un nouveau depuis « Mot de passe oublié ».",
    );

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
