import * as Sentry from '@sentry/node';

import { env, isProduction } from './env';
import { logger } from './logger';

/**
 * Suivi des erreurs, via le SDK Sentry pointé sur GlitchTip.
 *
 * GlitchTip parle le protocole Sentry : le SDK officiel fonctionne tel quel,
 * seul le DSN change. Rien n'est envoyé tant que `SENTRY_DSN` est vide, ce qui
 * est le cas par défaut — l'application tourne exactement comme avant.
 *
 * ⚠️ Doit être appelé **avant** toute autre importation applicative
 * (cf. `src/index.ts`) : le SDK instrumente les modules au chargement, et
 * initialisé trop tard il rate une partie des erreurs.
 */
export function initMonitoring(): void {
  if (!env.SENTRY_DSN) return;

  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT ?? env.NODE_ENV,
    tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,

    /**
     * Aucune donnée personnelle par défaut.
     *
     * Ce produit manipule des notes d'élèves mineurs : `sendDefaultPii`
     * enverrait adresses IP, en-têtes et corps de requête au serveur de
     * supervision. On garde la trace technique, jamais le contenu.
     */
    sendDefaultPii: false,

    beforeSend(event) {
      // Ceinture et bretelles : même si une intégration future capture le
      // corps de la requête, il ne doit pas partir.
      if (event.request) {
        delete event.request.data;
        delete event.request.cookies;
        delete event.request.headers;
      }
      return event;
    },
  });

  logger.info(
    `Suivi des erreurs actif (${env.SENTRY_ENVIRONMENT ?? env.NODE_ENV})`,
  );
}

/**
 * Signale une erreur inattendue.
 *
 * Les `AppError` 4xx sont volontairement ignorées par l'appelant : un 404 ou
 * un 409 sont des réponses métier normales, les remonter noierait les vraies
 * anomalies sous le bruit.
 */
export function captureException(error: unknown, context?: Record<string, unknown>): void {
  if (!env.SENTRY_DSN) return;
  Sentry.captureException(error, context ? { extra: context } : undefined);
}

/**
 * Attache l'utilisateur courant à l'événement.
 *
 * Identifiant, rôle et école seulement : de quoi reproduire un incident sans
 * transporter le nom ni l'email de qui que ce soit.
 */
export function setUserContext(user: { userId: number; schoolId: number; role: string }): void {
  if (!env.SENTRY_DSN) return;
  Sentry.setUser({ id: String(user.userId) });
  Sentry.setTags({ role: user.role, schoolId: String(user.schoolId) });
}

/** Vide la file avant l'arrêt : sans cela, la dernière erreur est perdue. */
export async function flushMonitoring(timeoutMs = 2000): Promise<void> {
  if (!env.SENTRY_DSN) return;
  try {
    await Sentry.flush(timeoutMs);
  } catch {
    // L'arrêt du serveur ne doit jamais échouer à cause de la supervision.
  }
}

/** Exposé pour les cas rares où l'API complète est nécessaire. */
export { Sentry };

/** Vrai si le suivi est configuré — utile pour la sonde de santé. */
export const isMonitoringEnabled = (): boolean => Boolean(env.SENTRY_DSN);

/** Rappel : en production, un DSN manquant est probablement un oubli. */
if (isProduction && !env.SENTRY_DSN) {
  logger.warn('SENTRY_DSN absent : les erreurs de production ne seront pas remontées');
}
