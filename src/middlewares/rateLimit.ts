import rateLimit from 'express-rate-limit';

import { env } from '../lib/env';
import { tooManyRequests } from '../errors/AppError';

const isTest = env.NODE_ENV === 'test';

/**
 * Budget anti-bruteforce, réservé aux routes qui vérifient un secret :
 * /auth/identify, /auth/forgot-password et /auth/reset-password.
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
  handler: (_req, _res, next) => next(tooManyRequests(
      'Trop de tentatives de connexion. Patientez quelques minutes avant de réessayer.',
    )),
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
  handler: (_req, _res, next) => next(tooManyRequests('Vous allez trop vite pour nous. Patientez un instant, puis réessayez.')),
});

/**
 * Routes publiques d'avant-inscription (recherche d'école, demande de
 * rappel) : accessibles sans compte, donc sans le filet qu'apporte un
 * `requireAuth`. Un budget dédié — ni celui du brute-force de connexion, ni
 * la grande marge des routes de session — évite le spam du formulaire comme
 * le raclage de la liste des écoles.
 */
export const publicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isTest,
  handler: (_req, _res, next) => next(tooManyRequests('Trop de requêtes. Patientez quelques minutes avant de réessayer.')),
});
