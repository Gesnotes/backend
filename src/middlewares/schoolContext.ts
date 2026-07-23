import type { NextFunction, Request, Response } from 'express';

import prisma from '../lib/prisma';
import { env, isProduction } from '../lib/env';
import { forbidden, notFound, unauthorized } from '../errors/AppError';
import { logger } from '../lib/logger';
import { verifyAccessToken } from '../lib/jwt';

/**
 * Contexte école (plan §1.2).
 *
 * Le JWT fait autorité pour `school_id`. Le sous-domaine sert à :
 *  - router la page de login avant qu'un token existe ;
 *  - vérifier la cohérence à chaque requête authentifiée.
 *
 * Si sous-domaine ≠ école du token → 403. C'est le point unique de
 * l'isolation multi-écoles.
 *
 * ⚠️ Ce middleware N'EST PAS un garde d'authentification : une requête sans
 * token le traverse volontairement (la page de login en a besoin). Toute route
 * métier doit être protégée par `requireAuth`, placé après.
 */
export async function schoolContext(req: Request, _res: Response, next: NextFunction) {
  try {
    const school = await resolveSchool(req);
    if (!school) {
      throw await schoolNotFound(req.headers['x-school-subdomain'] as string | undefined);
    }

    req.schoolId = school.id;

    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      // Pas de token : aucune vérification de cohérence possible à ce stade.
      return next();
    }

    const payload = verifyAccessToken(header.slice('Bearer '.length));
    if (!payload) throw unauthorized('Token invalide ou expiré');

    if (school.id !== payload.schoolId) {
      throw forbidden('Sous-domaine incohérent avec le compte');
    }

    /**
     * Contrôle serveur du token, indispensable avec une durée de vie longue :
     * un JWT ne peut pas être repris une fois émis. Sans cette relecture,
     * logout, archivage d'un compte et changement de rôle resteraient sans
     * effet jusqu'à l'expiration (30 jours par défaut).
     */
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { id: true, schoolId: true, role: true, archivedAt: true, sessionsRevokedAt: true },
    });

    if (!user || user.archivedAt) throw unauthorized('Session expirée, reconnectez-vous');
    if (user.schoolId !== school.id) throw forbidden('Sous-domaine incohérent avec le compte');
    if (user.sessionsRevokedAt && payload.issuedAt < user.sessionsRevokedAt) {
      throw unauthorized('Session expirée, reconnectez-vous');
    }

    // Le rôle vient de la base, pas du token : une rétrogradation prend effet
    // immédiatement au lieu d'attendre l'expiration.
    req.auth = { userId: user.id, schoolId: user.schoolId, role: user.role };
    req.schoolId = user.schoolId;
    return next();
  } catch (error) {
    return next(error);
  }
}

/**
 * En local, `req.hostname` vaut "localhost" et ne résout aucune école : sans
 * repli, toutes les routes répondraient 404 en développement (plan §6.5).
 * Le repli est inactif en production.
 */
async function resolveSchool(req: Request) {
  const subdomain = req.hostname.split('.')[0];

  if (subdomain && subdomain !== 'localhost') {
    const school = await prisma.school.findUnique({ where: { subdomain } });
    if (school) return school;
  }

  if (isProduction) return null;

  const requested =
    (req.headers['x-school-subdomain'] as string | undefined) ?? env.DEFAULT_SCHOOL_SUBDOMAIN;

  if (requested) {
    const school = await prisma.school.findUnique({ where: { subdomain: requested } });
    if (school) return school;
  }

  /**
   * Dernier recours en développement : s'il n'existe qu'une seule école, c'est
   * forcément celle-là.
   *
   * En local, personne ne travaille sur plusieurs établissements. Exiger un
   * sous-domaine juste — dans le `.env` du backend **et** dans celui du
   * frontend, qui peuvent diverger sans bruit — transformait un oubli de
   * configuration en « Identifiants invalides » sur des identifiants pourtant
   * corrects.
   */
  const schools = await prisma.school.findMany({
    select: { id: true, name: true, subdomain: true },
    orderBy: { id: 'asc' },
    take: 2,
  });

  if (schools.length === 1) {
    const only = schools[0]!;
    if (requested) {
      logger.warn(
        { requested, resolved: only.subdomain },
        'Sous-domaine inconnu : repli sur la seule école de la base (développement)',
      );
    }
    return only;
  }

  return null;
}

/**
 * Message d'erreur détaillé, réservé au développement.
 *
 * En production, on ne dit rien de plus que « introuvable » : la liste des
 * sous-domaines d'une instance n'a pas à circuler. En local, c'est au
 * contraire l'information qui débloque en dix secondes.
 */
async function schoolNotFound(requested: string | undefined) {
  if (isProduction) return notFound('École introuvable pour ce sous-domaine');

  const schools = await prisma.school.findMany({
    select: { subdomain: true },
    orderBy: { id: 'asc' },
    take: 20,
  });

  if (schools.length === 0) {
    return notFound(
      "Aucune école en base. Lancez « npm run prisma:seed » (ou « prisma:seed:demo ») avant d'utiliser l'API.",
    );
  }

  const available = schools.map((school) => school.subdomain).join(', ');
  return notFound(
    `École « ${requested ?? '(aucun sous-domaine)'} » introuvable. Écoles disponibles : ${available}. ` +
      'Ajustez DEFAULT_SCHOOL_SUBDOMAIN côté backend ou VITE_SCHOOL_SUBDOMAIN côté frontend.',
  );
}
