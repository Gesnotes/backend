import argon2 from 'argon2';
import crypto from 'node:crypto';

import prisma from '../lib/prisma';
import { env, webAppUrl } from '../lib/env';
import { mailer } from '../lib/mailer';
import { normalizeEmail, normalizePhone } from '../lib/normalize';
import { signAccessToken } from '../lib/jwt';
import { hashToken } from '../lib/tokens';
import { badRequest, conflict, unauthorized } from '../errors/AppError';
import type { AuthPayload } from '../types/express';

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

/**
 * Un autre compte accessible à la même personne : soit détecté
 * automatiquement (même identifiant + mot de passe valides dans une autre
 * école), soit lié explicitement (`linkAccount`, identifiants différents).
 * Porte son propre `refreshToken`, fraîchement émis, utilisable tout de
 * suite pour basculer sans repasser par `/auth/identify`.
 */
export interface OtherAccount {
  userId: number;
  schoolId: number;
  schoolName: string;
  role: string;
  refreshToken: string;
}

export interface IdentifyOk {
  status: 'ok';
  accessToken: string;
  refreshToken: string;
  user: LoginResult['user'];
  school: { id: number; name: string };
  otherAccounts: OtherAccount[];
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
  const allVerified = await findValidAccountsFor(identifier, password);
  if (allVerified.length === 0) throw unauthorized(LOGIN_FAILED);

  // École choisie dans la liste ambiguë d'un appel précédent : on referme le
  // choix plutôt que de le redemander.
  let chosen = allVerified;
  if (schoolId !== undefined) {
    chosen = allVerified.filter((u) => u.schoolId === schoolId);
    if (chosen.length === 0) throw unauthorized(LOGIN_FAILED);
  }

  if (chosen.length > 1) {
    return {
      status: 'ambiguous',
      schools: chosen.map((u) => ({
        id: u.school.id,
        name: u.school.name,
        city: u.school.city,
      })),
    };
  }

  const user = chosen[0]!;
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
    // Toutes les écoles où ce même mot de passe est aussi valable, plus les
    // comptes liés explicitement — jamais l'utilisateur lui-même.
    otherAccounts: await otherAccountsFor(user.id, allVerified),
  };
}

type VerifiedCandidate = Awaited<ReturnType<typeof findValidAccountsFor>>[number];

/**
 * Cherche, à travers toutes les écoles actives, les comptes non archivés
 * dont l'identifiant (email ou téléphone) et le mot de passe correspondent.
 * Utilisée par `identify()` (connexion) et `linkAccount()` (liaison
 * explicite d'un second compte) — la même recherche, deux usages.
 */
async function findValidAccountsFor(identifier: string, password: string) {
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
    return [];
  }

  const verified = [];
  for (const candidate of candidates) {
    if (await argon2.verify(candidate.passwordHash, password)) verified.push(candidate);
  }
  return verified;
}

/**
 * Les autres comptes accessibles à la même personne que `userId` : ceux
 * découverts par `findValidAccountsFor` (même identifiant+mot de passe,
 * écoles différentes) et ceux liés explicitement via `AccountLink`. Chacun
 * reçoit un `refreshToken` fraîchement émis — la bascule se fait ensuite par
 * un simple `POST /auth/refresh`, sans repasser par `/auth/identify`.
 */
async function otherAccountsFor(
  userId: number,
  allVerifiedSameIdentifier: VerifiedCandidate[],
): Promise<OtherAccount[]> {
  const byUserId = new Map<number, { schoolId: number; schoolName: string; role: string }>();

  for (const candidate of allVerifiedSameIdentifier) {
    if (candidate.id === userId) continue;
    byUserId.set(candidate.id, {
      schoolId: candidate.schoolId,
      schoolName: candidate.school.name,
      role: candidate.role,
    });
  }

  const links = await prisma.accountLink.findMany({
    where: { ownerUserId: userId },
    include: { linked: { include: { school: { select: { name: true, archivedAt: true } } } } },
  });
  for (const link of links) {
    if (link.linked.archivedAt || link.linked.school.archivedAt) continue;
    byUserId.set(link.linkedUserId, {
      schoolId: link.linked.schoolId,
      schoolName: link.linked.school.name,
      role: link.linked.role,
    });
  }

  return Promise.all(
    [...byUserId.entries()].map(async ([otherUserId, account]) => ({
      userId: otherUserId,
      ...account,
      refreshToken: await issueRefreshToken(otherUserId),
    })),
  );
}

/**
 * Liaison explicite de deux comptes appartenant à la même personne réelle.
 *
 * Nécessaire quand `identify()` ne peut pas les rapprocher seul : un
 * enseignant qui est aussi parent dans la même école a forcément un
 * identifiant différent pour chaque compte (contrainte d'unicité par école).
 * Ressaisir une fois l'identifiant+mot de passe de l'autre compte prouve que
 * la même personne contrôle les deux — comme un login classique, mais dont
 * le résultat crée une liaison au lieu d'émettre un jeton pour cette requête.
 *
 * Crée les deux lignes symétriques (A→B et B→A) : la bascule doit
 * fonctionner dans les deux sens sans requête supplémentaire.
 */
export async function linkAccount(
  auth: AuthPayload,
  identifier: string,
  password: string,
): Promise<OtherAccount> {
  const verified = await findValidAccountsFor(identifier, password);
  if (verified.length === 0) throw unauthorized(LOGIN_FAILED);

  const candidates = verified.filter((u) => u.id !== auth.userId);
  if (candidates.length === 0) {
    throw badRequest('Vous ne pouvez pas lier un compte à lui-même.');
  }
  if (candidates.length > 1) {
    throw badRequest(
      "Cet identifiant correspond à plusieurs écoles : indiquez un identifiant propre au compte à lier.",
    );
  }

  const target = candidates[0]!;

  const existing = await prisma.accountLink.findUnique({
    where: { ownerUserId_linkedUserId: { ownerUserId: auth.userId, linkedUserId: target.id } },
  });
  if (existing) throw conflict('Ce compte est déjà lié.');

  await prisma.$transaction([
    prisma.accountLink.create({ data: { ownerUserId: auth.userId, linkedUserId: target.id } }),
    prisma.accountLink.create({ data: { ownerUserId: target.id, linkedUserId: auth.userId } }),
  ]);

  return {
    userId: target.id,
    schoolId: target.schoolId,
    schoolName: target.school.name,
    role: target.role,
    refreshToken: await issueRefreshToken(target.id),
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
