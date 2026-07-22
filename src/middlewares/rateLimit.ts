import rateLimit from 'express-rate-limit';

import { env } from '../lib/env';
import { tooManyRequests } from '../errors/AppError';

/**
 * Limite les tentatives sur /auth/* : login et forgot-password sont les deux
 * portes ouvertes au bruteforce et à l'énumération de comptes.
 * Désactivé en test pour ne pas rendre la suite dépendante de l'ordre des cas.
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env.NODE_ENV === 'test' ? 0 : 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => env.NODE_ENV === 'test',
  handler: (_req, _res, next) => next(tooManyRequests('Trop de tentatives, réessayez plus tard')),
});
