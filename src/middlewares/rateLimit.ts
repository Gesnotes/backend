import rateLimit from 'express-rate-limit';

import { env } from '../lib/env';
import { tooManyRequests } from '../errors/AppError';

const isTest = env.NODE_ENV === 'test';

/**
 * Budget anti-bruteforce, réservé aux routes qui vérifient un secret :
 * /auth/login, /auth/forgot-password et /auth/reset-password.
 *
 * Ne jamais l'appliquer aux routes de session (/refresh, /logout) : un client
 * actif rafraîchit son token toutes les 15 minutes, et plusieurs familles
 * derrière la même IP publique (NAT d'un établissement) épuiseraient le budget
 * sans qu'aucune attaque n'ait lieu.
 */
export const credentialsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  // Désactivé en test pour ne pas rendre la suite dépendante de l'ordre des cas.
  skip: () => isTest,
  handler: (_req, _res, next) => next(tooManyRequests('Trop de tentatives, réessayez plus tard')),
});

/**
 * Limite large sur les routes de session : arrête une boucle emballée sans
 * gêner un usage normal.
 */
export const sessionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isTest,
  handler: (_req, _res, next) => next(tooManyRequests('Trop de requêtes, réessayez plus tard')),
});
