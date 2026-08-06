import type { NextFunction, Request, Response } from 'express';

import prisma from '../lib/prisma';
import { unauthorized } from '../errors/AppError';
import { verifyStaffAccessToken } from '../lib/jwt';

/**
 * Garde d'authentification de l'équipe Gesnotes.
 *
 * Les routes `/staff` sont montées avant `schoolContext` (aucune école n'est
 * concernée) : ce middleware fait donc, à lui seul, tout ce que
 * `schoolContext` + `requireAuth` font ensemble côté client — vérifier le
 * JWT, relire le compte en base (un JWT longue durée ne peut pas être repris
 * une fois émis), et refuser un compte archivé ou déconnecté depuis.
 */
export async function requireStaffAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw unauthorized();

    const payload = verifyStaffAccessToken(header.slice('Bearer '.length));
    if (!payload) throw unauthorized("Votre session n'est plus valable. Reconnectez-vous.");

    const staff = await prisma.staffUser.findUnique({
      where: { id: payload.staffId },
      select: { id: true, archivedAt: true, sessionsRevokedAt: true },
    });

    if (!staff || staff.archivedAt) throw unauthorized('Votre session a expiré. Reconnectez-vous.');
    if (staff.sessionsRevokedAt && payload.issuedAt < staff.sessionsRevokedAt) {
      throw unauthorized('Votre session a expiré. Reconnectez-vous.');
    }

    req.staffAuth = { staffId: staff.id };
    return next();
  } catch (error) {
    return next(error);
  }
}
