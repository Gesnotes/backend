import { Router } from 'express';
import { z } from 'zod';

import * as onboardingService from '../services/onboarding.service';
import { isValidPhone, PHONE_FORMAT_MESSAGE } from '../lib/normalize';
import { publicLimiter } from '../middlewares/rateLimit';
import { publicRoute } from '../middlewares/publicRoute';
import { validate } from '../middlewares/validate';

/**
 * Routes d'avant-inscription : aucune école n'est encore résolue à ce stade,
 * donc montées avant `schoolContext` dans `app.ts` — comme `/health` —
 * plutôt que gardées par lui.
 */
export const onboardingRoutes = Router();

const signupBody = z.object({
  schoolName: z.string().trim().min(1, "Le nom de l'école est obligatoire.").max(150),
  contactName: z.string().trim().min(1, 'Votre nom est obligatoire.').max(150),
  email: z.email("L'adresse email n'est pas valide."),
  phone: z
    .string()
    .trim()
    .min(1, 'Le téléphone est obligatoire.')
    .max(30)
    .refine(isValidPhone, PHONE_FORMAT_MESSAGE),
  city: z.string().trim().min(1, 'La ville est obligatoire.').max(100),
  levels: z
    .array(z.string().trim().min(1).max(30))
    .min(1, 'Choisissez au moins un niveau.')
    .max(10),
});

onboardingRoutes.post(
  '/signup-requests',
  publicRoute,
  publicLimiter,
  validate({ body: signupBody }),
  async (req, res) => {
    const data = req.body as z.infer<typeof signupBody>;
    await onboardingService.createSignupRequest(data);
    res.status(201).json({ message: 'Demande enregistrée. Nous vous rappelons sous 48h.' });
  },
);
