import type { IncomingMessage, ServerResponse } from 'node:http';
import pinoHttp from 'pino-http';

import { logger } from './logger';

/**
 * Journalisation HTTP concise.
 *
 * `pino-http` par défaut sérialise la requête et la réponse entières — tous
 * les en-têtes, à chaque appel, y compris les `304 Not Modified`. En
 * développement, une navigation banale noyait la console sous des centaines de
 * lignes de JSON.
 *
 * Ici, une requête = une ligne : « GET /admin/dashboard → 200 (34 ms) ».
 * Le niveau suit le statut (5xx en erreur, 4xx en avertissement), les sondes
 * de santé et les `304` sont tus, et aucun en-tête n'est déversé — seule
 * l'authentification et les secrets étaient déjà expurgés, mais le plus sûr
 * reste de ne rien logger d'inutile.
 */
export const httpLogger = pinoHttp({
  logger,

  // Message court, avec la durée. `responseTime` est fourni par pino-http.
  customSuccessMessage: (req, res, responseTime) =>
    `${req.method} ${cleanUrl(req)} → ${res.statusCode} (${Math.round(responseTime)} ms)`,
  customErrorMessage: (req, res, err) =>
    `${req.method} ${cleanUrl(req)} → ${res.statusCode} — ${err.message}`,

  customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    // Une réponse depuis le cache du navigateur n'apprend rien : on la tait.
    if (res.statusCode === 304) return 'silent';
    return 'info';
  },

  // Serializers réduits : plus de déversement d'en-têtes. Les champs restent
  // présents dans le JSON de production, mais compacts.
  serializers: {
    req: (req: IncomingMessage & { url?: string; method?: string }) => ({
      method: req.method,
      url: req.url,
    }),
    res: (res: ServerResponse) => ({ statusCode: res.statusCode }),
  },

  autoLogging: {
    // Les sondes de santé sont appelées en boucle par les orchestrateurs :
    // les journaliser n'a aucune valeur et masque le reste.
    ignore: (req) => req.url === '/health' || req.url === '/',
  },
});

/**
 * Chemin journalisé, sans la query string.
 *
 * `originalUrl` d'abord : Express retire le préfixe de montage de `req.url`
 * pendant le routage (`/auth/login` devient `/login` dans le sous-routeur), et
 * la journalisation se faisant à la fin de la requête, `req.url` peut déjà être
 * tronqué. `originalUrl` n'est jamais muté.
 */
function cleanUrl(req: IncomingMessage & { url?: string; originalUrl?: string }): string {
  return (req.originalUrl ?? req.url ?? '').split('?')[0] || '/';
}
