import type { NextFunction, Request, Response } from 'express';

import type { Role } from '../generated/prisma/enums';
import { forbidden, unauthorized } from '../errors/AppError';

export const ALL_ROLES: Role[] = ['admin', 'teacher', 'parent'];

/**
 * Restreint une route à un ou plusieurs rôles. À monter après `requireAuth`.
 *
 * **Toute route authentifiée doit en porter un, lecture comprise.** Le motif
 * « `router.use(requireAuth)` puis `requireRole` sur les seules écritures » a
 * ouvert trois fuites de données dans ce projet : les routes de consultation
 * héritaient d'une authentification sans jamais déclarer qui avait le droit de
 * lire. `tests/route-guards.test.ts` parcourt la table de routage et échoue si
 * une route oublie ce garde.
 *
 * La fonction retournée est nommée `roleGuard` précisément pour que ce test
 * puisse la reconnaître dans la pile Express.
 */
export function requireRole(...roles: Role[]) {
  return function roleGuard(req: Request, _res: Response, next: NextFunction) {
    if (!req.auth) return next(unauthorized());
    if (!roles.includes(req.auth.role)) return next(forbidden("Vous n'avez pas accès à cette partie de Gesnotes."));
    return next();
  };
}
