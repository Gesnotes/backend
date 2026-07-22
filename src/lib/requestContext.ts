import type { Request } from 'express';

import { unauthorized } from '../errors/AppError';

/**
 * Identifiants de la requête authentifiée.
 *
 * `req.auth` est optionnel côté types (une requête peut légitimement ne pas
 * être authentifiée), mais après `requireAuth` il est toujours là. Ces
 * accesseurs évitent de répandre des `!` ou des `?? 0` dans les contrôleurs,
 * où un `?? 0` silencieux transformerait une erreur de câblage en requête sur
 * l'école n° 0.
 */
export function authOf(req: Request) {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

export function schoolIdOf(req: Request): number {
  return authOf(req).schoolId;
}
