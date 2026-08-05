import type { NextFunction, Request, Response } from 'express';

import { AppError, notFound } from '../errors/AppError';
import { isProduction } from '../lib/env';
import { logger } from '../lib/logger';
import { captureException } from '../lib/monitoring';

/** Route inconnue → 404 au même format que les autres erreurs. */
export function notFoundHandler(_req: Request, _res: Response, next: NextFunction) {
  next(notFound('Route inconnue'));
}

/**
 * Gestionnaire d'erreurs central. Format de réponse unique :
 *   { error: { code, message, details? } }
 *
 * Les codes Prisma connus sont traduits en statuts HTTP ; tout le reste est un
 * 500 dont le détail reste dans les logs et ne fuit jamais au client.
 */
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction) {
  const mapped = mapError(err);

  if (mapped.status >= 500) {
    logger.error({ err }, 'Erreur non gérée');

    /**
     * Seules les erreurs 5xx partent vers la supervision.
     *
     * Un 404, un 409 ou un 401 sont des réponses métier normales — un élève
     * introuvable, un doublon refusé, un mot de passe erroné. Les remonter
     * noierait les vraies anomalies sous des milliers d'événements attendus.
     */
    captureException(err, {
      method: req.method,
      // `originalUrl` sans la query string : elle peut porter des filtres,
      // jamais de secret, mais autant rester sobre.
      path: (req.originalUrl ?? req.url).split('?')[0],
      role: req.auth?.role,
      schoolId: req.auth?.schoolId,
    });
  }

  // La réponse a déjà commencé (export PDF en flux, double envoi) : réécrire
  // les en-têtes lèverait ERR_HTTP_HEADERS_SENT depuis le gestionnaire
  // d'erreurs lui-même. On délègue à Express, qui coupe la connexion.
  if (res.headersSent) return next(err);

  res.status(mapped.status).json({
    error: {
      code: mapped.code,
      message: mapped.message,
      ...(mapped.details !== undefined ? { details: mapped.details } : {}),
    },
  });
}

function mapError(err: unknown): {
  status: number;
  code: string;
  message: string;
  details?: unknown;
} {
  if (err instanceof AppError) {
    return { status: err.status, code: err.code, message: err.message, details: err.details };
  }

  const code = (err as { code?: unknown })?.code;

  if (code === 'P2002') {
    return { status: 409, code: 'CONFLICT', message: 'Cette ressource existe déjà' };
  }
  if (code === 'P2025') {
    return { status: 404, code: 'NOT_FOUND', message: 'Ressource introuvable' };
  }
  if (code === 'P2003') {
    return { status: 409, code: 'CONFLICT', message: 'Référence invalide vers une autre ressource' };
  }

  /**
   * Violation de clé étrangère remontée brute par l'adaptateur Postgres.
   *
   * Prisma ne la traduit pas toujours en P2003 : une contrainte `RESTRICT`
   * déclenchée par un `DELETE` arrive en P2039 avec le code SQLSTATE enfoui
   * dans `driverAdapterError`. Sans ce filet, le client reçoit « Erreur
   * interne » là où le refus est parfaitement métier. Les services doivent
   * quand même contrôler en amont pour donner un message précis : on ne sait
   * pas ici *quelle* ressource référence l'objet.
   */
  if (isForeignKeyViolation(err)) {
    return {
      status: 409,
      code: 'CONFLICT',
      message: "Suppression impossible : d'autres données référencent cette ressource",
    };
  }

  return {
    status: 500,
    code: 'INTERNAL_ERROR',
    message: 'Erreur interne',
    // Le détail n'est exposé qu'en dehors de la production.
    details: isProduction ? undefined : (err as Error)?.message,
  };
}

/**
 * SQLSTATE 23503 (foreign_key_violation) et 23001 (restrict_violation), tels
 * que l'adaptateur les expose : `meta.driverAdapterError.cause.code`.
 */
function isForeignKeyViolation(err: unknown): boolean {
  const cause = (
    err as { meta?: { driverAdapterError?: { cause?: { code?: unknown } } } }
  )?.meta?.driverAdapterError?.cause?.code;

  return cause === '23503' || cause === '23001';
}
