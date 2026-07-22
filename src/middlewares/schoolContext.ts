import type { NextFunction, Request, Response } from 'express';

import prisma from '../lib/prisma';
import { env, isProduction } from '../lib/env';
import { forbidden, notFound, unauthorized } from '../errors/AppError';
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
    if (!school) throw notFound('École introuvable pour ce sous-domaine');

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

    req.auth = payload;
    req.schoolId = payload.schoolId;
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

  const fallback =
    (req.headers['x-school-subdomain'] as string | undefined) ?? env.DEFAULT_SCHOOL_SUBDOMAIN;
  if (!fallback) return null;

  return prisma.school.findUnique({ where: { subdomain: fallback } });
}
