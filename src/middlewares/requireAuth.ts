import type { NextFunction, Request, Response } from 'express';

import { unauthorized } from '../errors/AppError';

/**
 * Garde d'authentification.
 *
 * `schoolContext` laisse volontairement passer les requêtes sans token ; c'est
 * ce middleware-ci qui refuse l'accès. Toute route métier doit le monter,
 * sinon elle est publique.
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.auth) return next(unauthorized());
  return next();
}
