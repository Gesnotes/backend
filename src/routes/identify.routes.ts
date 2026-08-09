import { Router } from 'express';
import { z } from 'zod';

import * as authService from '../services/auth.service';
import { credentialsLimiter } from '../middlewares/rateLimit';
import { publicRoute } from '../middlewares/publicRoute';
import { validate } from '../middlewares/validate';

/**
 * Connexion sans sous-domaine connu (plan §1.2 ter) : aucune école n'est
 * encore résolue à ce stade, donc montée avant `schoolContext` dans
 * `app.ts` — comme `/onboarding` et `/staff`. `authRoutes` (après
 * `schoolContext`) reste inchangé pour les visites sur un vrai sous-domaine.
 */
export const identifyRoutes = Router();

const identifyBody = z.object({
  identifier: z.string().min(1, 'Email ou téléphone requis'),
  password: z.string().min(1, 'Mot de passe requis'),
});

identifyRoutes.post(
  '/identify',
  publicRoute,
  credentialsLimiter,
  validate({ body: identifyBody }),
  async (req, res) => {
    const { identifier, password } = req.body as z.infer<typeof identifyBody>;
    res.json(await authService.identify(identifier, password));
  },
);
