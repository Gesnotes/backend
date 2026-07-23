import pino from 'pino';

import { env, isProduction } from './env';

/**
 * Journal applicatif.
 *
 * En développement, la sortie passe par `pino-pretty` : une ligne lisible et
 * colorée par requête, au lieu du mur de JSON brut qu'un `pino` par défaut
 * produit — un objet complet avec tous les en-têtes à chaque appel. En
 * production, on garde le JSON structuré, exploitable par un agrégateur de
 * logs. En test, tout est muet.
 */
const level = env.NODE_ENV === 'test' ? 'silent' : isProduction ? 'info' : 'debug';

const usePretty = !isProduction && env.NODE_ENV !== 'test';

export const logger = pino({
  level,
  // Ne jamais logger de secret, même par accident.
  redact: ['req.headers.authorization', 'req.headers.cookie', '*.passwordHash', '*.tokenHash'],
  ...(usePretty
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss',
            // La journalisation HTTP met déjà l'essentiel dans le message ; on
            // masque les champs techniques pour garder une ligne nette.
            ignore: 'pid,hostname,req,res,responseTime,reqId',
            messageFormat: '{msg}',
          },
        },
      }
    : {}),
});
