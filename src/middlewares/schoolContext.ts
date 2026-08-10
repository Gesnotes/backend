import type { NextFunction, Request, Response } from 'express';

import prisma from '../lib/prisma';
import { forbidden, unauthorized } from '../errors/AppError';
import { setUserContext } from '../lib/monitoring';
import { verifyAccessToken } from '../lib/jwt';

/**
 * Contexte école.
 *
 * Le JWT fait seul autorité pour `school_id` : aucun sous-domaine ni en-tête
 * ne participe plus à la résolution — la connexion se fait par identifiant
 * (email/téléphone) + mot de passe, recherché à travers toutes les écoles
 * (voir `auth.service.ts`, `identify()`), et le JWT qui en résulte porte déjà
 * l'école. Ce middleware n'a donc plus qu'à décoder ce jeton, le revalider en
 * base (un JWT longue durée ne peut pas être repris une fois émis), et poser
 * `req.auth`/`req.schoolId`.
 *
 * ⚠️ Ce middleware N'EST PAS un garde d'authentification : une requête sans
 * jeton le traverse volontairement (une route publique en a besoin). Toute
 * route métier doit être protégée par `requireAuth`, placé après.
 */
export async function schoolContext(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      // Pas de jeton : rien à résoudre à ce stade. `requireAuth` refusera
      // ensuite si la route l'exige.
      return next();
    }

    const payload = verifyAccessToken(header.slice('Bearer '.length));
    if (!payload) throw unauthorized("Votre session n'est plus valable. Reconnectez-vous.");

    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: {
        id: true,
        schoolId: true,
        role: true,
        archivedAt: true,
        sessionsRevokedAt: true,
        school: { select: { archivedAt: true } },
      },
    });

    if (!user || user.archivedAt) throw unauthorized('Votre session a expiré. Reconnectez-vous.');

    // Suspendue par l'équipe Gesnotes : distinct d'un compte simplement
    // archivé, pour un message qui ne laisse pas croire à des identifiants
    // faux alors que l'établissement existe, seulement inaccessible pour
    // l'instant.
    if (user.school.archivedAt) {
      throw forbidden("Cet établissement n'est plus accessible. Contactez l'équipe Gesnotes pour en savoir plus.");
    }

    if (user.sessionsRevokedAt && payload.issuedAt < user.sessionsRevokedAt) {
      throw unauthorized('Votre session a expiré. Reconnectez-vous.');
    }

    // Le rôle vient de la base, pas du token : une rétrogradation prend effet
    // immédiatement au lieu d'attendre l'expiration.
    req.auth = { userId: user.id, schoolId: user.schoolId, role: user.role };
    req.schoolId = user.schoolId;

    // Contexte de supervision : identifiant, rôle et école seulement — de quoi
    // reproduire un incident sans transporter de donnée nominative.
    setUserContext(req.auth);

    return next();
  } catch (error) {
    return next(error);
  }
}
