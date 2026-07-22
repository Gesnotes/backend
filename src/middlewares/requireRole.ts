import type { NextFunction, Request, Response } from 'express';

import type { Role } from '../generated/prisma/enums';
import { forbidden, unauthorized } from '../errors/AppError';

/** Restreint une route à un ou plusieurs rôles. À monter après `requireAuth`. */
export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) return next(unauthorized());
    if (!roles.includes(req.auth.role)) return next(forbidden('Rôle insuffisant'));
    return next();
  };
}
