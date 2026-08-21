import rateLimit from 'express-rate-limit';

import { env } from '../lib/env';
import { tooManyRequests } from '../errors/AppError';

const isTest = env.NODE_ENV === 'test';

/**
 * Fabrique un budget anti-bruteforce indépendant à chaque appel — jamais une
 * instance unique partagée entre plusieurs mondes d'authentification.
 * `credentialsLimiter` et `staffCredentialsLimiter` comptent chacun sur leur
 * propre compteur : sans ça, bombarder /auth/identify depuis une IP donnée
 * épuisait aussi le budget de /staff/login pour cette même IP, alors que ce
 * sont deux systèmes de comptes délibérément isolés (voir
 * `requireStaffAuth`) — une IP qui martèle la connexion école ne doit jamais
 * pouvoir, même par effet de bord, verrouiller l'équipe Gesnotes hors de son
 * propre tableau de bord.
 */
function makeCredentialsLimiter() {
  return rateLimit({
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
}

/** /auth/identify, /auth/forgot-password, /auth/reset-password — comptes école. */
export const credentialsLimiter = makeCredentialsLimiter();

/** /staff/login, /staff/forgot-password, /staff/reset-password — équipe Gesnotes. */
export const staffCredentialsLimiter = makeCredentialsLimiter();

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
