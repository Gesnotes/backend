/**
 * Erreur métier portant son propre statut HTTP.
 *
 * Toute erreur attendue passe par ici : le gestionnaire central (errorHandler)
 * sait alors quoi renvoyer. Ce qui n'est pas une AppError est traité comme une
 * erreur inattendue → 500, sans fuite de détail interne au client.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'BAD_REQUEST', message, details);

export const unauthorized = (message = 'Authentification requise') =>
  new AppError(401, 'UNAUTHORIZED', message);

export const forbidden = (message = 'Accès refusé') => new AppError(403, 'FORBIDDEN', message);

export const notFound = (message = 'Ressource introuvable') =>
  new AppError(404, 'NOT_FOUND', message);

export const conflict = (message: string, details?: unknown) =>
  new AppError(409, 'CONFLICT', message, details);

export const tooManyRequests = (message = 'Trop de requêtes') =>
  new AppError(429, 'TOO_MANY_REQUESTS', message);
