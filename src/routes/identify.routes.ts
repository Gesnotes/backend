import { Router } from 'express';
import { z } from 'zod';

import * as authService from '../services/auth.service';
import { credentialsLimiter } from '../middlewares/rateLimit';
import { publicRoute } from '../middlewares/publicRoute';
import { validate } from '../middlewares/validate';

/**
 * Connexion : seule porte d'entrée, aucune école n'a besoin d'être résolue au
 * préalable (ni sous-domaine, ni en-tête). Montée avant `schoolContext` dans
 * `app.ts` — comme `/onboarding` et `/staff`.
 */
export const identifyRoutes = Router();

const identifyBody = z.object({
  identifier: z.string().min(1, 'Email ou téléphone requis'),
  password: z.string().min(1, 'Mot de passe requis'),
  /** École choisie dans la liste ambiguë renvoyée par un appel précédent. */
  schoolId: z.coerce.number().int().positive().optional(),
});

identifyRoutes.post(
  '/identify',
  publicRoute,
  credentialsLimiter,
  validate({ body: identifyBody }),
  async (req, res) => {
    const { identifier, password, schoolId } = req.body as z.infer<typeof identifyBody>;
    res.json(await authService.identify(identifier, password, schoolId));
  },
);
