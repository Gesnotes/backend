import { Router } from 'express';
import { z } from 'zod';

import * as staffAuthService from '../services/staff-auth.service';
import * as staffService from '../services/staff.service';
import { requireStaffAuth } from '../middlewares/requireStaffAuth';
import { credentialsLimiter, sessionLimiter } from '../middlewares/rateLimit';
import { publicRoute } from '../middlewares/publicRoute';
import { validate } from '../middlewares/validate';

/**
 * Espace de l'équipe Gesnotes : supervision de la plateforme, traitement des
 * demandes d'inscription. Monté avant `schoolContext` dans `app.ts` — aucune
 * école n'est concernée par ces routes, `requireStaffAuth` fait tout le
 * travail d'authentification à lui seul (voir son commentaire).
 */
export const staffRoutes = Router();

const loginBody = z.object({
  email: z.email('Email invalide'),
  password: z.string().min(1, 'Mot de passe requis'),
});

const refreshBody = z.object({ refreshToken: z.string().min(1) });

staffRoutes.post(
  '/login',
  publicRoute,
  credentialsLimiter,
  validate({ body: loginBody }),
  async (req, res) => {
    const { email, password } = req.body as z.infer<typeof loginBody>;
    res.json(await staffAuthService.login(email, password));
  },
);

staffRoutes.post(
  '/refresh',
  publicRoute,
  sessionLimiter,
  validate({ body: refreshBody }),
  async (req, res) => {
    const { refreshToken } = req.body as z.infer<typeof refreshBody>;
    res.json(await staffAuthService.refresh(refreshToken));
  },
);

staffRoutes.post(
  '/logout',
  publicRoute,
  sessionLimiter,
  validate({ body: refreshBody }),
  async (req, res) => {
    const { refreshToken } = req.body as z.infer<typeof refreshBody>;
    await staffAuthService.logout(refreshToken);
    res.status(204).send();
  },
);

staffRoutes.get('/me', requireStaffAuth, (req, res) => {
  res.json(req.staffAuth);
});

staffRoutes.get('/overview', requireStaffAuth, async (_req, res) => {
  res.json(await staffService.getOverview());
});

staffRoutes.get('/schools', requireStaffAuth, async (_req, res) => {
  res.json(await staffService.listSchoolsWithMetrics());
});

const idParam = z.object({ id: z.coerce.number().int().positive() });

const statusQuery = z.object({
  status: z.enum(['nouveau', 'traite']).optional(),
});

staffRoutes.get(
  '/signup-requests',
  requireStaffAuth,
  validate({ query: statusQuery }),
  async (req, res) => {
    const { status } = req.query as unknown as z.infer<typeof statusQuery>;
    res.json(await staffService.listSignupRequests(status));
  },
);

const acceptBody = z.object({
  subdomain: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]+$/, 'Le sous-domaine ne peut contenir que des lettres minuscules, des chiffres et des tirets.')
    .max(63)
    .optional(),
  schoolName: z.string().trim().min(1).max(150).optional(),
  city: z.string().trim().min(1).max(100).optional(),
});

staffRoutes.post(
  '/signup-requests/:id/accept',
  requireStaffAuth,
  validate({ params: idParam, body: acceptBody }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    const data = req.body as z.infer<typeof acceptBody>;
    res.status(201).json(await staffService.acceptSignupRequest(id, data));
  },
);

staffRoutes.post(
  '/signup-requests/:id/decline',
  requireStaffAuth,
  validate({ params: idParam }),
  async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    await staffService.declineSignupRequest(id);
    res.status(204).send();
  },
);
