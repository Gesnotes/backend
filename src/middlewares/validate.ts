import type { NextFunction, Request, Response } from 'express';
import type { ZodType } from 'zod';

import { badRequest } from '../errors/AppError';

interface Schemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

/**
 * Validation des entrées par Zod, en middleware.
 *
 * Les valeurs validées remplacent les valeurs brutes : le contrôleur reçoit
 * des données déjà coercées (nombres, dates) et typées.
 */
export function validate(schemas: Schemas) {
  return (req: Request, _res: Response, next: NextFunction) => {
    for (const key of ['body', 'query', 'params'] as const) {
      const schema = schemas[key];
      if (!schema) continue;

      const result = schema.safeParse(req[key]);
      if (!result.success) {
        return next(
          badRequest(
            'Données invalides',
            result.error.issues.map((issue) => ({
              champ: [key, ...issue.path].join('.'),
              message: issue.message,
            })),
          ),
        );
      }

      // req.query et req.params sont en lecture seule sur Express 5.
      // `configurable` est indispensable : sans lui, empiler deux `validate`
      // sur la même requête (routeur + route) lèverait « Cannot redefine
      // property ». `enumerable` garde la propriété visible des logs et de
      // tout code qui itère sur la requête.
      Object.defineProperty(req, key, {
        value: result.data,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    }

    return next();
  };
}
